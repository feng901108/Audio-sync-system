import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { db } from "./db.mjs";
import { findAdminByUsername, verifyPassword, createSession, getSession, destroySession, adminCount } from "./auth.mjs";
import { handleUpgrade, hub } from "./ws.mjs";
import {
  setHub, snapshot, play, pause, resume, stop, seek, next,
  enqueue, clearQueue, setQueue,
  listZones, getZone, createZone, renameZone, deleteZone, assignDeviceZone,
} from "./scheduler.mjs";
import { parseMultipart } from "./multipart.mjs";
import { probeAudioDuration } from "./audio-probe.mjs";

setHub(hub);

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const ROOT = process.cwd();
const AUDIO_DIR = resolve(ROOT, "data/audio");
const WEB_DIR = resolve(ROOT, "web");
if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true });

const ALLOWED_EXT = new Set([".mp3", ".m4a", ".aac", ".ogg", ".wav", ".flac"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

function parseCookies(req) {
  const out = {};
  const c = req.headers["cookie"];
  if (!c) return out;
  for (const part of c.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function getSessionFromReq(req) {
  const sid = parseCookies(req)["juguang.sid"];
  return getSession(sid);
}

function send(res, status, body, headers = {}) {
  const buf =
    body == null ? Buffer.alloc(0) :
    Buffer.isBuffer(body) ? body :
    typeof body === "string" ? Buffer.from(body) :
    Buffer.from(JSON.stringify(body));
  const h = { ...headers };
  if (!h["Content-Type"]) {
    h["Content-Type"] = typeof body === "object" && !Buffer.isBuffer(body) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  }
  h["Content-Length"] = buf.length;
  res.writeHead(status, h);
  res.end(buf);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { ...headers, "Content-Type": "application/json; charset=utf-8" });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

function serveStatic(req, res, filePath) {
  if (!existsSync(filePath)) return send(res, 404, "Not found");
  const stat = statSync(filePath);
  if (stat.isDirectory()) return send(res, 404, "Not found");
  const ext = extname(filePath).toLowerCase();
  const range = req.headers["range"];
  const total = stat.size;
  const headers = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : total - 1;
      if (start >= 0 && end < total && start <= end) {
        headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
        headers["Content-Length"] = end - start + 1;
        res.writeHead(206, headers);
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }
  headers["Content-Length"] = total;
  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

const ROUTES = [];
function route(method, pattern, handler, opts = {}) {
  ROUTES.push({ method, pattern, handler, requireAuth: !!opts.requireAuth });
}

route("POST", "/api/auth/login", async (req, res) => {
  const { username, password } = await readJson(req);
  if (!username || !password) return sendJson(res, 400, { error: "缺少用户名或密码" });
  const admin = findAdminByUsername(username);
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    return sendJson(res, 401, { error: "用户名或密码错误" });
  }
  const { sid, expires } = createSession(admin);
  const cookie = `juguang.sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expires - Date.now()) / 1000)}`;
  sendJson(res, 200, { ok: true, username: admin.username }, { "Set-Cookie": cookie });
});

route("POST", "/api/auth/logout", async (req, res) => {
  const sid = parseCookies(req)["juguang.sid"];
  destroySession(sid);
  sendJson(res, 200, { ok: true }, { "Set-Cookie": "juguang.sid=; Path=/; Max-Age=0" });
});

route("GET", "/api/auth/me", async (req, res) => {
  const s = getSessionFromReq(req);
  sendJson(res, 200, {
    authenticated: !!s,
    username: s?.username ?? null,
    adminCount: adminCount(),
  });
});

route("GET", "/api/health", async (_req, res) => {
  sendJson(res, 200, { ok: true, serverTime: Date.now() });
});

route("GET", "/api/tracks", async (_req, res) => {
  const rows = db.prepare("SELECT * FROM tracks ORDER BY uploaded_at DESC").all();
  sendJson(res, 200, { tracks: rows.map((r) => ({ ...r, duration_ms: Number(r.duration_ms), size_bytes: Number(r.size_bytes), uploaded_at: Number(r.uploaded_at) })) });
});

route("POST", "/api/tracks", async (req, res) => {
  const ct = req.headers["content-type"] ?? "";
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
  if (!m) return sendJson(res, 400, { error: "缺少 multipart boundary" });
  const boundary = m[1] ?? m[2];
  let parts;
  try {
    parts = await parseMultipart(req, boundary, 200 * 1024 * 1024);
  } catch (e) {
    return sendJson(res, 400, { error: String(e?.message ?? e) });
  }
  const file = parts.find((p) => p.filename);
  if (!file) return sendJson(res, 400, { error: "未收到文件" });
  const ext = extname(file.filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return sendJson(res, 400, { error: `不支持的格式 ${ext}` });

  const id = randomBytes(6).toString("hex");
  const safe = `${id}${ext}`;
  const outPath = resolve(AUDIO_DIR, safe);
  await new Promise((ok, ng) => {
    const ws = createWriteStream(outPath);
    ws.on("finish", ok);
    ws.on("error", ng);
    ws.end(file.data);
  });

  let durationMs = 0;
  try { durationMs = await probeAudioDuration(outPath); } catch {}
  const titleRaw = file.filename.slice(0, file.filename.length - ext.length);
  const stat = statSync(outPath);
  const now = Date.now();
  db.prepare(
    "INSERT INTO tracks (id, filename, title, artist, duration_ms, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, safe, titleRaw || safe, null, durationMs, stat.size, now);
  sendJson(res, 200, {
    track: { id, filename: safe, title: titleRaw, artist: null, duration_ms: durationMs, size_bytes: stat.size, uploaded_at: now },
  });
}, { requireAuth: true });

route("DELETE", "/api/tracks/:id", async (req, res, params) => {
  const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(params.id);
  if (!row) return sendJson(res, 404, { error: "曲目不存在" });
  try { unlinkSync(resolve(AUDIO_DIR, row.filename)); } catch {}
  db.prepare("DELETE FROM tracks WHERE id = ?").run(params.id);
  sendJson(res, 200, { ok: true });
}, { requireAuth: true });

route("GET", "/api/devices", async (_req, res) => {
  const rows = db.prepare("SELECT * FROM devices ORDER BY last_seen_at DESC").all();
  const online = new Set(hub.onlineDeviceIds());
  sendJson(res, 200, {
    devices: rows.map((d) => ({
      ...d,
      volume: Number(d.volume),
      zone_id: d.zone_id == null ? null : Number(d.zone_id),
      last_seen_at: Number(d.last_seen_at),
      online: online.has(d.id),
    })),
  });
});

route("PATCH", "/api/devices/:id", async (req, res, params) => {
  const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(params.id);
  if (!row) return sendJson(res, 404, { error: "设备不存在" });
  const { name, volume, zoneId } = await readJson(req);
  if (name !== undefined) db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, params.id);
  if (volume !== undefined) {
    const v = Math.max(0, Math.min(1, Number(volume)));
    db.prepare("UPDATE devices SET volume = ? WHERE id = ?").run(v, params.id);
    hub.sendTo(params.id, { type: "setVolume", volume: v });
  }
  if (zoneId !== undefined) {
    if (zoneId === null) {
      db.prepare("UPDATE devices SET zone_id = NULL WHERE id = ?").run(params.id);
      hub.setDeviceZone(params.id, 0); // 0 表示"未分区"，Hub 不向其广播
    } else {
      const r = assignDeviceZone(params.id, Number(zoneId));
      if (!r.ok) return sendJson(res, 400, { error: r.error });
    }
  }
  sendJson(res, 200, { ok: true });
}, { requireAuth: true });

route("DELETE", "/api/devices/:id", async (_req, res, params) => {
  db.prepare("DELETE FROM devices WHERE id = ?").run(params.id);
  hub.disconnect(params.id);
  sendJson(res, 200, { ok: true });
}, { requireAuth: true });

// === 旧路径（过渡）：内部转调 zone=1 ===
route("GET", "/api/playback", async (_req, res) => sendJson(res, 200, snapshot(1)));
route("POST", "/api/playback/play", async (req, res) => {
  const { trackId, offsetMs } = await readJson(req);
  if (!trackId) return sendJson(res, 400, { error: "缺少 trackId" });
  sendJson(res, 200, play(1, trackId, Number(offsetMs ?? 0)));
}, { requireAuth: true });
route("POST", "/api/playback/pause", async (_req, res) => sendJson(res, 200, pause(1)), { requireAuth: true });
route("POST", "/api/playback/resume", async (_req, res) => sendJson(res, 200, resume(1)), { requireAuth: true });
route("POST", "/api/playback/stop", async (_req, res) => sendJson(res, 200, stop(1)), { requireAuth: true });
route("POST", "/api/playback/next", async (_req, res) => sendJson(res, 200, next(1)), { requireAuth: true });
route("POST", "/api/playback/seek", async (req, res) => {
  const { offsetMs } = await readJson(req);
  sendJson(res, 200, seek(1, Number(offsetMs ?? 0)));
}, { requireAuth: true });
route("POST", "/api/queue/enqueue", async (req, res) => {
  const { trackIds } = await readJson(req);
  if (!Array.isArray(trackIds) || trackIds.length === 0) return sendJson(res, 400, { error: "trackIds 必须是非空数组" });
  sendJson(res, 200, enqueue(1, trackIds));
}, { requireAuth: true });
route("POST", "/api/queue/replace", async (req, res) => {
  const { trackIds } = await readJson(req);
  if (!Array.isArray(trackIds)) return sendJson(res, 400, { error: "trackIds 必须是数组" });
  setQueue(1, trackIds);
  sendJson(res, 200, { ok: true });
}, { requireAuth: true });
route("POST", "/api/queue/clear", async (_req, res) => sendJson(res, 200, clearQueue(1)), { requireAuth: true });

// === Zone 管理（全局资源） ===
route("GET", "/api/zones", async (_req, res) => {
  const zones = listZones();
  const enriched = zones.map((z) => ({ ...z, snapshot: snapshot(z.id) }));
  sendJson(res, 200, { zones: enriched });
});
route("POST", "/api/zones", async (req, res) => {
  const { name } = await readJson(req);
  const r = createZone(name);
  if (!r.ok) return sendJson(res, 400, r);
  sendJson(res, 200, r);
}, { requireAuth: true });
route("PATCH", "/api/zones/:id", async (req, res, params) => {
  const { name } = await readJson(req);
  const r = renameZone(Number(params.id), name);
  if (!r.ok) return sendJson(res, r.error === "分区不存在" ? 404 : 400, r);
  sendJson(res, 200, r);
}, { requireAuth: true });
route("DELETE", "/api/zones/:id", async (req, res, params) => {
  const r = deleteZone(Number(params.id));
  if (!r.ok) return sendJson(res, r.error === "分区不存在" ? 404 : 400, r);
  sendJson(res, 200, r);
}, { requireAuth: true });

// === Zone 内 playback / queue / devices（路径化） ===
function parseZoneId(params) {
  const n = Number(params.zoneId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

route("GET", "/api/zones/:zoneId/snapshot", async (_req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  sendJson(res, 200, snapshot(zid));
});
route("GET", "/api/zones/:zoneId/devices", async (_req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  const rows = db.prepare("SELECT * FROM devices WHERE zone_id = ? ORDER BY last_seen_at DESC").all(zid);
  const online = new Set(hub.onlineDeviceIdsInZone(zid));
  sendJson(res, 200, {
    devices: rows.map((d) => ({
      ...d, volume: Number(d.volume), zone_id: Number(d.zone_id),
      last_seen_at: Number(d.last_seen_at), online: online.has(d.id),
    })),
  });
});
route("POST", "/api/zones/:zoneId/playback/play", async (req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  const { trackId, offsetMs } = await readJson(req);
  if (!trackId) return sendJson(res, 400, { error: "缺少 trackId" });
  sendJson(res, 200, play(zid, trackId, Number(offsetMs ?? 0)));
}, { requireAuth: true });
route("POST", "/api/zones/:zoneId/playback/pause", async (_req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  sendJson(res, 200, pause(zid));
}, { requireAuth: true });
route("POST", "/api/zones/:zoneId/playback/resume", async (_req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  sendJson(res, 200, resume(zid));
}, { requireAuth: true });
route("POST", "/api/zones/:zoneId/playback/stop", async (_req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  sendJson(res, 200, stop(zid));
}, { requireAuth: true });
route("POST", "/api/zones/:zoneId/playback/next", async (_req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  sendJson(res, 200, next(zid));
}, { requireAuth: true });
route("POST", "/api/zones/:zoneId/playback/seek", async (req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  const { offsetMs } = await readJson(req);
  sendJson(res, 200, seek(zid, Number(offsetMs ?? 0)));
}, { requireAuth: true });
route("POST", "/api/zones/:zoneId/queue/enqueue", async (req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  const { trackIds } = await readJson(req);
  if (!Array.isArray(trackIds) || trackIds.length === 0) return sendJson(res, 400, { error: "trackIds 必须是非空数组" });
  sendJson(res, 200, enqueue(zid, trackIds));
}, { requireAuth: true });
route("POST", "/api/zones/:zoneId/queue/replace", async (req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  const { trackIds } = await readJson(req);
  if (!Array.isArray(trackIds)) return sendJson(res, 400, { error: "trackIds 必须是数组" });
  setQueue(zid, trackIds);
  sendJson(res, 200, { ok: true });
}, { requireAuth: true });
route("POST", "/api/zones/:zoneId/queue/clear", async (_req, res, params) => {
  const zid = parseZoneId(params);
  if (!zid) return sendJson(res, 400, { error: "非法 zoneId" });
  if (!getZone(zid)) return sendJson(res, 404, { error: "分区不存在" });
  sendJson(res, 200, clearQueue(zid));
}, { requireAuth: true });

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    if (r.pattern === pathname) return { handler: r.handler, params: {}, requireAuth: r.requireAuth };
    const ps = r.pattern.split("/");
    const us = pathname.split("/");
    if (ps.length !== us.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(us[i]);
      else if (ps[i] !== us[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params, requireAuth: r.requireAuth };
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      const m = matchRoute(req.method, pathname);
      if (!m) return sendJson(res, 404, { error: "Not found" });
      if (m.requireAuth && !getSessionFromReq(req)) return sendJson(res, 401, { error: "未登录" });
      try { await m.handler(req, res, m.params); }
      catch (e) { console.error(e); sendJson(res, 500, { error: String(e?.message ?? e) }); }
      return;
    }

    if (pathname.startsWith("/audio/")) {
      const name = pathname.slice("/audio/".length);
      if (name.includes("..") || name.includes("/")) return send(res, 400, "bad path");
      return serveStatic(req, res, resolve(AUDIO_DIR, name));
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

    if (pathname === "/" || pathname === "/index.html") return serveStatic(req, res, resolve(WEB_DIR, "index.html"));
    if (pathname === "/admin" || pathname === "/admin.html") return serveStatic(req, res, resolve(WEB_DIR, "admin.html"));

    const safe = pathname.replace(/^\/+/, "");
    if (safe.includes("..")) return send(res, 400, "bad path");
    const filePath = resolve(WEB_DIR, safe);
    if (!filePath.startsWith(WEB_DIR)) return send(res, 400, "bad path");
    if (existsSync(filePath) && statSync(filePath).isFile()) return serveStatic(req, res, filePath);

    return send(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    try { send(res, 500, "Server error"); } catch {}
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/ws") return handleUpgrade(req, socket);
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`聚光广播服务端已启动：http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`管理页：http://localhost:${PORT}/admin   聆听页：http://localhost:${PORT}/`);
  if (adminCount() === 0) {
    console.log("⚠️  尚未创建管理员，请先运行: node server/init-admin.mjs admin yourpass");
  }
});
