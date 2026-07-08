const PING_INTERVAL_MS = 2000;
const PING_BURST_COUNT = 5;
const PING_BURST_INTERVAL_MS = 100;
const DRIFT_CHECK_MS = 1500;      // 漂移检查周期
const SEEK_THRESHOLD_MS = 100;    // 单一阈值：<100ms 接受，≥100ms seek
const SEEK_BACK_MS = 100;         // seek 前回退：让音频自然推进补齐对齐点
const SEEK_COOLDOWN_MS = 1000;    // seek 后冷却：避免 seek 风暴
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
    this.startServerTime = 0;
    this.trackOffsetMs = 0;
    this.isPlaying = false;
    this.playTimer = null;    // 定时起播（对齐服务端 startServerTime）
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
      audioContextState: "closed",  // AudioContext.state：closed/suspended/running
      mediaErrorCode: 0,  // audio.error?.code：0=OK, 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
      needsUserGesture: false,  // iOS: autoplay 被拒需用户点一下恢复
      isIos: IS_IOS,     // 用于调试 UI 差异化提示
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

  _stopLoops() { this._stopPing(); this._stopDrift(); this._stopHeartbeatWatch(); }

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
        this._startTrack(msg.trackId, msg.trackUrl, msg.durationMs, msg.startServerTime, msg.trackOffsetMs);
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
  // → 在服务端指定的 startServerTime 换算的本地时刻 play()。
  async _startTrack(trackId, trackUrl, durationMs, startServerTime, trackOffsetMs) {
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
    } else if (this.currentTrackId !== trackId) {
      this.currentTrackId = trackId;
    }
    this.currentDurationMs = durationMs;
    this.startServerTime = startServerTime;
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
      const localTargetMs = startServerTime - this._clockOffset();
      const delay = Math.max(0, localTargetMs - _now());
      _log(`begin trackId=${trackId} dur=${durationMs}ms offset=${trackOffsetMs}ms delay=${delay}ms loadedMs=${this._lastLoadedMs}`);
      if (this.playTimer) clearTimeout(this.playTimer);
      this.playTimer = setTimeout(() => {
        if (gen !== this._gen) return;
        this.audio?.play().then(() => {
          // play() 在异步 resolve 期间可能已被新 play / stop 取代：
          //   - 新 _startTrack 会递增 _gen
          //   - stop 会 _stopAudio(true) 然后 this.isPlaying=false
          // 单看 _gen 不够（stop 不递增 _gen），要再校验 audio 未暂停
          if (gen !== this._gen || this.audio?.paused) return;
          this.isPlaying = true;
          this._update({ isPlaying: true, durationMs, needsUserGesture: false });
        }).catch((e) => {
          // autoplay policy 拒绝等：iOS 要求 user gesture，标记需解锁
          if (gen !== this._gen) return;
          console.warn("[sync] play() rejected:", e?.message);
          this.isPlaying = false;
          this._update({ isPlaying: false, needsUserGesture: true });
        });
      }, delay);
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
    if (this.playTimer) { clearTimeout(this.playTimer); this.playTimer = null; }
    if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
    if (this.audio) {
      try { this.audio.pause(); } catch {}
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
    if (_now() < this._seekCooldownUntil) return;
    const actualSec = this.audio.currentTime;
    const expectedSec = (this._serverNow() - this.startServerTime) / 1000 + this.trackOffsetMs / 1000;
    const driftMs = (actualSec - expectedSec) * 1000;
    this._update({
      positionMs: Math.max(0, Math.round(actualSec * 1000)),
      driftMs: Math.round(driftMs),
      bufferAheadMs: this._bufferAheadMs(),
    });

    const abs = Math.abs(driftMs);
    if (abs >= SEEK_THRESHOLD_MS) {
      // 回退 SEEK_BACK_MS 再 seek，让音频自然推进补齐对齐点（避免"扑通"声）。
      // 没有 playbackRate 微调路径：playbackRate 改变会触发 DAC 重新锁定 LPCM，
      // 蓝牙/外置 DAC 上周期性触发造成可闻"咯噔"声——那是断音的根因。
      // 接受 < 100ms 的小漂移（人耳对 < 80ms 相位差不敏感），seek 只在漂移累积到阈值时触发。
      this._seekCooldownUntil = _now() + SEEK_COOLDOWN_MS;
      const newSeekCount = (this.status.seekCount ?? 0) + 1;
      this._update({ seekCount: newSeekCount }); // 走 _update 广播给 listener（之前直接改 status 不刷新）
      _log(`seek #${newSeekCount}: drift=${Math.round(driftMs)}ms audio=${actualSec.toFixed(2)}s expected=${expectedSec.toFixed(2)}s bufferedAhead=${this._bufferAheadMs()}ms`);
      try {
        this.audio.currentTime = Math.max(0, expectedSec - SEEK_BACK_MS / 1000);
      } catch {}
    }
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
