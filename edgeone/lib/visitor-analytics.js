import { json } from './market.js';
import { historyDatabase } from './research-history.js';
import { verifyPrivateSession } from './private-auth.js';

/**
 * Privacy-first visitor measurement.
 *
 * The browser sends a random, device-local identifier only after the visitor
 * opts in. The database stores an HMAC of that identifier scoped to the
 * Beijing calendar day, never the raw identifier, IP address or user agent.
 * Daily aggregates and scoped hashes are retained for a bounded period.
 */
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 365;
const MAX_VISITOR_ID_LENGTH = 128;

const CREATE_STATS_TABLE = `
CREATE TABLE IF NOT EXISTS visitor_daily_stats (
  day TEXT PRIMARY KEY,
  page_views INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);`;

const CREATE_STATS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_visitor_daily_stats_day
ON visitor_daily_stats (day DESC);`;

const CREATE_KEYS_TABLE = `
CREATE TABLE IF NOT EXISTS visitor_daily_keys (
  day TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (day, visitor_hash)
);`;

const CREATE_KEYS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_visitor_daily_keys_day
ON visitor_daily_keys (day);`;

function envValue(env, keys, fallback = '') {
  for (const key of keys) {
    const value = env?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return fallback;
}

function numberValue(env, keys, fallback, minimum, maximum) {
  const raw = envValue(env, keys);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function analyticsSecret(env) {
  return envValue(env, ['VISITOR_ANALYTICS_SECRET']);
}

export function analyticsConfiguration(env = {}) {
  return {
    configured: Boolean(analyticsSecret(env)),
    retention_days: numberValue(env, ['VISITOR_RETENTION_DAYS'], DEFAULT_RETENTION_DAYS, 7, MAX_RETENTION_DAYS),
  };
}

function database(env = {}) {
  return historyDatabase(env);
}

function noStore(extra = {}) {
  return { 'Cache-Control': 'no-store', ...extra };
}

function nowIso() {
  return new Date().toISOString();
}

function beijingDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function shiftDay(day, offset) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function normalizeVisitorId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > MAX_VISITOR_ID_LENGTH) return '';
  return /^[A-Za-z0-9._~-]+$/.test(id) ? id : '';
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(value, secret) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(signature));
}

async function ensureSchema(db) {
  await db.prepare(CREATE_STATS_TABLE).run();
  await db.prepare(CREATE_STATS_INDEX).run();
  await db.prepare(CREATE_KEYS_TABLE).run();
  await db.prepare(CREATE_KEYS_INDEX).run();
}

function originAllowed(request) {
  const origin = request?.headers?.get('origin');
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function originHeaders(request) {
  const origin = request?.headers?.get('origin');
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

function unavailable(status, message) {
  return json({ status, tracked: false, message }, 503, noStore());
}

async function cleanup(db, day, retentionDays) {
  const cutoff = shiftDay(day, -retentionDays);
  await db.prepare('DELETE FROM visitor_daily_keys WHERE day < ?').bind(cutoff).run();
  await db.prepare('DELETE FROM visitor_daily_stats WHERE day < ?').bind(cutoff).run();
}

function countValue(row, key) {
  const value = Number(row?.[key] || 0);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function mapDailyRow(row) {
  return {
    day: String(row?.day || ''),
    page_views: countValue(row, 'page_views'),
    unique_visitors: countValue(row, 'unique_visitors'),
    updated_at: row?.updated_at || null,
  };
}

function sumRows(rows, key) {
  return rows.reduce((sum, row) => sum + countValue(row, key), 0);
}

export async function recordVisitorPost({ request, env }) {
  const environment = env || {};
  const config = analyticsConfiguration(environment);
  if (!config.configured) return unavailable('visitor_analytics_not_configured', '匿名统计尚未配置。');
  if (!originAllowed(request)) return json({ status: 'origin_not_allowed', tracked: false, message: '请求来源未被允许。' }, 403, noStore());
  const db = database(environment);
  if (!db) return unavailable('visitor_analytics_database_not_configured', '匿名统计数据库尚未绑定。');

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ status: 'invalid_request', tracked: false, message: '统计请求格式错误。' }, 400, noStore());
  }
  if (payload?.consent !== true) return json({ status: 'consent_required', tracked: false, message: '只有明确同意后才会统计。' }, 400, noStore());
  const visitorId = normalizeVisitorId(payload?.visitor_id);
  if (!visitorId) return json({ status: 'invalid_visitor_id', tracked: false, message: '匿名标识格式错误。' }, 400, noStore());

  const day = beijingDay();
  const now = nowIso();
  try {
    await ensureSchema(db);
    const visitorHash = await hmacHex(`visitor:${day}:${visitorId}`, analyticsSecret(environment));
    await db.prepare(`
      INSERT INTO visitor_daily_stats (day, page_views, unique_visitors, updated_at)
      VALUES (?, 1, 0, ?)
      ON CONFLICT(day) DO UPDATE SET
        page_views = visitor_daily_stats.page_views + 1,
        updated_at = excluded.updated_at
    `).bind(day, now).run();
    const inserted = await db.prepare('INSERT OR IGNORE INTO visitor_daily_keys (day, visitor_hash, created_at) VALUES (?, ?, ?)').bind(day, visitorHash, now).run();
    if (Number(inserted?.meta?.changes || 0) > 0) {
      await db.prepare('UPDATE visitor_daily_stats SET unique_visitors = unique_visitors + 1, updated_at = ? WHERE day = ?').bind(now, day).run();
    }
    await cleanup(db, day, config.retention_days);
    return json({ status: 'ok', tracked: true, retention_days: config.retention_days }, 200, noStore(originHeaders(request)));
  } catch {
    return json({ status: 'visitor_analytics_error', tracked: false, message: '匿名统计暂时不可用。' }, 502, noStore());
  }
}

export async function onRequestSummary({ request, env }) {
  const environment = env || {};
  const auth = await verifyPrivateSession(request, environment);
  if (!auth.configured) return json({ status: 'private_auth_not_configured', message: '私有版尚未配置。' }, 503, noStore());
  if (!auth.authorized) return json({ status: 'unauthorized', message: '请先登录私有版。' }, 401, noStore({ Vary: 'Cookie' }));
  const config = analyticsConfiguration(environment);
  if (!config.configured) return unavailable('visitor_analytics_not_configured', '匿名统计尚未配置。');
  const db = database(environment);
  if (!db) return unavailable('visitor_analytics_database_not_configured', '匿名统计数据库尚未绑定。');
  const day = beijingDay();
  try {
    await ensureSchema(db);
    await cleanup(db, day, config.retention_days);
    const rowsResult = await db.prepare('SELECT day, page_views, unique_visitors, updated_at FROM visitor_daily_stats ORDER BY day DESC LIMIT 31').all();
    const rows = (rowsResult?.results || []).map(mapDailyRow);
    const today = rows.find((row) => row.day === day) || { day, page_views: 0, unique_visitors: 0, updated_at: null };
    const sevenDays = rows.filter((row) => row.day >= shiftDay(day, -6));
    const thirtyDays = rows.filter((row) => row.day >= shiftDay(day, -29));
    return json({
      status: 'ok',
      data_mode: 'anonymous_aggregate',
      retention_days: config.retention_days,
      as_of: nowIso(),
      today,
      last_7_days: { page_views: sumRows(sevenDays, 'page_views'), daily_unique_visitors: sumRows(sevenDays, 'unique_visitors') },
      last_30_days: { page_views: sumRows(thirtyDays, 'page_views'), daily_unique_visitors: sumRows(thirtyDays, 'unique_visitors') },
      daily: rows,
    }, 200, noStore({ Vary: 'Cookie' }));
  } catch {
    return json({ status: 'visitor_analytics_error', message: '匿名统计汇总读取失败。' }, 502, noStore({ Vary: 'Cookie' }));
  }
}

export {
  CREATE_KEYS_INDEX,
  CREATE_KEYS_TABLE,
  CREATE_STATS_INDEX,
  CREATE_STATS_TABLE,
  beijingDay,
  normalizeVisitorId,
  shiftDay,
};
