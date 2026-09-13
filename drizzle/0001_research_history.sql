CREATE TABLE IF NOT EXISTS research_history (
  id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  asset TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  source_excerpt TEXT,
  title TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  signals_json TEXT NOT NULL DEFAULT '[]',
  scenarios_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  missing_data_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER,
  next_step TEXT NOT NULL DEFAULT '',
  provider TEXT,
  mode TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_history_owner_created
ON research_history (owner_scope, created_at DESC);
