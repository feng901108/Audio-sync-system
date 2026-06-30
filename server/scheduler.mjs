import { db } from "./db.mjs";

export const PRELOAD_MS = 1500;        // 基础预留时间（毫秒），A7 可被加载耗时动态拉高
const DEFAULT_ZONE = 1;

let _hub = null;
export function setHub(hub) { _hub = hub; }

// 动态 PRELOAD_MS：记录每个 device 最近一次 metadata 加载耗时，play 时按 zone 内最慢设备拉长
const loadedMsByDevice = new Map(); // deviceId -> loadedMs

export function recordLoadedMs(deviceId, ms) {
  if (!deviceId || !Number.isFinite(ms) || ms <= 0) return;
  loadedMsByDevice.set(deviceId, ms);
}

// 按当前 zone 内活跃设备的最大 loadedMs 决定本次 play 预留时间：
// loadedMs 越大的设备 metadata 加载越慢，预留必须留够 buffer × 2 + 500ms 余量
export function getEffectivePreloadMs(zoneId) {
  const base = PRELOAD_MS;
  if (!_hub) return base;
  let maxLoaded = 0;
  for (const id of _hub.onlineDeviceIdsInZone(zoneId)) {
    const m = loadedMsByDevice.get(id);
    if (m && m > maxLoaded) maxLoaded = m;
  }
  return Math.max(base, Math.round(maxLoaded * 2) + 500);
}

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
  if (!durationMs || durationMs <= 0) return; // duration 未知时不自动 advance，由前端 onended 或 admin 手动切
  const remain = durationMs - offsetMs - (Date.now() - startServerTime);
  if (remain <= 0) return;
  zoneState(zoneId).advanceTimer = setTimeout(() => next(zoneId), remain + 50);
}

export function play(zoneId, trackId, offsetMs = 0) {
  if (trackId === undefined) { trackId = zoneId; zoneId = DEFAULT_ZONE; } // 兼容 play(trackId, offset)
  const t = getTrack(trackId);
  if (!t) return { ok: false, error: "曲目不存在" };
  // 动态 PRELOAD_MS：按 zone 内最慢设备的 metadata 加载耗时拉长，确保所有设备都有足够 buffer 时间
  const effectivePreload = getEffectivePreloadMs(zoneId);
  const startServerTime = Date.now() + effectivePreload;
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
  const cur = getRow(zoneId);
  const q = getQueue(zoneId);
  const mode = cur.mode || "sequential";
  // 单曲循环：重置进度，重播当前曲（scheduleAdvance 到期调 next 时也走这里）
  if (mode === "loop-one" && cur.track_id) {
    return play(zoneId, cur.track_id, 0);
  }
  // 随机：从队列里排除当前曲随机选一首，弹出播放（队列逐渐空，和 sequential 一致）
  if (mode === "shuffle") {
    const candidates = cur.track_id ? q.filter((id) => id !== cur.track_id) : q.slice();
    if (candidates.length === 0) {
      return stop(zoneId); // 队列播完即停，不重播当前（否则单曲死循环）
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    setQueue(zoneId, q.filter((id) => id !== pick));
    return play(zoneId, pick, 0);
  }
  // queue 里去掉当前正在播的歌（避免 next 重播当前歌）
  const upcoming = cur.track_id ? q.filter((id) => id !== cur.track_id) : q;
  if (upcoming.length === 0) {
    if (mode === "loop-all" && cur.track_id) {
      // queue 里只有当前 track，循环模式下重新开始播当前 track（重置进度）
      return play(zoneId, cur.track_id, 0);
    }
    return stop(zoneId);
  }
  // 播 upcoming 的第一首；后续行为看模式
  const head = upcoming[0];
  const rest = upcoming.slice(1);
  if (mode === "loop-all") {
    // 把当前播的歌放到队尾（保证循环完整）
    setQueue(zoneId, cur.track_id ? [...rest, cur.track_id] : rest);
  } else {
    // sequential / loop-one：弹出 head（rest 不含 head）
    setQueue(zoneId, rest);
  }
  return play(zoneId, head, 0);
}

export function prev(zoneId = DEFAULT_ZONE) {
  const cur = getRow(zoneId);
  if (!cur.track_id) return { ok: false, error: "没有曲目" };
  const q = getQueue(zoneId);
  const idx = q.indexOf(cur.track_id);
  if (idx > 0) return play(zoneId, q[idx - 1], 0); // 队列里当前的前一首
  return play(zoneId, cur.track_id, 0); // 已是队首或不在队列：重播当前
}

export function setMode(zoneId, mode) {
  if (!["sequential", "loop-one", "shuffle", "loop-all"].includes(mode)) {
    return { ok: false, error: "非法 mode" };
  }
  const s = getRow(zoneId);
  if (!s) return { ok: false, error: "分区不存在" };
  db.prepare("UPDATE playback_state SET mode = ?, updated_at = ? WHERE zone_id = ?").run(mode, Date.now(), zoneId);
  return { ok: true, mode };
}

export function getMode(zoneId = DEFAULT_ZONE) {
  const s = getRow(zoneId);
  return s?.mode || "sequential";
}

export function enqueue(zoneId, trackIds) {
  if (!Array.isArray(trackIds)) { trackIds = zoneId; zoneId = DEFAULT_ZONE; } // 兼容 enqueue(arr)
  setQueue(zoneId, [...getQueue(zoneId), ...trackIds]);
  // 注意：enqueue 只追加到队尾，不自动播放。
  // 如需"加入队列并立即播放队首"应调 play(zoneId, trackIds[0])。
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
    mode: s.mode || "sequential",
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
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM playback_state WHERE zone_id = ?").run(zoneId);
    db.prepare("UPDATE devices SET zone_id = NULL WHERE zone_id = ?").run(zoneId);
    db.prepare("DELETE FROM zones WHERE id = ?").run(zoneId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
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

// === Playlist CRUD ===

export function listPlaylists() {
  return db.prepare("SELECT * FROM playlists ORDER BY id").all().map((p) => {
    const count = db.prepare("SELECT COUNT(*) AS c FROM playlist_tracks WHERE playlist_id = ?").get(p.id).c;
    return {
      id: Number(p.id),
      name: p.name,
      builtin: Number(p.builtin) === 1,
      trackCount: Number(count),
      created_at: Number(p.created_at),
    };
  });
}

export function getPlaylist(id) {
  const p = db.prepare("SELECT * FROM playlists WHERE id = ?").get(id);
  if (!p) return null;
  return {
    id: Number(p.id),
    name: p.name,
    builtin: Number(p.builtin) === 1,
    created_at: Number(p.created_at),
  };
}

export function createPlaylist(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return { ok: false, error: "名称不能为空" };
  if (trimmed.length > 32) return { ok: false, error: "名称过长（≤32）" };
  const max = db.prepare("SELECT MAX(id) AS m FROM playlists").get();
  const id = Number(max?.m ?? 0) + 1;
  const now = Date.now();
  db.prepare("INSERT INTO playlists (id, name, builtin, created_at) VALUES (?, ?, 0, ?)").run(id, trimmed, now);
  return { ok: true, playlist: { id, name: trimmed, builtin: false, created_at: now } };
}

export function renamePlaylist(id, name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return { ok: false, error: "名称不能为空" };
  if (trimmed.length > 32) return { ok: false, error: "名称过长（≤32）" };
  const p = getPlaylist(id);
  if (!p) return { ok: false, error: "歌单不存在" };
  db.prepare("UPDATE playlists SET name = ? WHERE id = ?").run(trimmed, id);
  return { ok: true, playlist: { ...p, name: trimmed } };
}

export function deletePlaylist(id) {
  const p = getPlaylist(id);
  if (!p) return { ok: false, error: "歌单不存在" };
  if (p.builtin) return { ok: false, error: "内置歌单不可删除" };
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").run(id);
    db.prepare("DELETE FROM playlists WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { ok: true };
}

export function listPlaylistTracks(playlistId) {
  return db.prepare(
    `SELECT pt.track_id, pt.position, pt.added_at,
            t.title, t.artist, t.duration_ms, t.filename
     FROM playlist_tracks pt
     JOIN tracks t ON t.id = pt.track_id
     WHERE pt.playlist_id = ?
     ORDER BY pt.position, pt.added_at`
  ).all(playlistId).map((r) => ({
    id: r.track_id,
    title: r.title,
    artist: r.artist,
    duration_ms: Number(r.duration_ms),
    filename: r.filename,
    position: Number(r.position),
  }));
}

export function addTracksToPlaylist(playlistId, trackIds) {
  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    return { ok: false, error: "trackIds 必须是非空数组" };
  }
  const p = getPlaylist(playlistId);
  if (!p) return { ok: false, error: "歌单不存在" };
  // 取当前最大 position，追加在末尾
  const max = db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?").get(playlistId);
  let pos = Number(max?.m ?? -1) + 1;
  const now = Date.now();
  const insert = db.prepare("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)");
  let added = 0;
  db.exec("BEGIN");
  try {
    for (const tid of trackIds) {
      if (!getTrack(tid)) continue; // 跳过不存在的曲目
      const r = insert.run(playlistId, tid, pos++, now);
      if (r.changes > 0) added++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { ok: true, added };
}

export function removeTrackFromPlaylist(playlistId, trackId) {
  const r = db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?").run(playlistId, trackId);
  return { ok: true, removed: r.changes };
}

// 用歌单批量替换分区队列
export function loadPlaylistToQueue(zoneId, playlistId) {
  const p = getPlaylist(playlistId);
  if (!p) return { ok: false, error: "歌单不存在" };
  const tracks = listPlaylistTracks(playlistId);
  setQueue(zoneId, tracks.map((t) => t.id));
  // 切到队列第一首
  if (tracks.length > 0) {
    return play(zoneId, tracks[0].id, 0);
  }
  return { ok: true, queue: [] };
}
