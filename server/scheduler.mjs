import { db } from "./db.mjs";

const PRELOAD_MS = 800;
const DEFAULT_ZONE = 1;

let _hub = null;
export function setHub(hub) { _hub = hub; }

// 每 zone 一份调度状态
const zones = new Map();
function zoneState(zoneId) {
  let s = zones.get(zoneId);
  if (!s) { s = { advanceTimer: null }; zones.set(zoneId, s); }
  return s;
}

function getRow(zoneId) {
  return db.prepare("SELECT * FROM playback_state WHERE zone_id = ?").get(zoneId);
}

export function getState(zoneId = DEFAULT_ZONE) {
  return getRow(zoneId);
}

export function getQueue(zoneId = DEFAULT_ZONE) {
  try {
    return JSON.parse(getRow(zoneId).queue_json);
  } catch {
    return [];
  }
}

export function setQueue(zoneId, queue) {
  if (queue === undefined) { queue = zoneId; zoneId = DEFAULT_ZONE; } // 兼容旧调用 setQueue(arr)
  db.prepare("UPDATE playback_state SET queue_json = ?, updated_at = ? WHERE zone_id = ?")
    .run(JSON.stringify(queue), Date.now(), zoneId);
}

function getTrack(trackId) {
  return db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
}

function clearAdvance(zoneId) {
  const s = zones.get(zoneId);
  if (s?.advanceTimer) {
    clearTimeout(s.advanceTimer);
    s.advanceTimer = null;
  }
}

function scheduleAdvance(zoneId, durationMs, startServerTime, offsetMs) {
  clearAdvance(zoneId);
  const remain = durationMs - offsetMs - (Date.now() - startServerTime);
  if (remain <= 0) return;
  zoneState(zoneId).advanceTimer = setTimeout(() => next(zoneId), remain + 200);
}

export function play(zoneId, trackId, offsetMs = 0) {
  if (trackId === undefined) { trackId = zoneId; zoneId = DEFAULT_ZONE; } // 兼容 play(trackId, offset)
  const t = getTrack(trackId);
  if (!t) return { ok: false, error: "曲目不存在" };
  const startServerTime = Date.now() + PRELOAD_MS;
  db.prepare(`UPDATE playback_state
    SET track_id = ?, start_server_time = ?, track_offset_ms = ?,
        is_playing = 1, updated_at = ? WHERE zone_id = ?`)
    .run(t.id, startServerTime, offsetMs, Date.now(), zoneId);

  _hub?.broadcastToZone(zoneId, {
    type: "play",
    zoneId,
    trackId: t.id,
    trackUrl: `/audio/${t.filename}`,
    durationMs: Number(t.duration_ms),
    startServerTime,
    trackOffsetMs: offsetMs,
  });
  scheduleAdvance(zoneId, Number(t.duration_ms), startServerTime, offsetMs);
  return { ok: true, startServerTime };
}

export function pause(zoneId = DEFAULT_ZONE) {
  const s = getRow(zoneId);
  if (!s.track_id || !s.is_playing) return { ok: true };
  const atServerTime = Date.now() + 200;
  const playedMs = Number(s.track_offset_ms) + (atServerTime - Number(s.start_server_time ?? atServerTime));
  db.prepare(`UPDATE playback_state SET is_playing = 0, track_offset_ms = ?, start_server_time = NULL, updated_at = ? WHERE zone_id = ?`)
    .run(Math.max(0, playedMs), Date.now(), zoneId);
  clearAdvance(zoneId);
  _hub?.broadcastToZone(zoneId, { type: "pause", zoneId, atServerTime });
  return { ok: true };
}

export function resume(zoneId = DEFAULT_ZONE) {
  const s = getRow(zoneId);
  if (!s.track_id) return { ok: false, error: "没有曲目" };
  return play(zoneId, s.track_id, Number(s.track_offset_ms));
}

export function stop(zoneId = DEFAULT_ZONE) {
  db.prepare(`UPDATE playback_state SET is_playing = 0, track_id = NULL, start_server_time = NULL, track_offset_ms = 0, updated_at = ? WHERE zone_id = ?`)
    .run(Date.now(), zoneId);
  clearAdvance(zoneId);
  _hub?.broadcastToZone(zoneId, { type: "stop", zoneId });
  return { ok: true };
}

export function seek(zoneId, offsetMs) {
  if (offsetMs === undefined) { offsetMs = zoneId; zoneId = DEFAULT_ZONE; } // 兼容 seek(offset)
  const s = getRow(zoneId);
  if (!s.track_id) return { ok: false, error: "没有曲目" };
  return play(zoneId, s.track_id, Math.max(0, offsetMs));
}

export function next(zoneId = DEFAULT_ZONE) {
  const q = getQueue(zoneId);
  if (q.length === 0) return stop(zoneId);
  const [head, ...rest] = q;
  setQueue(zoneId, rest);
  return play(zoneId, head, 0);
}

export function enqueue(zoneId, trackIds) {
  if (!Array.isArray(trackIds)) { trackIds = zoneId; zoneId = DEFAULT_ZONE; } // 兼容 enqueue(arr)
  setQueue(zoneId, [...getQueue(zoneId), ...trackIds]);
  const s = getRow(zoneId);
  if (!s.is_playing && !s.track_id) return next(zoneId);
  return { ok: true };
}

export function clearQueue(zoneId = DEFAULT_ZONE) {
  setQueue(zoneId, []);
  return { ok: true };
}

export function snapshot(zoneId = DEFAULT_ZONE) {
  const s = getRow(zoneId);
  const q = getQueue(zoneId);
  const t = s.track_id ? getTrack(s.track_id) : null;
  return {
    zoneId,
    isPlaying: !!s.is_playing,
    trackId: s.track_id,
    trackOffsetMs: Number(s.track_offset_ms),
    startServerTime: s.start_server_time != null ? Number(s.start_server_time) : null,
    track: t ? {
      id: t.id, title: t.title, artist: t.artist,
      durationMs: Number(t.duration_ms), url: `/audio/${t.filename}`,
    } : null,
    queue: q,
    serverTime: Date.now(),
  };
}

// === Zone CRUD ===

export function listZones() {
  return db.prepare("SELECT * FROM zones ORDER BY id").all().map((z) => ({
    id: Number(z.id),
    name: z.name,
    builtin: Number(z.builtin) === 1,
    created_at: Number(z.created_at),
  }));
}

export function getZone(zoneId) {
  const z = db.prepare("SELECT * FROM zones WHERE id = ?").get(zoneId);
  if (!z) return null;
  return { id: Number(z.id), name: z.name, builtin: Number(z.builtin) === 1, created_at: Number(z.created_at) };
}

export function createZone(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return { ok: false, error: "名称不能为空" };
  if (trimmed.length > 32) return { ok: false, error: "名称过长（≤32）" };
  const max = db.prepare("SELECT MAX(id) AS m FROM zones").get();
  const id = Number(max?.m ?? 0) + 1;
  const now = Date.now();
  db.prepare("INSERT INTO zones (id, name, builtin, created_at) VALUES (?, ?, 0, ?)").run(id, trimmed, now);
  db.prepare("INSERT OR IGNORE INTO playback_state (zone_id, is_playing, updated_at) VALUES (?, 0, ?)").run(id, now);
  return { ok: true, zone: { id, name: trimmed, builtin: false, created_at: now } };
}

export function renameZone(zoneId, name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return { ok: false, error: "名称不能为空" };
  if (trimmed.length > 32) return { ok: false, error: "名称过长（≤32）" };
  const z = getZone(zoneId);
  if (!z) return { ok: false, error: "分区不存在" };
  db.prepare("UPDATE zones SET name = ? WHERE id = ?").run(trimmed, zoneId);
  return { ok: true, zone: { ...z, name: trimmed } };
}

export function deleteZone(zoneId) {
  const z = getZone(zoneId);
  if (!z) return { ok: false, error: "分区不存在" };
  if (z.builtin) return { ok: false, error: "默认分区不可删除" };
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM playback_state WHERE zone_id = ?").run(zoneId);
    db.prepare("UPDATE devices SET zone_id = NULL WHERE zone_id = ?").run(zoneId);
    db.prepare("DELETE FROM zones WHERE id = ?").run(zoneId);
  });
  tx();
  clearAdvance(zoneId);
  zones.delete(zoneId);
  return { ok: true };
}

export function assignDeviceZone(deviceId, zoneId) {
  const z = getZone(zoneId);
  if (!z) return { ok: false, error: "分区不存在" };
  db.prepare("UPDATE devices SET zone_id = ? WHERE id = ?").run(zoneId, deviceId);
  _hub?.setDeviceZone(deviceId, zoneId);
  return { ok: true, zone: z };
}
