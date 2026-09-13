/**
 * Persistent research records for the private, owner-only workbench.
 * Raw uploads are deliberately not stored here; only compact, auditable
 * source metadata and the model's structured findings are retained.
 */
export const researchHistoryTableSql = `
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
);`;

export const researchHistoryIndexSql = `
CREATE INDEX IF NOT EXISTS idx_research_history_owner_created
ON research_history (owner_scope, created_at DESC);`;

export const researchHistorySchema = {
  table: 'research_history',
  columns: [
    'id', 'owner_scope', 'asset', 'source_kind', 'source_name', 'source_url',
    'source_excerpt', 'title', 'conclusion', 'facts_json', 'signals_json',
    'scenarios_json', 'risks_json', 'missing_data_json', 'confidence',
    'next_step', 'provider', 'mode', 'created_at', 'updated_at',
  ] as const,
};
