CREATE TABLE IF NOT EXISTS visitor_daily_stats (
  day TEXT PRIMARY KEY,
  page_views INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visitor_daily_stats_day
ON visitor_daily_stats (day DESC);

CREATE TABLE IF NOT EXISTS visitor_daily_keys (
  day TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (day, visitor_hash)
);

CREATE INDEX IF NOT EXISTS idx_visitor_daily_keys_day
ON visitor_daily_keys (day);
