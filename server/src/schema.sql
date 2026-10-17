-- Newtonite Ops schema. All timestamps are ISO-8601 UTC strings with millisecond precision,
-- which sort lexicographically in time order.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  key  TEXT NOT NULL UNIQUE           -- short prefix used in display keys, e.g. PAY-123
);

-- A user can belong to many teams with a different role in each.
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  role    TEXT NOT NULL CHECK (role IN ('viewer', 'member', 'lead')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS memberships_team ON memberships(team_id, role);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,         -- sha256 of the cookie value; raw token never stored
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id                INTEGER PRIMARY KEY,
  team_id           INTEGER NOT NULL REFERENCES teams(id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  kind              TEXT NOT NULL CHECK (kind IN ('incident','customer','payment','engineering','compliance','task')),
  priority          INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),   -- 1 = P1 (most urgent)
  status            TEXT NOT NULL CHECK (status IN ('open','in_progress','blocked','pending_approval','resolved','closed','cancelled')),
  assignee_id       INTEGER REFERENCES users(id),
  reporter_id       INTEGER NOT NULL REFERENCES users(id),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_by       INTEGER REFERENCES users(id),
  approved_at       TEXT,
  due_at            TEXT,
  version           INTEGER NOT NULL DEFAULT 1,  -- optimistic-concurrency token, bumped on every field change
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_activity_at  TEXT NOT NULL,               -- includes comments; drives "stale" detection and default sort
  resolved_at       TEXT
);
CREATE INDEX IF NOT EXISTS items_team_activity   ON work_items(team_id, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS items_team_status_pri ON work_items(team_id, status, priority, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS items_assignee_status ON work_items(assignee_id, status);
CREATE INDEX IF NOT EXISTS items_status_due      ON work_items(status, due_at);
CREATE INDEX IF NOT EXISTS items_activity        ON work_items(last_activity_at DESC, id DESC);

-- Full-text search over title + description (external-content FTS5 table kept in sync by triggers).
CREATE VIRTUAL TABLE IF NOT EXISTS work_items_fts USING fts5(
  title, description, content='work_items', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS work_items_ai AFTER INSERT ON work_items BEGIN
  INSERT INTO work_items_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;
CREATE TRIGGER IF NOT EXISTS work_items_ad AFTER DELETE ON work_items BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
END;
CREATE TRIGGER IF NOT EXISTS work_items_au AFTER UPDATE OF title, description ON work_items BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
  INSERT INTO work_items_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;

-- Append-only history. Every state change and every comment is an event; nothing is updated or deleted.
CREATE TABLE IF NOT EXISTS item_events (
  id           INTEGER PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  actor_id     INTEGER REFERENCES users(id),   -- NULL for system events
  type         TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}',     -- JSON payload (field diffs, notes, comment body...)
  item_version INTEGER NOT NULL,               -- item version after this event
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS item_events_item ON item_events(work_item_id, id);

-- Idempotency: (user, key) -> stored successful response. Written in the same transaction as the effect.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id       INTEGER NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency_keys(created_at);

-- Transactional outbox / job queue. Jobs are inserted in the same transaction as the change that caused them.
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after    TEXT NOT NULL,
  locked_by    TEXT,
  locked_until TEXT,
  last_error   TEXT,
  dedupe_key   TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  event_id     INTEGER NOT NULL REFERENCES item_events(id),
  message      TEXT NOT NULL,
  read_at      TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (user_id, event_id)                   -- makes the notification job idempotent
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(user_id, read_at);
