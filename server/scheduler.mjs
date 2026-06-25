import { db } from "./db.mjs";

const ZONE = 1;
const PRELOAD_MS = 800;

const _broadcasters = new Set();
let _hub = null;

export function setHub(hub) {
  _hub = hub;
}

let advanceTimer = null;

export function getState() {
  return db.prepare("SELECT * FROM playback_state WHERE zone_id = ?").get(ZONE);
}

export function getQueue() {
  try {
    return JSON.parse(getState().queue_json);
  } catch {
    return [];
  }
}

export function setQueue(queue) {
  db.prepare("UPDATE playback_state SET queue_json = ?, updated_at = ? WHERE zone_id = ?")
    .run(JSON.stringify(queue), Date.now(), ZONE);
}

function getTrack(trackId) {
  return db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
}

function clearAdvance() {
  if (advanceTimer) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

function scheduleAdvance(durationMs, startServerTime, offsetMs) {
  clearAdvance();
  const remain = durationMs - offsetMs - (Date.now() - startServerTime);
  if (remain <= 0) return;
  advanceTimer = setTimeout(() => next(), remain + 200);
}

export function play(trackId, offsetMs = 0) {
  const t = getTrack(trackId);
  if (!t) return { ok: false, error: "曲目不存在" };
  const startServerTime = Date.now() + PRELOAD_MS;
  db.prepare(`UPDATE playback_state
    SET track_id = ?, start_server_time = ?, track_offset_ms = ?,
        is_playing = 1, updated_at = ? WHERE zone_id = ?`)
    .run(t.id, startServerTime, offsetMs, Date.now(), ZONE);

  _hub?.broadcast({
    type: "play",
    trackId: t.id,
    trackUrl: `/audio/${t.filename}`,
    durationMs: Number(t.duration_ms),
    startServerTime,
    trackOffsetMs: offsetMs,
  });
  scheduleAdvance(Number(t.duration_ms), startServerTime, offsetMs);
  return { ok: true, startServerTime };
}

export function pause() {
  const s = getState();
  if (!s.track_id || !s.is_playing) return { ok: true };
  const atServerTime = Date.now() + 200;
  const playedMs = Number(s.track_offset_ms) + (atServerTime - Number(s.start_server_time ?? atServerTime));
  db.prepare(`UPDATE playback_state SET is_playing = 0, track_offset_ms = ?, start_server_time = NULL, updated_at = ? WHERE zone_id = ?`)
    .run(Math.max(0, playedMs), Date.now(), ZONE);
  clearAdvance();
  _hub?.broadcast({ type: "pause", atServerTime });
  return { ok: true };
}

export function resume() {
  const s = getState();
  if (!s.track_id) return { ok: false, error: "没有曲目" };
  return play(s.track_id, Number(s.track_offset_ms));
}

export function stop() {
  db.prepare(`UPDATE playback_state SET is_playing = 0, track_id = NULL, start_server_time = NULL, track_offset_ms = 0, updated_at = ? WHERE zone_id = ?`)
    .run(Date.now(), ZONE);
  clearAdvance();
  _hub?.broadcast({ type: "stop" });
  return { ok: true };
}

export function seek(offsetMs) {
  const s = getState();
  if (!s.track_id) return { ok: false, error: "没有曲目" };
  return play(s.track_id, Math.max(0, offsetMs));
}

export function next() {
  const q = getQueue();
  if (q.length === 0) return stop();
  const [head, ...rest] = q;
  setQueue(rest);
  return play(head, 0);
}

export function enqueue(trackIds) {
  setQueue([...getQueue(), ...trackIds]);
  const s = getState();
  if (!s.is_playing && !s.track_id) return next();
  return { ok: true };
}

export function clearQueue() {
  setQueue([]);
  return { ok: true };
}

export function snapshot() {
  const s = getState();
  const q = getQueue();
  const t = s.track_id ? getTrack(s.track_id) : null;
  return {
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
