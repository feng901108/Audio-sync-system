const PING_INTERVAL_MS = 2000;
const PING_BURST_COUNT = 5;
const PING_BURST_INTERVAL_MS = 100;
const DRIFT_CHECK_MS = 1500;      // 缩短到 1.5s：减少漂移积累，避免大跳跃触发强 seek
const RATE_TWEAK = 0.003;         // 0.3%（原 0.5%）：蓝牙/外置 DAC 上 ±0.5% 阶跃有可闻咔嗒声
const RATE_LIMIT_MS = 1500;       // 长持续：让"减速-恢复"覆盖整个检查周期，听感平滑而非阶跃
const HARD_SEEK_BACK_MS = 100;    // 强 seek 前回退 100ms：让音频自然追上来，避免大跳跃的"扑通"声
const HARD_SEEK_THRESHOLD_MS = 200;
const SOFT_SEEK_THRESHOLD_MS = 30;

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
    this.rateResetTimer = null;
    this._gen = 0;            // 起播代次：快速切歌时让旧 loadedmetadata 回调自废
    this._seekCooldownUntil = 0; // 强制 seek 后短暂屏蔽 drift，避免 seek 风暴
    this.clockSamples = [];
    this.listeners = new Set();
    this.pingTimer = null;
    this.pingBurstTimer = null;
    this.driftTimer = null;
    this.reconnectTimer = null;
    // 两层音量：master 来自服务端下发（admin 调的），local 是用户本机拉杆（0-1 倍率）
    this.masterVolume = 1;
    this.localVolume = 1;
    this.status = {
      deviceId: null, connected: false, clockOffsetMs: 0, rttMs: 0,
      trackTitle: null, positionMs: 0, durationMs: 0,
      isPlaying: false, driftMs: 0, volume: 1, localVolume: 1,
      zoneId: this.zoneId, zoneName: null,
    };
  }

  _applyVolume() {
    if (!this.gain) return;
    this.gain.gain.value = this.masterVolume * this.localVolume;
  }

  on(fn) { this.listeners.add(fn); fn(this.status); return () => this.listeners.delete(fn); }
  _update(p) { this.status = { ...this.status, ...p }; for (const f of this.listeners) f(this.status); }

  async connect() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.ctx.destination);
    }
    // 流式播放元素 + 接入 Web Audio：音量走 gain，时钟基准仍是 ctx.currentTime
    if (!this.audio) {
      this.audio = new Audio();
      // 同源部署不需要 crossOrigin；设了反而要求服务端 CORS 头，跨域缺失会被静音
      this.audio.preload = "metadata"; // 大文件只加载头部，播放时按需 Range，降内存峰值
      this.mediaNode = this.ctx.createMediaElementSource(this.audio);
      this.mediaNode.connect(this.gain);
      // 自然播完：等服务端 scheduleAdvance 下发 next/loop-one 重播，不主动改状态避免竞争
      this.audio.onended = () => {};
    }
    await this.ctx.resume();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      this._update({ connected: true });
      this.ws.send(JSON.stringify({
        type: "register",
        deviceId: this.deviceId ?? undefined,
        name: this.deviceName,
        kind: this.kind,
        zoneId: this.zoneId,
      }));
      this._startPing();
      this._startDrift();
    };
    this.ws.onmessage = (ev) => this._handle(JSON.parse(ev.data));
    this.ws.onclose = () => {
      this._update({ connected: false });
      this._stopLoops();
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 1500);
      }
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
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
        this.ws.send(JSON.stringify({ type: "ping", t0: Date.now() }));
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
        this.ws.send(JSON.stringify({ type: "ping", t0: Date.now() }));
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pingBurstTimer) { clearTimeout(this.pingBurstTimer); this.pingBurstTimer = null; }
  }
  _startDrift() { this._stopDrift(); this.driftTimer = setInterval(() => this._drift(), DRIFT_CHECK_MS); }
  _stopDrift() { if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = null; } }
  _stopLoops() { this._stopPing(); this._stopDrift(); }

  _clockOffset() {
    if (!this.clockSamples.length) return 0;
    const sorted = [...this.clockSamples].sort((a, b) => a.rtt - b.rtt);
    const head = sorted.slice(0, Math.min(3, sorted.length));
    const offsets = head.map((s) => s.offset).sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)] ?? 0;
  }
  _serverNow() { return Date.now() + this._clockOffset(); }

  _handle(msg) {
    switch (msg.type) {
      case "pong": {
        const t2 = Date.now();
        const rtt = t2 - msg.t0;
        const offset = (msg.t1 - msg.t0 + (msg.t1 - t2)) / 2;
        this.clockSamples.push({ offset, rtt });
        if (this.clockSamples.length > 10) this.clockSamples.shift();
        const minRtt = Math.min(...this.clockSamples.map((s) => s.rtt));
        this._update({ clockOffsetMs: Math.round(this._clockOffset()), rttMs: Math.round(minRtt) });
        return;
      }
      case "hello":
        this.deviceId = msg.deviceId;
        if (msg.zoneId) {
          this.zoneId = msg.zoneId;
          this.status.zoneId = msg.zoneId;
        }
        localStorage.setItem("juguang.deviceId", msg.deviceId);
        this._update({ deviceId: msg.deviceId, zoneId: this.zoneId, ip: msg.ip || "" });
        return;
      case "play":
      case "seek":
        this._startTrack(msg.trackId, msg.trackUrl, msg.durationMs, msg.startServerTime, msg.trackOffsetMs);
        return;
      case "pause": {
        const atLocal = msg.atServerTime - this._clockOffset();
        const delay = Math.max(0, atLocal - Date.now());
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
    } else if (this.currentTrackId !== trackId) {
      this.currentTrackId = trackId;
    }
    this.currentDurationMs = durationMs;
    this.startServerTime = startServerTime;
    this.trackOffsetMs = trackOffsetMs;

    const begin = () => {
      if (gen !== this._gen || !this.audio) return; // 已被更新的 _startTrack 取代，跳过
      try { this.audio.currentTime = Math.max(0, trackOffsetMs / 1000); } catch {}
      const localTargetMs = startServerTime - this._clockOffset();
      const delay = Math.max(0, localTargetMs - Date.now());
      if (this.playTimer) clearTimeout(this.playTimer);
      this.playTimer = setTimeout(() => {
        if (gen !== this._gen) return;
        this.audio?.play().then(() => {
          this.isPlaying = true;
          this._update({ isPlaying: true, durationMs });
        }).catch((e) => {
          // autoplay policy 拒绝等：如实更新状态，避免 UI 显示播放中却无声
          console.warn("[sync] play() rejected:", e?.message);
          this.isPlaying = false;
          this._update({ isPlaying: false });
        });
      }, delay);
    };

    if (urlChanged) {
      // 先注册 listener 再设 src，避免 metadata 在注册前就到达导致 begin 永不执行
      this.audio.addEventListener("loadedmetadata", begin, { once: true });
      this.audio.src = trackUrl;
      this.audio.load();
    } else {
      begin();
    }
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

  _drift() {
    if (!this.audio || !this.isPlaying) {
      this._update({
        positionMs: this.audio ? Math.max(0, Math.round(this.audio.currentTime * 1000)) : 0,
        driftMs: 0,
      });
      return;
    }
    // 强制 seek 后屏蔽一小段，避免 seek 未完成时再次判定漂移触发 seek 风暴
    if (Date.now() < this._seekCooldownUntil) return;
    const actualSec = this.audio.currentTime;
    const expectedSec = (this._serverNow() - this.startServerTime) / 1000 + this.trackOffsetMs / 1000;
    const driftMs = (actualSec - expectedSec) * 1000;
    this._update({ positionMs: Math.max(0, Math.round(actualSec * 1000)), driftMs: Math.round(driftMs) });

    const abs = Math.abs(driftMs);
    if (abs >= HARD_SEEK_THRESHOLD_MS) {
      // 大偏差：回退 100ms 再 seek，让音频自然推进补回对齐点，
      // 比直接跳 1-5 秒造成的"扑通"声听感好得多。短冷却（800ms），因为跳跃小。
      this._seekCooldownUntil = Date.now() + 800;
      try {
        this.audio.currentTime = Math.max(0, expectedSec - HARD_SEEK_BACK_MS / 1000);
      } catch {}
      return;
    }
    if (abs >= SOFT_SEEK_THRESHOLD_MS) {
      // 小偏差：长持续低幅微调 playbackRate（±0.3% 持续 1.5s），听感平滑而非阶跃
      const rate = driftMs > 0 ? 1 - RATE_TWEAK : 1 + RATE_TWEAK;
      try { this.audio.playbackRate = rate; } catch {}
      if (this.rateResetTimer) clearTimeout(this.rateResetTimer);
      this.rateResetTimer = setTimeout(() => {
        try { if (this.audio) this.audio.playbackRate = 1; } catch {}
      }, RATE_LIMIT_MS);
    }
  }

  setLocalVolume(v) {
    this.localVolume = Math.max(0, Math.min(1, Number(v)));
    this._applyVolume();
    this._update({ volume: this.masterVolume * this.localVolume, localVolume: this.localVolume });
  }
}
