// SQLite storage. Only prepared statements are used, so user input never
// becomes part of an SQL string.
//
// The server stores as little as it can:
//  - message bodies are end-to-end encrypted envelopes it cannot read
//  - a message is deleted as soon as every recipient has synced it
//    (or after MESSAGE_RETENTION_DAYS, whichever comes first)
//  - session tokens and one-time codes are stored only as hashes

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import config from './config.js';

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

export const db = new Database(join(config.dataDir, 'haven.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('secure_delete = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  phone            TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL DEFAULT '',
  about            TEXT NOT NULL DEFAULT '',
  avatar_version   INTEGER NOT NULL DEFAULT 0,
  enc_pub          TEXT NOT NULL,
  sig_pub          TEXT NOT NULL,
  key_version      INTEGER NOT NULL DEFAULT 1,
  pin_hash         TEXT,
  pin_failures     INTEGER NOT NULL DEFAULT 0,
  pin_locked_until INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_active_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS avatars (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  title      TEXT NOT NULL DEFAULT '',
  direct_key TEXT UNIQUE,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('msg', 'system')),
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS message_recipients (
  seq     INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS recipients_seq ON message_recipients(seq);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/** Wrap a function so it runs inside a single transaction. */
export const tx = (fn) => db.transaction(fn);

export function kvGet(key) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}
export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Remove expired sessions, codes and messages. Runs periodically. */
export function cleanup() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM otp_codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM messages WHERE created_at < ?').run(now - config.messageRetentionDays * 86400_000);
  db.prepare('DELETE FROM messages WHERE NOT EXISTS (SELECT 1 FROM message_recipients r WHERE r.seq = messages.seq)').run();
}
