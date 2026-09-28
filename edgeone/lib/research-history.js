import { json } from './market.js';
import { authConfiguration, verifyPrivateSession } from './private-auth.js';

const MAX_HISTORY_ITEMS = 6;
const MAX_HISTORY_ROWS = 50;
const MAX_TEXT = 6000;
const MAX_EXCERPT = 420;

const CREATE_TABLE = `
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

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_research_history_owner_created
ON research_history (owner_scope, created_at DESC);`;

function noStore(extra = {}) {
  return { 'Cache-Control': 'no-store', Vary: 'Cookie', ...extra };
}

function text(value, fallback = '', limit = MAX_TEXT) {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, limit);
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, '', 360)).filter(Boolean).slice(0, 12);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : null;
}

function jsonText(value) {
  return JSON.stringify(list(value));
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return list(parsed);
  } catch {
    return [];
  }
}

function historyId() {
  try {
    return `research-${Date.now()}-${globalThis.crypto.randomUUID()}`;
  } catch {
    return `research-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** The existing private access-code session is the owner boundary. If the
 * platform supplies an authenticated user id, keep records separated by it. */
export function ownerScope(request) {
  const userId = text(request?.headers?.get('oai-authenticated-user-id'), '', 180);
  return userId ? `oai:${userId}` : 'private-owner';
}

export function historyDatabase(env = {}) {
  const candidates = [
    env.DB,
    env.RESEARCH_DB,
    env.D1,
    // Helpful for local Workers adapters that expose bindings as globals.
    globalThis.DB,
    globalThis.RESEARCH_DB,
  ];
  return candidates.find((candidate) => candidate && typeof candidate.prepare === 'function') || null;
}

async function ensureSchema(db) {
  await db.prepare(CREATE_TABLE).run();
  await db.prepare(CREATE_INDEX).run();
}

function rowToItem(row) {
  return {
    id: text(row?.id),
    asset: text(row?.asset, '当前品种', 80),
    source_kind: text(row?.source_kind, 'image', 24),
    source_name: text(row?.source_name, '未命名材料', 240),
    source_url: text(row?.source_url, '', 2000) || undefined,
    source_excerpt: text(row?.source_excerpt, '', MAX_EXCERPT) || undefined,
    title: text(row?.title, '持续研究记录', 240),
    conclusion: text(row?.conclusion, '未记录可确认结论'),
    facts: parseJsonList(row?.facts_json),
    signals: parseJsonList(row?.signals_json),
    scenarios: parseJsonList(row?.scenarios_json),
    risks: parseJsonList(row?.risks_json),
    missing_data: parseJsonList(row?.missing_data_json),
    confidence: numberOrNull(row?.confidence),
    next: text(row?.next_step, '补充同口径数据后继续核验'),
    provider: text(row?.provider, '', 120) || undefined,
    mode: text(row?.mode, '', 160) || undefined,
    created_at: text(row?.created_at),
    updated_at: text(row?.updated_at),
  };
}

function normalizeInput(item, asset, now) {
  const sourceUrl = text(item?.source_url || item?.url, '', 2000);
  const safeUrl = /^https?:\/\//i.test(sourceUrl) ? sourceUrl : '';
  const sourceKind = text(item?.source_kind || item?.kind, 'image', 24);
  const sourceName = text(item?.source_name || item?.file_name, '未命名材料', 240);
  return {
    id: historyId(),
    owner_scope: '',
    asset: text(item?.asset, asset, 80) || asset,
    source_kind: sourceKind === 'news' ? 'news' : sourceKind === 'url' ? 'image_url' : sourceKind === 'file' ? 'file' : 'image',
    source_name: sourceName,
    source_url: safeUrl || null,
    source_excerpt: text(item?.source_excerpt, '', MAX_EXCERPT) || null,
    title: text(item?.title, '持续研究记录', 240),
    conclusion: text(item?.conclusion, '未记录可确认结论'),
    facts_json: jsonText(item?.facts),
    signals_json: jsonText(item?.signals),
    scenarios_json: jsonText(item?.scenarios),
    risks_json: jsonText(item?.risks),
    missing_data_json: jsonText(item?.missing_data),
    confidence: numberOrNull(item?.confidence),
    next_step: text(item?.next, '补充同口径数据后继续核验'),
    provider: text(item?.provider, '', 120) || null,
    mode: text(item?.mode, '', 160) || null,
    created_at: now,
    updated_at: now,
  };
}

async function authorized(request, env) {
  const config = authConfiguration(env || {});
  if (!config.configured) {
    return { response: json({ status: 'private_auth_not_configured', message: '私有版尚未配置 PRIVATE_ACCESS_CODE。' }, 503, noStore()), auth: null };
  }
  const auth = await verifyPrivateSession(request, env || {});
  if (!auth.authorized) {
    return { response: json({ status: 'unauthorized', message: '请先登录私有版。' }, 401, noStore()), auth: null };
  }
  return { response: null, auth };
}

function databaseUnavailable() {
  return json({
    status: 'history_not_configured',
    data_mode: 'private_persistent_history',
    message: '历史库尚未绑定 D1；本次分析仍可使用，但不会冒充已保存。请确认站点已启用 DB 绑定并重新部署。',
    items: [],
  }, 503, noStore());
}

export async function onRequestGet({ request, env }) {
  const gate = await authorized(request, env);
  if (gate.response) return gate.response;
  const db = historyDatabase(env);
  if (!db) return databaseUnavailable();
  try {
    await ensureSchema(db);
    const url = new URL(request.url);
    const requested = Number(url.searchParams.get('limit') || 24);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_HISTORY_ROWS, Math.round(requested))) : 24;
    const result = await db.prepare(`SELECT * FROM research_history WHERE owner_scope = ? ORDER BY created_at DESC LIMIT ?`).bind(ownerScope(request), limit).all();
    const items = (result?.results || []).map(rowToItem);
    return json({ status: 'ok', data_mode: 'private_persistent_history', owner_scope: ownerScope(request), count: items.length, items }, 200, noStore());
  } catch {
    return json({ status: 'history_error', data_mode: 'private_persistent_history', message: '历史记录读取失败；未返回其他用户数据。', items: [] }, 502, noStore());
  }
}

export async function onRequestPost({ request, env }) {
  const gate = await authorized(request, env);
  if (gate.response) return gate.response;
  const db = historyDatabase(env);
  if (!db) return databaseUnavailable();
  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ status: 'invalid_request', message: '历史记录格式错误。' }, 400, noStore());
  }
  const asset = text(payload?.asset, '当前品种', 80);
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  if (!rawItems.length) return json({ status: 'invalid_request', message: '没有可保存的分析结果。' }, 400, noStore());
  const now = new Date().toISOString();
  const records = rawItems.slice(0, MAX_HISTORY_ITEMS).map((item) => ({ ...normalizeInput(item, asset, now), owner_scope: ownerScope(request) }));
  try {
    await ensureSchema(db);
    const statements = records.map((record) => db.prepare(`INSERT INTO research_history (id, owner_scope, asset, source_kind, source_name, source_url, source_excerpt, title, conclusion, facts_json, signals_json, scenarios_json, risks_json, missing_data_json, confidence, next_step, provider, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.id, record.owner_scope, record.asset, record.source_kind, record.source_name, record.source_url, record.source_excerpt,
      record.title, record.conclusion, record.facts_json, record.signals_json, record.scenarios_json, record.risks_json,
      record.missing_data_json, record.confidence, record.next_step, record.provider, record.mode, record.created_at, record.updated_at,
    ));
    await db.batch(statements);
    return json({ status: 'ok', data_mode: 'private_persistent_history', count: records.length, items: records.map((record) => rowToItem(record)) }, 201, noStore());
  } catch {
    return json({ status: 'history_error', data_mode: 'private_persistent_history', message: '历史记录保存失败；原图和原文件不会因此被保存。' }, 502, noStore());
  }
}

export async function onRequestDelete({ request, env }) {
  const gate = await authorized(request, env);
  if (gate.response) return gate.response;
  const db = historyDatabase(env);
  if (!db) return databaseUnavailable();
  const url = new URL(request.url);
  const id = text(url.searchParams.get('id'), '', 180);
  try {
    await ensureSchema(db);
    const result = id
      ? await db.prepare(`DELETE FROM research_history WHERE id = ? AND owner_scope = ?`).bind(id, ownerScope(request)).run()
      : await db.prepare(`DELETE FROM research_history WHERE owner_scope = ?`).bind(ownerScope(request)).run();
    return json({ status: 'ok', deleted: Number(result?.meta?.changes || 0), message: id ? '已删除该研究记录。' : '已清除本人研究记录。' }, 200, noStore());
  } catch {
    return json({ status: 'history_error', message: '历史记录删除失败。' }, 502, noStore());
  }
}
