const PING_INTERVAL_MS = 2000;
const DRIFT_CHECK_MS = 3000;
const RATE_TWEAK = 0.005;
const RATE_LIMIT_MS = 200;

export class SyncClient {
  constructor(deviceName, kind = "web") {
    this.deviceName = deviceName;
    this.kind = kind;
    this.deviceId = localStorage.getItem("juguang.deviceId");
    this.ws = null;
    this.ctx = null;
    this.gain = null;
    this.currentSource = null;
    this.currentBuffer = null;
    this.currentTrackId = null;
    this.currentTrackUrl = null;
    this.currentDurationMs = 0;
    this.startServerTime = 0;
    this.trackOffsetMs = 0;
    this.isPlaying = false;
    this.localStartCtxTime = 0;
    this.clockSamples = [];
    this.listeners = new Set();
    this.pingTimer = null;
    this.driftTimer = null;
    this.reconnectTimer = null;
    // 两层音量：master 来自服务端下发（admin 调的），local 是用户本机拉杆（0-1 倍率）
    this.masterVolume = 1;
    this.localVolume = 1;
    this.status = {
      deviceId: null, connected: false, clockOffsetMs: 0, rttMs: 0,
      trackTitle: null, positionMs: 0, durationMs: 0,
      isPlaying: false, driftMs: 0, volume: 1, localVolume: 1,
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
    const tick = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", t0: Date.now() }));
      }
    };
    tick();
    this.pingTimer = setInterval(tick, PING_INTERVAL_MS);
  }
  _stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }
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
        localStorage.setItem("juguang.deviceId", msg.deviceId);
        this._update({ deviceId: msg.deviceId });
        return;
      case "play":
      case "seek":
        this._startTrack(msg.trackId, msg.trackUrl, msg.durationMs, msg.startServerTime, msg.trackOffsetMs);
        return;
      case "pause": {
        const atLocal = msg.atServerTime - this._clockOffset();
        const delay = Math.max(0, atLocal - Date.now());
        setTimeout(() => this._stopAudio(false), delay);
        this.isPlaying = false;
        this._update({ isPlaying: false });
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

  async _startTrack(trackId, trackUrl, durationMs, startServerTime, trackOffsetMs) {
    if (!this.ctx) return;
    if (this.currentTrackId !== trackId || this.currentTrackUrl !== trackUrl) {
      const buf = await fetch(trackUrl).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b));
      this.currentBuffer = buf;
      this.currentTrackId = trackId;
      this.currentTrackUrl = trackUrl;
      const fname = decodeURIComponent(trackUrl.split("/").pop() ?? "");
      this._update({ trackTitle: fname });
    }
    this.currentDurationMs = durationMs;
    this.startServerTime = startServerTime;
    this.trackOffsetMs = trackOffsetMs;
    this._stopAudio(false);
    if (!this.currentBuffer) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.currentBuffer;
    src.connect(this.gain);
    const localTargetMs = startServerTime - this._clockOffset();
    const delaySec = Math.max(0, (localTargetMs - Date.now()) / 1000);
    const ctxStart = this.ctx.currentTime + delaySec;
    src.start(ctxStart, trackOffsetMs / 1000);
    this.currentSource = src;
    this.localStartCtxTime = ctxStart - trackOffsetMs / 1000;
    this.isPlaying = true;
    this._update({ isPlaying: true, durationMs });

    src.onended = () => { if (this.currentSource === src) this.currentSource = null; };
  }

  _stopAudio(clearBuffer) {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch {}
      try { this.currentSource.disconnect(); } catch {}
      this.currentSource = null;
    }
    if (clearBuffer) {
      this.currentBuffer = null;
      this.currentTrackId = null;
      this.currentTrackUrl = null;
    }
  }

  _drift() {
    if (!this.ctx || !this.currentSource || !this.isPlaying) {
      this._update({ positionMs: 0, driftMs: 0 });
      return;
    }
    const actualSec = this.ctx.currentTime - this.localStartCtxTime;
    const expectedSec = (this._serverNow() - this.startServerTime) / 1000 + this.trackOffsetMs / 1000;
    const driftMs = (actualSec - expectedSec) * 1000;
    this._update({ positionMs: Math.max(0, Math.round(actualSec * 1000)), driftMs: Math.round(driftMs) });

    const abs = Math.abs(driftMs);
    if (abs >= 200) {
      this._startTrack(this.currentTrackId, this.currentTrackUrl, this.currentDurationMs, this.startServerTime, Math.max(0, Math.round(expectedSec * 1000)));
      return;
    }
    if (abs >= 30 && this.currentSource.playbackRate) {
      const rate = driftMs > 0 ? 1 - RATE_TWEAK : 1 + RATE_TWEAK;
      try {
        this.currentSource.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
        setTimeout(() => {
          try { this.currentSource?.playbackRate.setValueAtTime(1, this.ctx.currentTime); } catch {}
        }, RATE_LIMIT_MS);
      } catch {}
    }
  }

  setLocalVolume(v) {
    this.localVolume = Math.max(0, Math.min(1, Number(v)));
    this._applyVolume();
    this._update({ volume: this.masterVolume * this.localVolume, localVolume: this.localVolume });
  }
}
