import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL CHECK (status IN ('RECEIVED', 'ANALYZING', 'DONE', 'FAILED')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status);

-- One row per analysis attempt. raw_response is exactly what the model returned
-- (NULL when the request itself failed); result_json is set only when that
-- response passed schema validation.
CREATE TABLE IF NOT EXISTS analysis_attempts (
  id           TEXT PRIMARY KEY,
  feedback_id  TEXT NOT NULL REFERENCES feedback (id),
  attempt      INTEGER NOT NULL,
  model        TEXT NOT NULL,
  raw_response TEXT,
  result_json  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (feedback_id, attempt),
  CHECK ((result_json IS NULL) <> (error IS NULL))
);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // SQLite's built-in lower() only folds ASCII; this one is Unicode-aware.
  db.function('unicode_lower', { deterministic: true }, (value) => (typeof value === 'string' ? value.toLowerCase() : value));
  db.exec(SCHEMA);
  return db;
}
