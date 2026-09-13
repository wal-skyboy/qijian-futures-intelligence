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

/** Ordinary visitor accounts use a separate namespace from the owner-only
 * CTP session. OTP hashes and session hashes are persisted in D1; plaintext
 * phone numbers are only retained as the normalized login identifier. */
export const publicAuthSchemaSql = `
CREATE TABLE IF NOT EXISTS public_users (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_users_phone
ON public_users (phone_e164);

CREATE TABLE IF NOT EXISTS sms_challenges (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  last_sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sms_challenges_phone_created
ON sms_challenges (phone_e164, created_at DESC);

CREATE TABLE IF NOT EXISTS public_user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_user_sessions_user_expires
ON public_user_sessions (user_id, expires_at DESC);`;

export const publicAuthSchema = {
  tables: ['public_users', 'sms_challenges', 'public_user_sessions'] as const,
  userColumns: ['id', 'phone_e164', 'status', 'created_at', 'last_login_at', 'updated_at'] as const,
  challengeColumns: ['id', 'phone_e164', 'code_hash', 'expires_at', 'attempts', 'consumed_at', 'last_sent_at', 'created_at'] as const,
  sessionColumns: ['token_hash', 'user_id', 'expires_at', 'created_at', 'last_seen_at'] as const,
};
