import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "data/app.db");
if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  duration_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  volume REAL NOT NULL DEFAULT 1.0,
  zone_id INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playback_state (
  zone_id INTEGER PRIMARY KEY,
  track_id TEXT,
  start_server_time INTEGER,
  track_offset_ms INTEGER NOT NULL DEFAULT 0,
  is_playing INTEGER NOT NULL DEFAULT 0,
  queue_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'sequential',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO zones (id, name, builtin, created_at) VALUES (1, '默认分区', 1, 0);
INSERT OR IGNORE INTO playback_state (zone_id, is_playing, updated_at) VALUES (1, 0, 0);
`);

// 老 db 兼容：playback_state 缺 mode 列则补上（独立 try/catch）
try { db.exec("ALTER TABLE playback_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'sequential'"); } catch {}
