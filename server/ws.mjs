import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.mjs";
import { snapshot } from "./scheduler.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_ZONE = 1;

export function isWebSocketUpgrade(req) {
  return (
    (req.headers["upgrade"] || "").toLowerCase() === "websocket" &&
    (req.headers["connection"] || "").toLowerCase().includes("upgrade")
  );
}

export function acceptKey(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.alive = true;
    this.buffer = Buffer.alloc(0);
    this.handlers = { message: [], close: [] };
    this.deviceId = null;
    this.zoneId = DEFAULT_ZONE;

    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on("close", () => {
      this.alive = false;
      for (const h of this.handlers.close) h();
    });
    socket.on("error", () => {
      this.alive = false;
      try { socket.destroy(); } catch {}
    });
  }

  on(ev, fn) { this.handlers[ev]?.push(fn); }

  send(obj) {
    if (!this.alive) return false;
    try {
      this.socket.write(encodeFrame(Buffer.from(JSON.stringify(obj)), 0x1));
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000) {
    if (!this.alive) return;
    try {
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(code, 0);
      this.socket.write(encodeFrame(buf, 0x8));
      this.socket.end();
    } catch {}
    this.alive = false;
  }

  parse() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        len = Number(big);
        offset += 8;
      }
      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + len);

      if (opcode === 0x8) {
        this.close(1000);
        return;
      }
      if (opcode === 0x9) {
        try { this.socket.write(encodeFrame(payload, 0xa)); } catch {}
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 && fin) {
        let msg;
        try { msg = JSON.parse(payload.toString("utf8")); } catch { continue; }
        for (const h of this.handlers.message) h(msg);
      }
    }
  }
}

class Hub {
  constructor() { this.conns = new Map(); } // deviceId -> { conn, zoneId }

  attach(deviceId, conn, zoneId) {
    const existing = this.conns.get(deviceId);
    if (existing && existing.conn !== conn) existing.conn.close(4000);
    this.conns.set(deviceId, { conn, zoneId });
    conn.zoneId = zoneId;
  }

  detach(conn) {
    for (const [id, entry] of this.conns) if (entry.conn === conn) this.conns.delete(id);
  }

  disconnect(deviceId) {
    const e = this.conns.get(deviceId);
    if (e) { e.conn.close(4001); this.conns.delete(deviceId); }
  }

  onlineDeviceIdsInZone(zoneId) {
    const out = [];
    for (const [id, e] of this.conns) if (e.zoneId === zoneId) out.push(id);
    return out;
  }

  onlineDeviceIds() { return Array.from(this.conns.keys()); }

  setDeviceZone(deviceId, zoneId) {
    const e = this.conns.get(deviceId);
    if (!e) return false;
    e.zoneId = zoneId;
    e.conn.zoneId = zoneId;
    return true;
  }

  sendTo(deviceId, msg) {
    const e = this.conns.get(deviceId);
    if (!e) return false;
    return e.conn.send(msg);
  }

  broadcastToZone(zoneId, msg) {
    let n = 0;
    for (const e of this.conns.values()) {
      if (e.zoneId === zoneId && e.conn.send(msg)) n++;
    }
    return n;
  }

  // 保留旧 API 兼容（当前代码未使用，供可能的日志/监控调用）
  broadcast(msg) {
    let n = 0;
    for (const e of this.conns.values()) if (e.conn.send(msg)) n++;
    return n;
  }
}

export const hub = new Hub();

export function handleUpgrade(req, socket) {
  if (!isWebSocketUpgrade(req)) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = acceptKey(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const conn = new WSConn(socket);

  conn.on("message", (msg) => {
    if (msg.type === "register") {
      const reqZone = Number(msg.zoneId);
      const zoneId = Number.isInteger(reqZone) && reqZone > 0 ? reqZone : DEFAULT_ZONE;
      const dev = ensureDevice(msg.deviceId, msg.name, msg.kind ?? "web", zoneId);
      conn.zoneId = dev.zoneId ?? zoneId;
      hub.attach(dev.id, conn, conn.zoneId);
      conn.send({ type: "hello", deviceId: dev.id, zoneId: conn.zoneId, serverTime: Date.now() });
      conn.send({ type: "setVolume", volume: Number(dev.volume) });
      const snap = snapshot(conn.zoneId);
      if (snap.isPlaying && snap.track && snap.startServerTime) {
        conn.send({
          type: "play",
          zoneId: snap.zoneId,
          trackId: snap.track.id,
          trackUrl: snap.track.url,
          durationMs: snap.track.durationMs,
          startServerTime: snap.startServerTime,
          trackOffsetMs: snap.trackOffsetMs,
        });
      }
      return;
    }
    if (msg.type === "ping") {
      conn.send({ type: "pong", t0: msg.t0, t1: Date.now() });
      if (conn.deviceId) {
        db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
          .run(Date.now(), conn.deviceId);
      }
      return;
    }
  });

  conn.on("close", () => hub.detach(conn));
}

function ensureDevice(deviceId, name, kind, zoneId) {
  const id = deviceId && deviceId.length > 0 ? deviceId : randomBytes(5).toString("hex");
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
  if (existing) {
    db.prepare("UPDATE devices SET last_seen_at = ?, kind = ?, zone_id = COALESCE(zone_id, ?) WHERE id = ?")
      .run(now, kind, zoneId, id);
    if (name && name !== existing.name) {
      db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, id);
      existing.name = name;
    }
    if (!existing.zone_id) existing.zone_id = zoneId;
    return existing;
  }
  const finalName = name ?? `${kind}-${id.slice(0, 4)}`;
  db.prepare(
    "INSERT INTO devices (id, name, kind, volume, zone_id, last_seen_at) VALUES (?, ?, ?, 1.0, ?, ?)",
  ).run(id, finalName, kind, zoneId, now);
  return { id, name: finalName, kind, volume: 1.0, zone_id: zoneId, last_seen_at: now };
}
