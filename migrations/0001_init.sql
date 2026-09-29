CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'processing', 'retry', 'completed', 'dead')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  note_json TEXT NOT NULL,
  plan_json TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  next_retry_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_due
  ON sync_jobs(status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_cleanup
  ON sync_jobs(status, updated_at);
