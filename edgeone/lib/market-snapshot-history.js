import { historyDatabase } from './research-history.js';
import { json } from './market.js';

const MAX_ROWS = 120;
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS market_snapshot_log (
  id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  sources_json TEXT NOT NULL DEFAULT '[]',
  items_json TEXT NOT NULL DEFAULT '[]',
  analysis_json TEXT NOT NULL DEFAULT '{}'
);`;
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_market_snapshot_log_as_of ON market_snapshot_log (as_of DESC);`;

function safeText(value, fallback = '', limit = 240) {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, limit);
}

function snapshotId(asOf) {
  const stamp = safeText(asOf, new Date().toISOString(), 80).replace(/[^0-9A-Za-z_.:-]/g, '_');
  return `market-${stamp}`;
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function compactItem(item) {
  return {
    symbol: safeText(item?.symbol, '', 40),
    asset: safeText(item?.asset, '', 40),
    name: safeText(item?.name, '', 80),
    contract: safeText(item?.contract, '', 80),
    price: finite(item?.price),
    open: finite(item?.open),
    high: finite(item?.high),
    low: finite(item?.low),
    volume: finite(item?.volume),
    open_interest: finite(item?.open_interest),
    change_pct: finite(item?.change_pct),
    as_of: safeText(item?.as_of, '', 80) || null,
    provider: safeText(item?.provider, '', 80),
    source_name: safeText(item?.source_name, '', 120),
    data_mode: safeText(item?.data_mode, '', 120),
    data_label: safeText(item?.data_label, '', 120),
  };
}

function compactSource(source) {
  return {
    id: safeText(source?.id, '', 80),
    name: safeText(source?.name, '', 120),
    status: safeText(source?.status, '', 40),
    market_count: finite(source?.market_count),
    updated_at: safeText(source?.updated_at, '', 80) || null,
  };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function rowToSnapshot(row) {
  return {
    id: safeText(row?.id),
    as_of: safeText(row?.as_of),
    recorded_at: safeText(row?.recorded_at),
    status: safeText(row?.status, 'partial', 40),
    provider_count: Number(row?.provider_count || 0),
    item_count: Number(row?.item_count || 0),
    sources: parseJson(row?.sources_json, []),
    items: parseJson(row?.items_json, []),
    analysis: parseJson(row?.analysis_json, {}),
  };
}

async function ensureSchema(db) {
  await db.prepare(CREATE_TABLE).run();
  await db.prepare(CREATE_INDEX).run();
}

export async function recordMarketSnapshot(env = {}, payload = {}) {
  const db = historyDatabase(env);
  if (!db) return { status: 'not_configured', data_mode: 'persistent_market_snapshot', saved: false, message: 'D1 未绑定，未冒充已保存。' };
  const asOf = safeText(payload?.as_of || payload?.sync?.synced_at, new Date().toISOString(), 80);
  const record = {
    id: snapshotId(asOf),
    as_of: asOf,
    recorded_at: new Date().toISOString(),
    status: safeText(payload?.status, 'partial', 40),
    provider_count: Array.isArray(payload?.sources) ? payload.sources.filter((source) => source?.status === 'ok').length : 0,
    item_count: Array.isArray(payload?.items) ? payload.items.length : 0,
    sources_json: JSON.stringify((payload?.sources || []).map(compactSource).slice(0, 12)),
    items_json: JSON.stringify((payload?.items || []).map(compactItem).slice(0, 12)),
    analysis_json: JSON.stringify(payload?.analysis || {}),
  };
  try {
    await ensureSchema(db);
    await db.prepare(`INSERT OR REPLACE INTO market_snapshot_log (id, as_of, recorded_at, status, provider_count, item_count, sources_json, items_json, analysis_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(record.id, record.as_of, record.recorded_at, record.status, record.provider_count, record.item_count, record.sources_json, record.items_json, record.analysis_json).run();
    await db.prepare(`DELETE FROM market_snapshot_log WHERE id NOT IN (SELECT id FROM market_snapshot_log ORDER BY as_of DESC LIMIT ${MAX_ROWS})`).run();
    return { status: 'ok', data_mode: 'persistent_market_snapshot', saved: true, id: record.id, recorded_at: record.recorded_at };
  } catch (error) {
    return { status: 'error', data_mode: 'persistent_market_snapshot', saved: false, message: error instanceof Error ? error.message.slice(0, 180) : '快照保存失败。' };
  }
}

export async function marketSnapshotHistory({ request, env }) {
  const db = historyDatabase(env);
  if (!db) return json({ status: 'not_configured', data_mode: 'persistent_market_snapshot', count: 0, snapshots: [], message: 'D1 尚未绑定，当前仅展示实时返回，不冒充已保存。' }, 503, { 'Cache-Control': 'no-store' });
  try {
    await ensureSchema(db);
    const url = new URL(request.url);
    const requested = Number(url.searchParams.get('limit') || 12);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(30, Math.round(requested))) : 12;
    const result = await db.prepare('SELECT * FROM market_snapshot_log ORDER BY as_of DESC LIMIT ?').bind(limit).all();
    const snapshots = (result?.results || []).map(rowToSnapshot);
    const latest = snapshots[0] || null;
    const analysis = latest?.analysis || {};
    return json({ status: 'ok', data_mode: 'persistent_market_snapshot', count: snapshots.length, latest, snapshots, analysis, recording: { max_rows: MAX_ROWS, interval_hint_seconds: 30, note: '仅记录授权/公开返回值；不保存令牌、Cookie、密码或终端登录态。' } }, 200, { 'Cache-Control': 'no-store' });
  } catch {
    return json({ status: 'error', data_mode: 'persistent_market_snapshot', count: 0, snapshots: [], message: '快照历史读取失败。' }, 502, { 'Cache-Control': 'no-store' });
  }
}
