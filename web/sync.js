const PING_INTERVAL_MS = 2000;
const PING_BURST_COUNT = 5;
const PING_BURST_INTERVAL_MS = 100;
const DRIFT_CHECK_MS = 500;       // 漂移检查周期（伺服模式需要更频繁的小步修正；DOM 开销 2Hz 可忽略）
const DRIFT_DEADBAND_MS = 50;     // v4 hotfix: 30→50。iOS Safari 蓝牙/AirPods 输出延迟 + NTP 偏差叠加让 drift 常 >30ms
const RATE_SERVO_ENABLED = true;  // 微速率伺服开关。若现场再出现爆音疑虑，置 false 回退纯 seek 模式
const RATE_SERVO_MAX = 0.025;     // v4.1: 0.04→0.025 (±2.5%, ~43 音分)。4% 在 iOS Safari 每次 playbackRate 赋值产生微卡顿；2.5% 平衡收敛速度与平滑度
const RATE_SERVO_HORIZON_S = 4;   // target 4s 内消化漂移
const RATE_HYSTERESIS = 0.003;    // v4.1: rate 变化 < 0.3% 不赋值，避免 iOS 重采样器因 1.013→1.014 频繁切换产生微断口
const DRIFT_EMA_ALPHA = 0.3;      // v4.1: drift EMA 平滑因子。α=0.3 约 3-4 个 sample（1.5-2s）收敛，滤除网络抖动噪声
const SEEK_THRESHOLD_MS = 500;    // 硬 seek 阈值：只有大错位（网络卡死恢复/标签页冻结唤醒）才 seek——seek 必产生可闻断口
const PLAY_GRACE_MS = 5000;       // v4.1: play 后 5s 内不硬 seek——音频加载期间 sync tick 已推进，初始 drift 可达 300-600ms，让 servo 消化而非 seek
const SEEK_COOLDOWN_MS = 2000;    // seek 后冷却上限（seeked 事件会把冷却提前到完成后 300ms，这里是兜底）
const MAX_DRIFT_SEEKS = 10;       // 同曲漂移 seek 上限：超此值 clock offset 或 currentTime 严重异常，停 seek 等下一首
const MIN_BUFFER_FOR_SEEK_MS = 1000; // v4 (Phase D): 800→1000。tick 模型让 drift 更小，seek 前需要更稳的缓冲
const MAX_ERROR_RETRIES = 3;      // audio.onerror 连续失败 N 次后回滚 isPlaying（避免 silent stuck）
const MAX_RECONNECT_BACKOFF_MS = 30000; // WS 重连退避上限（1.5s → 3s → 6s → 12s → 24s → 30s 封顶）
const HEARTBEAT_GRACE_MS = 12000; // 服务端应用层心跳最大间隔：超此值视作服务端异常，触发主动重连

// iOS Safari 探测：iOS 不允许 audio autoplay、要求 user gesture、后台/锁屏会强制 pause、
// 视频元素必须 playsInline。iOS 14+ 的 webkitAudioContext 解锁也依赖 user gesture。
// 这些差异需要在 connect() 里特殊处理。
const IS_IOS = typeof navigator !== "undefined"
  && (/iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

// Monotonic epoch：performance.now() 自 page load 起单调递增、亚毫秒精度，
// 加上 timeOrigin 等价 Date.now() 的 epoch 基准。优点：系统时间被外部修改
// （NTP 校时、夏令时、手动调整）时不会污染 offset 估算。
const _now = () => performance.timeOrigin + performance.now();

// 调试日志开关：window.__juguang_debug = true 或 URL ?debug=1
const _debug = () => {
  if (typeof window === "undefined") return false;
  if (window.__juguang_debug) return true;
  try { return new URLSearchParams(location.search).get("debug") === "1"; } catch { return false; }
};
const _log = (...args) => { if (_debug()) console.debug("[sync]", ...args); };

export class SyncClient {
  constructor(deviceName, kind = "web", zoneId = 1) {
    this.deviceName = deviceName;
    this.kind = kind;
    this.zoneId = Number(zoneId) || 1;
    this.deviceId = localStorage.getItem("juguang.deviceId");
    this.ws = null;
    this.ctx = null;
    this.gain = null;
    // 流式播放：复用一个 HTMLAudioElement，接进 Web Audio graph
    // （createMediaElementSource 每个 audio 元素只能调一次，故元素与节点一一复用）
    this.audio = null;
    this.mediaNode = null;
    this.currentTrackId = null;
    this.currentTrackUrl = null;
    this.currentDurationMs = 0;
    // v4 (Phase E): 删除 startServerTime 字段 — v4 drift 公式不再依赖它
    this.trackOffsetMs = 0;
    this.isPlaying = false;
    this.playTimer = null;    // 定时起播（对齐服务端 startServerTime）— 短间隔轮询, 非 setTimeout
    this.pauseTimer = null;   // 定时暂停（对齐服务端 atServerTime）
    this._gen = 0;            // 起播代次：快速切歌时让旧 loadedmetadata 回调自废
    this._seekCooldownUntil = 0; // 强制 seek 后短暂屏蔽 drift，避免 seek 风暴
    this._srcSetAt = 0;       // audio.src 设值的时刻（用于算 loadedmetadata 耗时，给 A7 上报）
    this._lastLoadedMs = 0;   // 最近一次首屏 metadata 加载耗时
    this.clockSamples = [];
    this.listeners = new Set();
    this.pingTimer = null;
    this.pingBurstTimer = null;
    this.driftTimer = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null; // 应用层心跳超时 watcher：pong 间隔超 HEARTBEAT_GRACE_MS 主动重连
    this._lastPongAt = 0;       // 最近一次收到 pong 的 monotonic 时间戳
    this._reconnectAttempt = 0; // WS 重连退避计数（每次 onclose 自增）
    this._driftSeeksThisTrack = 0; // 当前曲目漂移 seek 计数（同曲超 MAX_DRIFT_SEEKS 停 seek）
    this._posAnchorRaw = -1;    // 插值位置时钟锚点：currentTime 最近一次"变化"的值
    this._posAnchorAt = 0;      //   及其 monotonic 时刻。Safari currentTime 每 ~250ms 才步进，
    //   锚点 + 外推可把位置精度从 ±125ms 提到 ~5-10ms（视频播放器字幕同步的标准手法）
    this._seekStartedAt = 0;    // seeking→seeked 计时：测 seek 耗时 + 区分 seek 型 waiting
    this._stallStartAt = 0;     // waiting→playing 计时：真缓冲卡顿（网络 starve）
    // v4: sync tick 接收状态（仅诊断，Phase C 才用于 drift 公式）
    this.lastSyncReceivedAt = null;   // monotonic _now() 时刻
    this.lastSyncPositionMs = 0;       // 最近一次 server tick 的 positionMs
    this.lastSyncServerNow = 0;       // 最近一次 server tick 的 serverNow
    this._syncTickCount = 0;          // 累计收到的 tick 数
    this._syncIsPlaying = false;      // 最近一次 tick 的 isPlaying（暂停时 _expectedPositionSec 不外推）
    this._ticksDropped = 0;           // 距上一个 tick > 3 × lastIntervalMs 的次数
    this._lastSyncIntervalMs = 0;     // 最近一次 tick 间隔
    // v4 (Phase C): drift 公式开关（escape hatch via localStorage "juguang.useSyncTicks" = "0"）
    this.useSyncTicks = localStorage.getItem("juguang.useSyncTicks") !== "0";
    this._smoothDriftMs = 0;           // v4.1: drift EMA 平滑值，防止噪声触发 rate 振荡
    this._playGraceUntil = 0;         // v4.1: play 后 grace 期间不硬 seek（音频加载延迟 300-600ms 会导致初始大 drift）
    this._softDriftMode = false;      // tab 切回前台 2s 内：SEEK_THRESHOLD ×3 软收敛
    // 两层音量：master 来自服务端下发（admin 调的），local 是用户本机拉杆（0-1 倍率）
    this.masterVolume = 1;
    this.localVolume = 1;
    this.status = {
      deviceId: null, connected: false, clockOffsetMs: 0, rttMs: 0,
      trackTitle: null, positionMs: 0, durationMs: 0,
      isPlaying: false, driftMs: 0, volume: 1, localVolume: 1,
      zoneId: this.zoneId, zoneName: null,
      bufferAheadMs: 0,  // 预缓冲前瞻秒数，0 表示已耗尽
      seekCount: 0,      // 漂移 seek 累计次数（调试用）
      stallCount: 0,     // 缓冲耗尽卡顿次数（waiting 事件，不含 seek 引发的）
      lastStallMs: 0,    // 最近一次卡顿时长
      playbackRate: 1,   // 当前伺服速率（1=正常；0.985-1.015 之间微调）
      audioContextState: "closed",  // AudioContext.state：closed/suspended/running
      mediaErrorCode: 0,  // audio.error?.code：0=OK, 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
      needsUserGesture: false,  // iOS: autoplay 被拒需用户点一下恢复
      isIos: IS_IOS,     // 用于调试 UI 差异化提示
      // v4: sync tick 诊断字段（Phase B 写入，Phase C 用于 drift 公式）
      syncTicksReceived: 0,
      lastSyncIntervalMs: 0,
      ticksDropped: 0,
    };
  }

  _applyVolume() {
    if (!this.gain) return;
    const target = this.masterVolume * this.localVolume;
    // 平滑过渡 100ms：避免 gain.value 直接阶跃造成的"咔"声（蓝牙/外置 DAC 尤甚）
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(target, t + 0.1);
  }

  on(fn) { this.listeners.add(fn); fn(this.status); return () => this.listeners.delete(fn); }
  _update(p) { this.status = { ...this.status, ...p }; for (const f of this.listeners) f(this.status); }

  async connect() {
    if (!this.ctx) {
      // iOS 14+ 必须用 webkitAudioContext，且 AudioContext 必须在首次 user gesture 内 resume
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.ctx.destination);
      // 跟踪 AudioContext 状态变化：iOS 进入后台后会自动 suspend，UI 上要提示
      this._update({ audioContextState: this.ctx.state });
      this.ctx.onstatechange = () => this._update({ audioContextState: this.ctx.state });
    }
    // 流式播放元素 + 接入 Web Audio：音量走 gain，时钟基准仍是 ctx.currentTime
    if (!this.audio) {
      this.audio = new Audio();
      // iOS Safari: playsInline 防止切到全屏
      this.audio.setAttribute("playsinline", "");
      this.audio.setAttribute("webkit-playsinline", "");
      // preload="metadata" 只下载头部元数据，靠 Range 按需拉数据流式播放
      // （不用 "auto"——iOS 上 auto 可能预下载整文件，破坏 300MB 白噪音不 OOM 的设计目标）
      this.audio.preload = "metadata";
      // 保 pitch 模式：preservesPitch 默认 true，浏览器内置时间拉伸。
      // ±2.5% 微调范围现代浏览器（Chrome 90+ / Safari 15+）算法足够透明，
      // 原 v1 遇到的 WSOLA 伪影是针对大范围变速（0.95x），当前伺服仅 ±2.5% 可忽略。
      // 纯重采样方案（preservesPitch=false）虽无时间拉伸伪影，但人声跑调无法接受。
      // 同源部署不需要 crossOrigin；设了反而要求服务端 CORS 头，跨域缺失会被静音
      this.mediaNode = this.ctx.createMediaElementSource(this.audio);
      this.mediaNode.connect(this.gain);
      // 自然播完：等服务端 scheduleAdvance 下发 next/loop-one 重播，不主动改状态避免竞争
      this.audio.onended = () => {};
      // 加载/解码失败自动恢复：网络断开一瞬或文件 404 时不要让 UI 卡在"播放中"实际没声
      // 3 次失败后回滚 isPlaying=false，让 UI 显示真实状态（避免 silent stuck）
      this._errorRetries = 0;
      this.audio.onerror = () => {
        const code = this.audio.error?.code ?? 0;
        this._update({ mediaErrorCode: code });
        _log("audio error code:", code, "(1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED)");
        if (!this.currentTrackUrl) return;
        // iOS 错码 4 (SRC_NOT_SUPPORTED) 是 MIME / Range 不兼容，硬重试无意义
        if (code === 4) {
          _log("src not supported, will not retry");
          this._rollbackPlayState();
          return;
        }
        // 错码 1 (ABORTED) 通常是主动切歌触发的 src 重设,不应重试
        if (code === 1) {
          _log("aborted, skipping retry");
          return;
        }
        const trackId = this.currentTrackId;
        const offsetSec = this.trackOffsetMs / 1000;
        const url = this.currentTrackUrl;
        const attempt = ++this._errorRetries;
        if (attempt > MAX_ERROR_RETRIES) {
          _log(`max retries (${MAX_ERROR_RETRIES}) exceeded, rolling back isPlaying`);
          this._rollbackPlayState();
          return;
        }
        setTimeout(() => {
          // 期间已切歌则放弃，避免覆盖新的 play
          if (this.currentTrackId !== trackId) return;
          try {
            this.audio.src = url;
            this.audio.load();
            this.audio.currentTime = offsetSec;
            if (this.isPlaying) this.audio.play().catch((e) => {
              // iOS autoplay policy: play() 被拒需要用户交互
              this._update({ needsUserGesture: true });
              _log(`play() rejected on retry ${attempt}:`, e?.message);
            });
          } catch (e) {
            console.warn(`[sync] retry ${attempt} failed:`, e?.message);
          }
        }, 1000);
      };
      // 事件驱动的卡顿诊断（hls.js/Shaka 的状态机手法）：
      // waiting = 缓冲耗尽真停住（网络 starve）；playing = 恢复。
      // seek 引发的 waiting 不算网络卡顿（用 _seekStartedAt 区分）。
      this.audio.addEventListener("waiting", () => {
        if (!this.isPlaying || this._seekStartedAt) return;
        this._stallStartAt = _now();
        this._update({ stallCount: (this.status.stallCount ?? 0) + 1 });
      });
      this.audio.addEventListener("playing", () => {
        if (this._stallStartAt) {
          this._update({ lastStallMs: Math.round(_now() - this._stallStartAt) });
          this._stallStartAt = 0;
        }
        // 恢复播放 = 位置锚点重建（插值时钟从这里重新外推）
        this._posAnchorRaw = this.audio.currentTime;
        this._posAnchorAt = _now();
      });
      // seek 生命周期：测耗时；seeked 后提前结束漂移冷却（不等满 2s 兜底）
      this.audio.addEventListener("seeking", () => { this._seekStartedAt = _now(); });
      this.audio.addEventListener("seeked", () => {
        if (this._seekStartedAt) {
          _log(`seeked in ${Math.round(_now() - this._seekStartedAt)}ms`);
          this._seekStartedAt = 0;
        }
        this._posAnchorRaw = this.audio.currentTime;
        this._posAnchorAt = _now();
        this._seekCooldownUntil = Math.min(this._seekCooldownUntil, _now() + 300);
      });
    }
    // iOS 关键：必须先 resume() AudioContext 才能让声音从扬声器出来。
    // iOS 14+ 即使是 createMediaElementSource 后 resume() 也可能因为不在 user gesture 内被拒。
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch (e) { _log("ctx.resume() failed:", e?.message); }
    }
    this._update({ audioContextState: this.ctx.state });
    // 任意用户手势（点击/触摸/按键）尝试解锁 AudioContext。
    // connect() 可能在 user gesture 之外被调用（比如 onload 自动重连），所以单独挂监听，
    // 第一次手势到来时 resume()。桌面浏览器对未 suspend 的 ctx 是 no-op，无副作用。
    this._installUnlock();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    // 关键：onclose / onerror / 心跳 watcher 都必须 capture 本次 ws 实例（闭包），
    // 不能用 this.ws。否则旧 ws 的迟到事件（服务端 hub.attach 用 close(4000) 踢旧连接时
    // 可能触发）会关闭刚连上的新 ws，造成 1.5→30s 重连风暴。
    ws.onopen = () => {
      this._update({ connected: true });
      ws.send(JSON.stringify({
        type: "register",
        deviceId: this.deviceId ?? undefined,
        name: this.deviceName,
        kind: this.kind,
        zoneId: this.zoneId,
        supportsSyncTicks: true,  // v4: 声明支持 sync tick，server 会每 ~200ms 广播 type:"sync"
      }));
      this._startPing();
      this._startDrift();
      this._startHeartbeatWatch();
      this._reconnectAttempt = 0; // 重连成功后重置退避计数
    };
    ws.onmessage = (ev) => this._handle(JSON.parse(ev.data));
    ws.onclose = () => {
      // 已安排重连？忽略——避免多个 close 事件叠加触发多次 connect
      if (this.reconnectTimer) return;
      this._update({ connected: false });
      this._stopLoops();
      // 退避重连：1.5s → 3s → 6s → 12s → 24s → 30s 封顶
      // 服务端持续不可达时不会无限打满 socket + CPU
      const delay = Math.min(MAX_RECONNECT_BACKOFF_MS, 1500 * 2 ** Math.min(this._reconnectAttempt, 4));
      this._reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch {} }; // 闭包 ws，不用 this.ws

    // v4 (Phase C): tab 切回前台 2s 内启用软 SEEK_THRESHOLD（×3），让后台累积的 drift
    // 通过速率伺服软收敛而非一次性硬 seek。setTimeout 2s 后自动恢复硬阈值。
    // 存 handler 引用，connect() 再次调用时先 remove 旧的，避免重连累积泄漏
    if (this._visHandler) document.removeEventListener("visibilitychange", this._visHandler);
    this._visHandler = () => {
      if (document.visibilityState === "visible") {
        this._softDriftMode = true;
        if (this._softDriftTimer) clearTimeout(this._softDriftTimer);
        this._softDriftTimer = setTimeout(() => {
          this._softDriftMode = false;
          this._softDriftTimer = null;
        }, 2000);
      }
    };
    document.addEventListener("visibilitychange", this._visHandler);
  }

  // iOS: 监听任意用户手势（点击/触摸/按键）来解锁 AudioContext 和 autoplay
  // 监听只挂一次，且 unlock 内部判断"是否真的需要"——避免桌面端每次 click 都触发 _update + DOM 写入
  _installUnlock() {
    if (this._unlockInstalled) return;
    this._unlockInstalled = true;
    const unlock = () => {
      // 没被阻塞就什么都不做（不需要 update，省 DOM 写入）
      if (this.ctx?.state !== "suspended" && !this.status.needsUserGesture) return;
      if (this.ctx?.state === "suspended") {
        this.ctx.resume().then(() => {
          this._update({ audioContextState: this.ctx.state, needsUserGesture: false });
          _log("AudioContext unlocked by user gesture");
        }).catch(() => {});
      } else {
        this._update({ needsUserGesture: false });
      }
    };
    ["click", "touchstart", "keydown"].forEach((ev) => {
      document.addEventListener(ev, unlock, { once: false, passive: true });
    });
  }

  _startPing() {
    this._stopPing();
    // 快速 NTP 收敛：开头连发 PING_BURST_COUNT 次
    let n = 0;
    const burst = () => {
      if (n >= PING_BURST_COUNT) {
        this.pingBurstTimer = null;
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", t0: _now() }));
        n++;
        this.pingBurstTimer = setTimeout(burst, PING_BURST_INTERVAL_MS);
      } else {
        this.pingBurstTimer = null;
      }
    };
    burst();
    // 然后 2s 一次正常轮询
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", t0: _now() }));
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pingBurstTimer) { clearTimeout(this.pingBurstTimer); this.pingBurstTimer = null; }
  }
  _startDrift() { this._stopDrift(); this.driftTimer = setInterval(() => this._drift(), DRIFT_CHECK_MS); }
  _stopDrift() { if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = null; } }

  // 应用层心跳超时 watcher：服务端 hang 但 ws 不主动断（半开连接）时主动 close 触发重连
  // 浏览器没法从应用层看到协议层 ping/pong，只能监控应用层 {type:"ping"} → {type:"pong"} 间隔
  _startHeartbeatWatch() {
    this._stopHeartbeatWatch();
    this._lastPongAt = _now();
    const ws = this.ws; // capture：闭包里只关这次 ws，不关后续重连的 ws
    this.heartbeatTimer = setInterval(() => {
      if (this._lastPongAt && _now() - this._lastPongAt > HEARTBEAT_GRACE_MS) {
        _log(`heartbeat timeout (${Math.round(_now() - this._lastPongAt)}ms), forcing reconnect`);
        try { ws?.close(); } catch {} // 触发 onclose → 走退避重连
      }
    }, HEARTBEAT_GRACE_MS / 2);
  }
  _stopHeartbeatWatch() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  _stopLoops() {
    this._stopPing(); this._stopDrift(); this._stopHeartbeatWatch();
    if (this._softDriftTimer) { clearTimeout(this._softDriftTimer); this._softDriftTimer = null; }
    this._softDriftMode = false;
    // disconnect 时清理 visibility 监听，避免重连累积（_visHandler 在 connect() 中重挂）
    if (this._visHandler) { document.removeEventListener("visibilitychange", this._visHandler); this._visHandler = null; }
    // v4 gap sweep fix: disconnect 时重置 tick 状态 + NTP 缓冲，防重连后状态污染
    this.lastSyncReceivedAt = null;
    this._syncTickCount = 0;
    this._lastSyncIntervalMs = 0;
    this._syncIsPlaying = false;
    this.clockSamples = [];
    this.isPlaying = false;
  }

  _clockOffset() {
    if (!this.clockSamples.length) return 0;
    const sorted = [...this.clockSamples].sort((a, b) => a.rtt - b.rtt);
    const head = sorted.slice(0, Math.min(3, sorted.length));
    const offsets = head.map((s) => s.offset).sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)] ?? 0;
  }
  _serverNow() { return _now() + this._clockOffset(); }

  _handle(msg) {
    switch (msg.type) {
      case "sync": {
        // v4: 接收 server tick，仅存状态不用于 drift（Phase C 才切换公式）
        // 首 tick jitter 大，故不立刻用；_syncTickCount >= 2 之后才视为有效
        const now = _now();
        const interval = this.lastSyncReceivedAt != null
          ? Math.round(now - this.lastSyncReceivedAt) : 0;
        // tick drop 检测：间隔 > 3 × 上一次 interval（或 600ms）
        if (this._lastSyncIntervalMs > 0 && interval > Math.max(this._lastSyncIntervalMs * 3, 600)) {
          this._ticksDropped++;
        }
        this.lastSyncReceivedAt = now;
        this.lastSyncPositionMs = Number(msg.positionMs ?? 0);
        this.lastSyncServerNow = Number(msg.serverNow ?? 0);
        this._syncIsPlaying = !!msg.isPlaying;  // 用于 _expectedPositionSec 判断暂停时不外推
        if (interval > 0) this._lastSyncIntervalMs = interval;
        this._syncTickCount++;
        this._update({
          syncTicksReceived: this._syncTickCount,
          lastSyncIntervalMs: this._lastSyncIntervalMs,
          ticksDropped: this._ticksDropped,
        });
        return;
      }
      case "pong": {
        const t2 = _now();
        const rtt = t2 - msg.t0;
        const offset = (msg.t1 - msg.t0 + (msg.t1 - t2)) / 2;
        this.clockSamples.push({ offset, rtt });
        if (this.clockSamples.length > 10) this.clockSamples.shift();
        const minRtt = Math.min(...this.clockSamples.map((s) => s.rtt));
        this._lastPongAt = _now(); // 心跳 watcher 用：刷新"最近一次活跃"时间戳
        this._update({ clockOffsetMs: Math.round(this._clockOffset()), rttMs: Math.round(minRtt) });
        return;
      }
      case "hello":
        this.deviceId = msg.deviceId;
        if (msg.zoneId) {
          this.zoneId = msg.zoneId;
        }
        localStorage.setItem("juguang.deviceId", msg.deviceId);
        // 走 _update 统一通知 listener；不要直接 this.status.zoneId = ... 否则下游不刷新
        this._update({ deviceId: msg.deviceId, zoneId: this.zoneId, ip: msg.ip || "" });
        return;
      case "play":
      case "seek":
        // v4 (Phase E): play 消息移除 startServerTime 字段，_startTrack 不再需要这个参数
        this._startTrack(msg.trackId, msg.trackUrl, msg.durationMs, msg.trackOffsetMs);
        return;
      case "pause": {
        const atLocal = msg.atServerTime - this._clockOffset();
        const delay = Math.max(0, atLocal - _now());
        if (this.pauseTimer) clearTimeout(this.pauseTimer);
        this.pauseTimer = setTimeout(() => {
          try { this.audio?.pause(); } catch {}
          this.isPlaying = false;
          this._update({ isPlaying: false });
        }, delay);
        return;
      }
      case "stop":
        this._stopAudio(true);
        this.isPlaying = false;
        this._update({ isPlaying: false, trackTitle: null, positionMs: 0, durationMs: 0 });
        return;
      case "setVolume":
        this.masterVolume = Number(msg.volume);
        this._applyVolume();
        this._update({ volume: this.masterVolume * this.localVolume });
        return;
    }
  }

  // 流式起播：换曲才设 src（浏览器开始边下边播，不整文件入内存）→ seek 到 offset
  // v4 (Phase E): play 立即触发（loadedmetadata 后即 audio.play()，look-ahead 用 Date.now() 作锚点）
  async _startTrack(trackId, trackUrl, durationMs, trackOffsetMs) {
    if (!this.ctx || !this.audio) return;
    const gen = ++this._gen;
    const urlChanged = this.currentTrackUrl !== trackUrl;
    if (urlChanged) {
      this.currentTrackId = trackId;
      this.currentTrackUrl = trackUrl;
      const fname = decodeURIComponent(trackUrl.split("/").pop() ?? "");
      this._update({ trackTitle: fname });
      // 新曲重置 error retry 计数：上一曲的网络抖动不应污染新曲的容错
      this._errorRetries = 0;
      // 新曲重置漂移 seek 计数：上一曲的累计 seek 不应限制新曲的漂移修正
      this._driftSeeksThisTrack = 0;
      this._smoothDriftMs = 0; // 新曲 EMA 归零，避免旧曲残余 drift 影响伺服初始行为
      // 新曲位置锚点作废（loadedmetadata / playing 事件里重建）
      this._posAnchorRaw = -1;
    } else if (this.currentTrackId !== trackId) {
      this.currentTrackId = trackId;
    }
    this.currentDurationMs = durationMs;
    this.trackOffsetMs = trackOffsetMs;

    const begin = () => {
      if (gen !== this._gen || !this.audio) return; // 已被更新的 _startTrack 取代，跳过
      // 算首屏 metadata 加载耗时：给 A7 上报、给运维诊断慢设备
      if (this._srcSetAt) {
        this._lastLoadedMs = Math.max(0, Math.round(_now() - this._srcSetAt));
        this._srcSetAt = 0;
        this._reportLoadedMs(this._lastLoadedMs);
      }
      try { this.audio.currentTime = Math.max(0, trackOffsetMs / 1000); } catch {}
      try { this.audio.playbackRate = 1; } catch {} // 新一轮起播回正伺服速率
      this._posAnchorRaw = -1; // 位置锚点作废，seeked/playing 事件里重建
      // v4 (Phase E): 用 monotonic _now() 作锚点（统一时钟域，避免 Date.now() 与 monotonic-derived clockOffset 混合在 NTP 步进时偏差）
      const localTargetMs = _now() - this._clockOffset();
      const delay = Math.max(0, localTargetMs - _now());
      _log(`begin trackId=${trackId} dur=${durationMs}ms offset=${trackOffsetMs}ms delay=${delay}ms loadedMs=${this._lastLoadedMs}`);
      // 行业标准 "look-ahead scheduling" 模式（web.dev Audio Scheduling）:
      // 单次长 setTimeout(fn, 1500ms) jitter = ±10–50ms（主线程被 layout/GC 阻塞时）。
      // 改用 25ms 短间隔轮询，在每 tick 检查 _now() >= localTargetMs 才执行 play()，
      // 有效 jitter <25ms。多设备初始相位差直接受益。
      if (this.playTimer) clearInterval(this.playTimer);
      this.playTimer = setInterval(() => {
        if (gen !== this._gen) { clearInterval(this.playTimer); this.playTimer = null; return; }
        if (_now() >= localTargetMs) {
          clearInterval(this.playTimer);
          this.playTimer = null;
          this.audio?.play().then(() => {
          // play() 在异步 resolve 期间可能已被新 play / stop 取代：
          //   - 新 _startTrack 会递增 _gen
          //   - stop 会 _stopAudio(true) 然后 this.isPlaying=false
          // 单看 _gen 不够（stop 不递增 _gen），要再校验 audio 未暂停
          if (gen !== this._gen || this.audio?.paused) return;
          this.isPlaying = true;
          this._playGraceUntil = _now() + PLAY_GRACE_MS; // v4.1: 加载完成后 grace 期间不硬 seek
          this._update({ isPlaying: true, durationMs, needsUserGesture: false });
        }).catch((e) => {
          // autoplay policy 拒绝等：iOS 要求 user gesture，标记需解锁
          if (gen !== this._gen) return;
          console.warn("[sync] play() rejected:", e?.message);
          this.isPlaying = false;
          this._update({ isPlaying: false, needsUserGesture: true });
        });
        }  // _now() >= localTargetMs
      }, 25);
    };

    if (urlChanged) {
      // 先注册 listener 再设 src，避免 metadata 在注册前就到达导致 begin 永不执行
      this.audio.addEventListener("loadedmetadata", begin, { once: true });
      this._srcSetAt = _now();
      this.audio.src = trackUrl;
      this.audio.load();
    } else {
      begin();
    }
  }

  // 上报首屏加载耗时给服务端，A7 用来动态调整 PRELOAD_MS
  _reportLoadedMs(ms) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!ms || ms <= 0) return;
    try {
      this.ws.send(JSON.stringify({ type: "reportLoaded", loadedMs: ms }));
    } catch {}
  }

  _stopAudio(clearBuffer) {
    if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null; }
    if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
    if (this.audio) {
      try { this.audio.pause(); } catch {}
      try { this.audio.playbackRate = 1; } catch {} // 停止时回正伺服速率
      if (clearBuffer) {
        try {
          this.audio.currentTime = 0;
          this.audio.removeAttribute("src");
          this.audio.load();
        } catch {}
        this.currentTrackId = null;
        this.currentTrackUrl = null;
      }
    }
  }

  // onerror 重试超限后回滚：把 isPlaying 设回 false 让 UI 显示真实状态
  // 避免 silent stuck（用户看到"已连接""播放中"但实际无声）
  _rollbackPlayState() {
    this._errorRetries = 0;
    this.isPlaying = false;
    this._update({ isPlaying: false, mediaErrorCode: this.audio?.error?.code ?? 0 });
  }

  // v4 (Phase C): 基于最新 sync tick + monotonic 外推得到 expected position
  // 返回 null 表示回退到 v3 公式（未启用 / 静默超时 / 第二个 tick 未到）
  _expectedPositionSec() {
    if (!this.useSyncTicks) return null;
    if (this.lastSyncReceivedAt == null) return null;
    // 等第二个 tick 才启用：第一个 tick jitter 大，可能 anchor 到不稳定的状态
    if (this._syncTickCount < 2) return null;
    // 5s 内没收到 sync 视为连接问题（server 暂停广播 / 网络断），回退 null
    // 5s 比单 tick 间隔 200ms 大很多，给偶尔的 jitter/loss 留余量
    if (_now() - this.lastSyncReceivedAt > 5000) return null;
    // 暂停时不外推：server tick 的 isPlaying=false、positionMs 已冻结
    if (!this._syncIsPlaying) return this.lastSyncPositionMs / 1000;
    return this.lastSyncPositionMs / 1000 + (_now() - this.lastSyncReceivedAt) / 1000;
  }

  _drift() {
    if (!this.audio || !this.isPlaying) {
      this._update({
        positionMs: this.audio ? Math.max(0, Math.round(this.audio.currentTime * 1000)) : 0,
        driftMs: 0,
        bufferAheadMs: this._bufferAheadMs(),
      });
      return;
    }
    // 强制 seek 后屏蔽一小段，避免 seek 未完成时再次判定漂移触发 seek 风暴
    // （seeked 事件会把冷却提前到完成后 300ms，这里是兜底上限）
    if (_now() < this._seekCooldownUntil) return;

    // 插值位置时钟（成熟播放器手法）：raw currentTime 变化时记锚点，
    // 未变化时用 monotonic × playbackRate 外推。Safari currentTime 每 ~250ms
    // 才步进（噪声 ±125ms），插值后精度 ~5-10ms——伺服和 seek 判定都不再被噪声骗。
    const actualSec = this._estPositionSec();

    // outputLatency 补偿（AirPlay 手法）：蓝牙/外置声卡有 100-300ms 输出延迟且各设备不同。
    // 把各自的延迟加进预期位置 → 对齐"扬声器出声"而非"解码位置"。
    // Safari 没有 outputLatency 用 baseLatency 兜底（≈5-20ms），clamp 1s 防异常值。
    const outLatSec = Math.min(1, (Number.isFinite(this.ctx?.outputLatency) ? this.ctx.outputLatency : this.ctx?.baseLatency) || 0);
    // v4: 双轨 expectedSec — tick 锚点优先（continuous 真理源），fallback 用 audio.currentTime
    // tick 未到位时（kill switch / 启动初期）drift = 0，audio 自由播放靠浏览器自身 timing
    const tickExpected = this._expectedPositionSec();
    const expectedSec = tickExpected != null
      ? tickExpected + outLatSec
      : actualSec;  // v4 (Phase E): fallback 让 drift = 0。用 actualSec 而非 actualSec+outLatSec，否则 drift=-outLatSec 非零
    const driftMs = (actualSec - expectedSec) * 1000;
    const bufferAheadMs = this._bufferAheadMs();
    const abs = Math.abs(driftMs);
    const patch = {
      positionMs: Math.max(0, Math.round(actualSec * 1000)),
      driftMs: Math.round(driftMs),
      bufferAheadMs,
    };

    // v4.1: play grace — 音频加载后 5s 内不硬 seek（初始 drift 300-600ms 由 servo 消化）
    const inPlayGrace = _now() < this._playGraceUntil;
    // v4 (Phase C): tab 切回前台 2s 内 SEEK_THRESHOLD ×3，软收敛避免一次性硬 seek
    const seekThreshold = this._softDriftMode ? SEEK_THRESHOLD_MS * 3 : SEEK_THRESHOLD_MS;
    if (RATE_SERVO_ENABLED && (abs < seekThreshold || inPlayGrace)) {
      // v4.1: EMA 平滑 drift — 网络抖动 / tick 丢失会让原始 drift 跳变 ±30ms，
      // 不平滑的话 rate 每 500ms 抖动一次，iOS Safari 每次 playbackRate 赋值有微断口。
      this._smoothDriftMs = DRIFT_EMA_ALPHA * driftMs + (1 - DRIFT_EMA_ALPHA) * this._smoothDriftMs;
      const smoothAbs = Math.abs(this._smoothDriftMs);
      let rate = 1;
      if (smoothAbs > DRIFT_DEADBAND_MS) {
        // P 控制器：目标 ~RATE_SERVO_HORIZON_S 秒消化平滑后的漂移。落后（drift<0）加速。
        const corr = Math.max(-RATE_SERVO_MAX, Math.min(RATE_SERVO_MAX, -(this._smoothDriftMs / 1000) / RATE_SERVO_HORIZON_S));
        rate = 1 + Math.round(corr * 1000) / 1000;
      }
      // v4.1: rate 迟滞 — delta < RATE_HYSTERESIS 不赋值，防止 iOS 重采样器频繁微调卡顿
      if (Math.abs(this.audio.playbackRate - rate) >= RATE_HYSTERESIS) {
        try { this.audio.playbackRate = rate; } catch {}
      }
      patch.playbackRate = this.audio.playbackRate;
    } else if (abs >= seekThreshold) {
      // 硬 seek = 最后手段：只处理大错位（网络卡死恢复/标签页冻结唤醒/伺服关闭时）。
      // 同曲上限：超限说明时钟或音频引擎异常，继续 seek 只会更卡（不再自增 seekCount 免得吓人）。
      if (this._driftSeeksThisTrack >= MAX_DRIFT_SEEKS) { this._update(patch); return; }
      // 缓冲不足不 seek：seek 清空缓冲，starve 静音比不同步更差，等缓冲恢复再修。
      if (bufferAheadMs > 0 && bufferAheadMs < MIN_BUFFER_FOR_SEEK_MS) { this._update(patch); return; }

      this._driftSeeksThisTrack++;
      this._seekCooldownUntil = _now() + SEEK_COOLDOWN_MS;
      this._smoothDriftMs = 0; // seek 跳到正确位置后 EMA 归零
      try { this.audio.playbackRate = 1; } catch {} // seek 前回正伺服速率
      patch.playbackRate = 1;
      patch.seekCount = (this.status.seekCount ?? 0) + 1;
      _log(`seek #${patch.seekCount}: drift=${Math.round(driftMs)}ms audio=${actualSec.toFixed(2)}s expected=${expectedSec.toFixed(2)}s bufferedAhead=${bufferAheadMs}ms`);
      try { this.audio.currentTime = Math.max(0, expectedSec); } catch {}
      this._posAnchorRaw = -1; // 位置锚点作废，seeked 事件里重建
      // 注：不需要"校准 startServerTime"——seek 目标就是原时间线上的预期位置，
      // 时间线锚点保持不变才能让全 zone 设备收敛到同一条时间轴。
    }

    this._update(patch);
  }

  // 插值位置时钟：raw currentTime 变化时记锚点，未变化时按 monotonic × rate 外推。
  // 外推上限 600ms：超过说明播放真停住了（stall），不把估计位置虚推过去。
  _estPositionSec() {
    if (!this.audio) return 0;
    const raw = this.audio.currentTime;
    const now = _now();
    if (raw !== this._posAnchorRaw) {
      this._posAnchorRaw = raw;
      this._posAnchorAt = now;
      return raw;
    }
    if (this.audio.paused) return raw;
    const dt = (now - this._posAnchorAt) / 1000;
    if (dt > 0.6) return raw;
    return raw + dt * (this.audio.playbackRate || 1);
  }

  // 源缓冲前瞻：buffered.end(last) - currentTime，单位 ms。
  // 0 表示还没下载到任何数据；< 1000 表示接近 starve，可能即将断音。
  _bufferAheadMs() {
    if (!this.audio) return 0;
    const buf = this.audio.buffered;
    if (!buf || buf.length === 0) return 0;
    const ahead = buf.end(buf.length - 1) - this.audio.currentTime;
    return Math.max(0, Math.round(ahead * 1000));
  }

  setLocalVolume(v) {
    this.localVolume = Math.max(0, Math.min(1, Number(v)));
    this._applyVolume();
    this._update({ volume: this.masterVolume * this.localVolume, localVolume: this.localVolume });
  }
}
