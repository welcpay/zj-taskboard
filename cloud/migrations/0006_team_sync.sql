CREATE TABLE team_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE team_access_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE team_change_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0)
);

INSERT INTO team_change_sequence (singleton, sequence) VALUES (1, 0);

CREATE TABLE team_entity_revisions (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  snapshot TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE team_changes (
  sequence INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation_type TEXT NOT NULL,
  snapshot TEXT,
  actor_id TEXT NOT NULL REFERENCES team_users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE team_operation_receipts (
  user_id TEXT NOT NULL REFERENCES team_users(id),
  idempotency_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE task_branches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'comment', 'attachment')),
  entity_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  current_main_revision INTEGER NOT NULL,
  proposed_revision INTEGER NOT NULL,
  base_snapshot TEXT NOT NULL,
  main_snapshot TEXT NOT NULL,
  branch_snapshot TEXT NOT NULL,
  change_json TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES team_users(id),
  device_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'kept_main', 'promoted', 'merged')),
  resolution_snapshot TEXT,
  resolved_by TEXT REFERENCES team_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX task_branches_task_state ON task_branches(task_id, state, created_at, id);

CREATE TABLE task_branch_revisions (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES task_branches(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES team_users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE team_update_artifacts (
  version TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  published_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

CREATE UNIQUE INDEX team_update_artifacts_one_active ON team_update_artifacts(active) WHERE active = 1;

ALTER TABLE attachments ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
