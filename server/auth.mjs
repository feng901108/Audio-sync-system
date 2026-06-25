import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.mjs";

const SCRYPT_N = 16384;
const KEYLEN = 32;

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, nStr, saltHex, keyHex] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const N = Number(nStr);
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex, "hex");
    const got = scryptSync(plain, salt, expected.length, { N });
    return timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

export function findAdminByUsername(username) {
  return db
    .prepare("SELECT * FROM admins WHERE username = ?")
    .get(username);
}

export function createAdmin(username, password) {
  const hash = hashPassword(password);
  const now = Date.now();
  const info = db
    .prepare("INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)")
    .run(username, hash, now);
  return { id: Number(info.lastInsertRowid), username, password_hash: hash, created_at: now };
}

export function adminCount() {
  const r = db.prepare("SELECT COUNT(*) AS c FROM admins").get();
  return Number(r?.c ?? 0);
}

export function createSession(admin) {
  const sid = randomBytes(24).toString("hex");
  const now = Date.now();
  const expires = now + 7 * 24 * 3600 * 1000;
  db.prepare(
    "INSERT INTO sessions (sid, admin_id, username, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sid, admin.id, admin.username, now, expires);
  return { sid, expires };
}

export function getSession(sid) {
  if (!sid) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE sid = ?").get(sid);
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
    return null;
  }
  return row;
}

export function destroySession(sid) {
  if (sid) db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
}
