import { domesticDelayedBoard } from './domestic.js';

const CACHE_TTL_MS = 30_000;
// Keep the aggregate public-source endpoint responsive even when an optional
// authorised feed or exchange site is unavailable. Provider results are
// labelled individually, so a short timeout is safer than stale data or a
// request that appears to hang in the dashboard.
const DEFAULT_TIMEOUT_MS = 1600;
const MAX_TIMEOUT_MS = 2500;
const THS_API_URL = 'https://quantapi.51ifind.com/api/v1/real_time_quotation';
const THS_DOCS_URL = 'https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html';
const THS_PUBLIC_URL = 'https://futures.10jqka.com.cn/';
const EASTMONEY_DOCS_URL = 'https://quantapi.eastmoney.com/';
const EASTMONEY_PUBLIC_URL = 'https://futures.eastmoney.com/';

const CONTRACTS = [
  { symbol: 'au', asset: '黄金', name: '沪金', contract: 'AU主连', ths: 'AU.SHF', choice: 'AU0.SHF', aliases: ['au', 'au.shf', '沪金', '黄金', 'gold'] },
  { symbol: 'ag', asset: '白银', name: '沪银', contract: 'AG主连', ths: 'AG.SHF', choice: 'AG0.SHF', aliases: ['ag', 'ag.shf', '沪银', '白银', 'silver'] },
  { symbol: 'cu', asset: '铜', name: '沪铜', contract: 'CU主连', ths: 'CU.SHF', choice: 'CU0.SHF', aliases: ['cu', 'cu.shf', '沪铜', '铜', 'copper'] },
  { symbol: 'sn', asset: '锡', name: '沪锡', contract: 'SN主连', ths: 'SN.SHF', choice: 'SN0.SHF', aliases: ['sn', 'sn.shf', '沪锡', '锡', 'tin'] },
  { symbol: 'sc', asset: '原油', name: '原油', contract: 'SC主连', ths: 'SC.INE', choice: 'SC0.INE', aliases: ['sc', 'sc.ine', '原油', '上海原油', 'crude', 'oil'] },
];

const SOURCE_INFO = {
  ths_ifind: {
    id: 'ths_ifind', name: '同花顺 iFinD', kind: 'market+news', mode: 'official_authorized_api',
    tokenKeys: ['THS_IFIND_ACCESS_TOKEN', 'THS_ACCESS_TOKEN'], urlKey: 'THS_IFIND_API_URL', feedKey: 'THS_NEWS_FEED_URL',
    docs_url: THS_DOCS_URL, public_url: THS_PUBLIC_URL,
  },
  eastmoney_choice: {
    id: 'eastmoney_choice', name: '东方财富 Choice', kind: 'market+news', mode: 'official_authorized_api',
    tokenKeys: ['EASTMONEY_CHOICE_TOKEN', 'CHOICE_ACCESS_TOKEN'], urlKey: 'EASTMONEY_CHOICE_API_URL', feedKey: 'EASTMONEY_NEWS_FEED_URL',
    docs_url: EASTMONEY_DOCS_URL, public_url: EASTMONEY_PUBLIC_URL,
  },
};

let cached = { key: '', expiresAt: 0, payload: null };

function providerTimeout(env) {
  const requested = Number(env?.CHINA_SOURCE_TIMEOUT_MS);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(requested), 500), MAX_TIMEOUT_MS);
}

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Choice has two separate failure modes that used to look identical in the
 * dashboard: a malformed request/code and a valid request made by an account
 * without the CSQ/CSQS real-time entitlement.  Keep the provider response
 * structured so the UI can tell the user what to fix without exposing a
 * token or making an unverified claim about the account.
 */
function classifyChoiceFailure(code, message, httpStatus = null) {
  const codeText = text(code);
  const messageText = text(message);
  const statusText = Number.isFinite(Number(httpStatus)) ? String(httpStatus) : '';
  const combined = `${codeText} ${messageText} ${statusText}`.toLowerCase();
  const displayCode = codeText || (statusText ? `HTTP ${statusText}` : null);

  if (/401|unauthori[sz]ed|invalid token|token expired|令牌无效|令牌过期/.test(combined)) {
    return {
      error_code: displayCode || 'HTTP 401',
      error_kind: 'authentication_error',
      message: `Choice 令牌认证失败${displayCode ? `（${displayCode}）` : ''}。`,
      next_step: '在 Choice 控制台重新生成有效令牌，并仅在服务端密钥环境中更新后重试。',
    };
  }
  if (/10001012|10000012|insufficient[\s_-]*user[\s_-]*access|no access|not authorized|forbidden|权限不足|未开通|无权|未授权|没有权限/.test(combined)) {
    return {
      error_code: displayCode || '10001012',
      error_kind: 'insufficient_user_access',
      message: `Choice 期货实时快照权限不足${displayCode ? `（${displayCode}）` : ''}；登录链路正常，但当前账号未获 CSQ/CSQS 实时行情授权。`,
      next_step: '在 Choice 账户申请/开通期货实时行情权限，并确认 AU0.SHF、AG0.SHF 等合约包含在授权范围内。',
    };
  }
  if (/10003008|invalid[\s_-]*(stock|security|instrument)[\s_-]*code|invalid code|代码无效|证券代码无效/.test(combined)) {
    return {
      error_code: displayCode || '10003008',
      error_kind: 'invalid_request',
      message: `Choice 合约代码或请求字段无效${displayCode ? `（${displayCode}）` : ''}。`,
      next_step: '用 Choice 代码校验确认连续合约（如 AU0.SHF、AG0.SHF），并核对接口字段名称。',
    };
  }
  if (/429|rate[\s_-]*limit|too many requests|频率|流量超限/.test(combined)) {
    return {
      error_code: displayCode || '429',
      error_kind: 'rate_limited',
      message: `Choice 请求频率或流量受限${displayCode ? `（${displayCode}）` : ''}。`,
      next_step: '降低轮询频率、检查试用额度，并按 Choice 配额要求安排服务端缓存。',
    };
  }
  if (/timeout|timed out|aborted|超时/.test(combined)) {
    return {
      error_code: displayCode,
      error_kind: 'timeout',
      message: `Choice 请求超时${displayCode ? `（${displayCode}）` : ''}。`,
      next_step: '检查官方 API 地址、网络连通性和服务状态；保留明确的待核验状态。',
    };
  }
  return {
    error_code: displayCode,
    error_kind: 'provider_error',
    message: `Choice 返回错误${displayCode ? `（${displayCode}）` : ''}${messageText ? `：${messageText}` : '。'}`,
    next_step: '核对 Choice 官方 API 地址、令牌、请求字段和账号服务状态。',
  };
}

function choiceFailureFromPayload(payload, httpStatus = null, depth = 0) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const code = payload.ErrorCode ?? payload.errorCode ?? payload.error_code ?? payload.errorcode ?? payload.errcode ?? payload.code;
  const errorValue = payload.error;
  const message = payload.ErrorMsg ?? payload.errorMsg ?? payload.errmsg ?? payload.message ?? payload.error_message ?? (typeof errorValue === 'string' ? errorValue : '');
  const hasErrorField = [errorValue, payload.ErrorMsg, payload.errorMsg, payload.errmsg, payload.error_message, payload.message, payload.msg].some((value) => value !== undefined && value !== null && text(value) !== '');
  const codeText = text(code).toLowerCase();
  const codeLooksLikeError = /^-?\d+$/.test(codeText) || /^(err|error|e[_-])/i.test(codeText) || /permission|forbidden|denied/i.test(codeText);
  const nonSuccessCode = codeLooksLikeError && !['0', '200', 'ok', 'success'].includes(codeText);
  const failedHttp = Number.isFinite(Number(httpStatus)) && Number(httpStatus) >= 400;
  const successMessage = !message || /^(ok|success|succeeded|successful|成功)$/i.test(text(message));
  if (depth < 3) {
    for (const key of ['Data', 'data', 'result', 'resultData', 'response']) {
      const nested = payload[key];
      const failure = nested && typeof nested === 'object' && !Array.isArray(nested) ? choiceFailureFromPayload(nested, null, depth + 1) : null;
      if (failure) return failure;
    }
  }
  if (!failedHttp && !errorValue && (!codeText || !nonSuccessCode) && successMessage) return null;
  if (hasErrorField || nonSuccessCode || failedHttp) return classifyChoiceFailure(code, message, httpStatus);
  return null;
}

class ChoiceProviderError extends Error {
  constructor(details) {
    super(details.message);
    this.name = 'ChoiceProviderError';
    this.details = details;
  }
}

function choiceFailureFromCause(cause) {
  if (cause instanceof ChoiceProviderError) return cause.details;
  const message = cause instanceof Error ? cause.message : text(cause) || 'Choice 请求失败';
  return classifyChoiceFailure(null, message);
}

function number(value) {
  if (value === undefined || value === null || text(value) === '') return null;
  const parsed = Number(String(value).replace(/[,，%]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (value !== undefined && value !== null && text(value)) return text(value);
  }
  return '';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseDate(value) {
  const raw = text(value);
  if (!raw) return new Date();
  const compact = raw.match(/^(\d{8})T?(\d{6})?Z?$/);
  if (compact) {
    const date = compact[1];
    const time = compact[2] || '000000';
    return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function beijingTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(parseDate(value));
}

function stableId(value, index = 0) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Math.abs(hash >>> 0) || 50_000 + index;
}

function findDefinition(raw) {
  const candidate = text(raw?.symbol || raw?.code || raw?.thscode || raw?.ticker || raw?.instrument || raw?.instrumentid || raw?.contract || raw?.name || raw?.名称).toLowerCase();
  return CONTRACTS.find((item) => item.aliases.some((alias) => candidate === alias || candidate.includes(alias))) || null;
}

function normaliseKey(key) {
  return text(key).toLowerCase().replace(/[\s_.\-/:()[\]{}]/g, '');
}

function findField(row, patterns) {
  if (!row || typeof row !== 'object') return { value: null, key: '' };
  const entries = Object.entries(row);
  for (const pattern of patterns) {
    const matcher = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    const match = entries.find(([key, value]) => matcher.test(normaliseKey(key)) && value !== undefined && value !== null && text(value) !== '');
    if (match) return { value: match[1], key: match[0] };
  }
  return { value: null, key: '' };
}

function maybePercent(field) {
  const value = number(field.value);
  if (value === null) return null;
  const key = normaliseKey(field.key);
  if ((/ratio|pct|percent|涨跌幅|涨幅|跌幅/.test(key)) && Math.abs(value) <= 1) return value * 100;
  return value;
}

function pickAsOf(row) {
  const field = findField(row, [/asof/, /timestamp/, /updated?/, /datetime/, /time/, /date/, /更新时间/, /日期/]);
  return text(field.value) || nowIso();
}

function extractRecords(value, output = [], seen = new Set(), depth = 0) {
  if (!value || depth > 8) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => extractRecords(item, output, seen, depth + 1));
    return output;
  }
  if (typeof value !== 'object') return output;
  if (seen.has(value)) return output;
  seen.add(value);
  const keys = Object.keys(value);
  const looksLikeQuote = keys.some((key) => /price|last|latest|最新|成交|close|change|涨跌|thscode|instrument/i.test(key));
  if (looksLikeQuote) output.push(value);
  Object.values(value).forEach((item) => extractRecords(item, output, seen, depth + 1));
  return output;
}

function rowsFromPayload(payload) {
  const rows = extractRecords(payload);
  const unique = [];
  const seen = new Set();
  rows.forEach((row) => {
    const key = JSON.stringify(row);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  });
  return unique;
}

function defaultCodes(key) {
  const field = key === 'EASTMONEY_CONTRACT_CODES' ? 'choice' : 'ths';
  return Object.fromEntries(CONTRACTS.map((item) => [item.symbol, item[field] || item.ths]));
}

function configuredCodes(env, key = 'THS_CONTRACT_CODES') {
  const defaults = defaultCodes(key);
  const raw = envValue(env, [key]);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ...defaults, ...parsed };
  } catch {
    // Keep the documented defaults when an optional mapping is malformed.
  }
  return defaults;
}

function normaliseQuote(raw, sourceId, sourceName, sourceUrl, codeHint = '') {
  const definition = findDefinition({ ...raw, symbol: codeHint || raw?.symbol || raw?.thscode }) || CONTRACTS.find((item) => item.symbol === String(codeHint).toLowerCase()) || null;
  if (!definition) return null;
  const priceField = findField(raw, [/latestprice/, /lastprice/, /price/, /latest/, /last/, /最新价/, /最新/, /成交价/]);
  const price = number(priceField.value);
  if (price === null) return null;
  const change = maybePercent(findField(raw, [/changepercent/, /changeratio/, /change_pct/, /涨跌幅/, /涨幅/, /change/, /涨跌/ ]));
  const asOf = pickAsOf(raw);
  const quote = {
    symbol: definition.symbol,
    asset: definition.asset,
    name: text(raw?.name || raw?.名称) || definition.name,
    contract: text(raw?.contract || raw?.合约 || raw?.thscode || raw?.instrument) || definition.contract,
    price,
    change_pct: change,
    currency: 'CNY',
    provider: sourceId,
    source_id: sourceId,
    source_name: sourceName,
    data_mode: sourceId === 'ths_ifind' ? 'ths_authorized_realtime' : 'eastmoney_authorized_realtime',
    data_label: '授权实时行情',
    delayed: false,
    available: true,
    as_of: asOf,
    age_seconds: Math.max(0, Math.round((Date.now() - parseDate(asOf).getTime()) / 1000)),
    source_url: sourceUrl,
    high: number(findField(raw, [/highprice/, /high/, /最高/]).value),
    low: number(findField(raw, [/lowprice/, /low/, /最低/]).value),
    open: number(findField(raw, [/openprice/, /open/, /开盘/]).value),
    volume: number(findField(raw, [/volume/, /成交量/]).value),
    open_interest: number(findField(raw, [/openinterest/, /open_interest/, /持仓量/]).value),
    bid: number(findField(raw, [/bid1/, /bid/, /买一/]).value),
    ask: number(findField(raw, [/ask1/, /ask/, /卖一/]).value),
    note: '来自用户配置的官方授权接口；不读取同花顺或东方财富网页 Cookie。',
  };
  return quote;
}

function sourceStatus(info, status, message, extras = {}) {
  return { id: info.id, name: info.name, kind: info.kind, mode: info.mode, status, message, docs_url: info.docs_url, public_url: info.public_url, ...extras };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchThsMarket(env) {
  const info = SOURCE_INFO.ths_ifind;
  const token = envValue(env, info.tokenKeys);
  if (!token) return { source: sourceStatus(info, 'not_configured', '未配置 THS_IFIND_ACCESS_TOKEN'), items: [], news: [] };
  const endpoint = envValue(env, [info.urlKey]) || THS_API_URL;
  if (!/^https:\/\//i.test(endpoint)) return { source: sourceStatus(info, 'provider_error', 'iFinD API 地址必须使用 HTTPS'), items: [], news: [] };
  const codes = configuredCodes(env, 'THS_CONTRACT_CODES');
  const codeList = CONTRACTS.map((item) => codes[item.symbol] || item.ths);
  const body = {
    codes: codeList.join(','),
    indicators: 'latest,changeRatio,open,high,low,volume,openInterest,bid1,ask1',
  };
  try {
    const response = await fetchWithTimeout(endpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', access_token: token, ifindlang: 'cn' }, body: JSON.stringify(body) }, providerTimeout(env));
    if (!response.ok) throw new Error(`iFinD ${response.status}`);
    const payload = await response.json();
    if (payload?.errorcode && String(payload.errorcode) !== '0') throw new Error(text(payload?.errmsg || payload?.message || 'iFinD 返回错误'));
    const rows = rowsFromPayload(payload);
    const items = rows.map((row) => normaliseQuote(row, info.id, info.name, info.docs_url)).filter(Boolean);
    return { source: sourceStatus(info, items.length ? 'ok' : 'empty', items.length ? '已返回授权实时字段' : '接口返回字段不完整', { market_count: items.length, updated_at: nowIso() }), items, news: [] };
  } catch (cause) {
    return { source: sourceStatus(info, 'provider_error', cause instanceof Error ? cause.message : 'iFinD 请求失败'), items: [], news: [] };
  }
}

async function fetchChoiceMarket(env) {
  const info = SOURCE_INFO.eastmoney_choice;
  const token = envValue(env, info.tokenKeys);
  const endpoint = envValue(env, [info.urlKey]);
  if (!token || !endpoint) return { source: sourceStatus(info, 'not_configured', !token ? '未配置 EASTMONEY_CHOICE_TOKEN' : '未配置 EASTMONEY_CHOICE_API_URL'), items: [], news: [] };
  if (!/^https:\/\//i.test(endpoint)) return { source: sourceStatus(info, 'provider_error', 'Choice API 地址必须使用 HTTPS'), items: [], news: [] };
  const codes = configuredCodes(env, 'EASTMONEY_CONTRACT_CODES');
  const body = { codes: CONTRACTS.map((item) => codes[item.symbol] || item.choice || item.ths), fields: ['latest', 'change_pct', 'open', 'high', 'low', 'volume', 'open_interest', 'bid', 'ask'] };
  try {
    const response = await fetchWithTimeout(endpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, access_token: token }, body: JSON.stringify(body) }, providerTimeout(env));
    const rawBody = await response.text();
    let payload = null;
    try { payload = rawBody ? JSON.parse(rawBody) : null; } catch { payload = rawBody; }
    const payloadFailure = choiceFailureFromPayload(payload, response.status);
    if (payloadFailure) throw new ChoiceProviderError(payloadFailure);
    if (!response.ok) throw new ChoiceProviderError(classifyChoiceFailure(null, `HTTP ${response.status}`, response.status));
    if (typeof payload === 'string' && payload.trim() && /error|fail|permission|access|权限|授权/i.test(payload)) {
      throw new ChoiceProviderError(classifyChoiceFailure(null, payload));
    }
    const rows = rowsFromPayload(payload);
    const items = rows.map((row) => normaliseQuote(row, info.id, info.name, info.docs_url)).filter(Boolean);
    return { source: sourceStatus(info, items.length ? 'ok' : 'empty', items.length ? '已返回授权实时字段' : '接口返回字段不完整', { market_count: items.length, updated_at: nowIso() }), items, news: [] };
  } catch (cause) {
    const failure = choiceFailureFromCause(cause);
    return { source: sourceStatus(info, 'provider_error', failure.message, { error_code: failure.error_code, error_kind: failure.error_kind, next_step: failure.next_step, updated_at: nowIso() }), items: [], news: [] };
  }
}

function inferAsset(value) {
  const raw = text(value).toLowerCase();
  return CONTRACTS.find((item) => item.aliases.some((alias) => raw.includes(alias)))?.asset || '黄金';
}

function inferSide(value, explicit) {
  if (['利多', 'bullish', 'positive', '利好'].includes(text(explicit).toLowerCase())) return '利多';
  if (['利空', 'bearish', 'negative', '利空'].includes(text(explicit).toLowerCase())) return '利空';
  const raw = text(value);
  if (/(降息|避险|收益率回落|美元走弱|需求改善|供应扰动|上涨|走强|流入|rate cut|safe haven|yield falls?|weaker dollar|demand improves?|supply disruption|rises?)/i.test(raw)) return '利多';
  if (/(加息|收益率上行|美元走强|库存增加|累库|需求走弱|下跌|走弱|rate hike|yield rises?|stronger dollar|inventory build|demand slows?|falls?)/i.test(raw)) return '利空';
  return '中性';
}

function normaliseNews(raw, sourceId, sourceName, sourceUrl, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title || raw.headline || raw.name || raw.标题);
  const summary = text(raw.summary || raw.description || raw.snippet || raw.content || raw.摘要 || raw.内容);
  if (!title && !summary) return null;
  const url = /^https?:\/\//i.test(text(raw.url || raw.link || raw.source_url || raw.sourceUrl)) ? text(raw.url || raw.link || raw.source_url || raw.sourceUrl) : sourceUrl;
  const published = parseDate(raw.published_at || raw.publishedAt || raw.timestamp || raw.pub_time || raw.time || raw.date || raw.发布时间);
  const asset = inferAsset(`${title} ${summary} ${raw.asset || raw.品种 || ''}`);
  const side = inferSide(`${title} ${summary}`, raw.side || raw.sentiment || raw.方向);
  const impact = clamp(number(raw.impact ?? raw.impact_score ?? raw.影响) ?? (side === '中性' ? 52 : 68), 35, 98);
  const confidence = clamp(number(raw.confidence ?? raw.置信度) ?? (side === '中性' ? 55 : 70), 35, 96);
  return {
    id: stableId(`${sourceId}|${url}|${title}`, index), asset, side, title: title || `${asset}市场资讯`, summary: summary || `${asset}相关资讯已抓取，请结合价格、美元、库存和持仓复核。`,
    source: text(raw.source || raw.publisher || raw.来源) || sourceName, sourceUrl: url, publishedAt: published.toISOString(), time: beijingTime(published), impact, confidence,
    tags: Array.isArray(raw.tags) ? raw.tags.map(text).filter(Boolean).slice(0, 4) : [sourceName, '跨源校准'],
  };
}

function parseRss(textBody, sourceId, sourceName, sourceUrl) {
  const items = [];
  const blocks = textBody.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  blocks.forEach((block, index) => {
    const read = (tag) => {
      const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return match ? text(match[1].replace(/<[^>]+>/g, '')) : '';
    };
    const link = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || read('link');
    const item = normaliseNews({ title: read('title'), summary: read('description') || read('summary') || read('content'), link, published_at: read('pubDate') || read('published') || read('updated') }, sourceId, sourceName, sourceUrl, index);
    if (item) items.push(item);
  });
  return items;
}

async function fetchNewsFeed(env, info) {
  const configured = envValue(env, [info.feedKey]);
  if (!configured) return { source: sourceStatus(info, 'not_configured', '未配置资讯 Feed URL', { news_count: 0 }), news: [] };
  if (!/^https:\/\//i.test(configured)) return { source: sourceStatus(info, 'provider_error', '资讯 Feed URL 必须使用 HTTPS'), news: [] };
  try {
    const response = await fetchWithTimeout(configured, { headers: { Accept: 'application/json, application/rss+xml, application/atom+xml, text/xml' } }, providerTimeout(env));
    if (!response.ok) throw new Error(`资讯源 ${response.status}`);
    const rawText = await response.text();
    let payload = null;
    try { payload = JSON.parse(rawText); } catch { payload = null; }
    const rawRows = payload ? (Array.isArray(payload) ? payload : payload.items || payload.articles || payload.events || payload.data || []) : parseRss(rawText, info.id, info.name, configured);
    const news = (Array.isArray(rawRows) ? rawRows.map((row, index) => normaliseNews(row, info.id, info.name, configured, index)) : []).filter(Boolean);
    return { source: sourceStatus(info, news.length ? 'ok' : 'empty', news.length ? '已返回资讯' : 'Feed 无可识别资讯', { news_count: news.length, updated_at: nowIso() }), news };
  } catch (cause) {
    return { source: sourceStatus(info, 'provider_error', cause instanceof Error ? cause.message : '资讯 Feed 请求失败'), news: [] };
  }
}

function dedupeNews(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.sourceUrl}|${item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 60);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ageSeconds(value) {
  const parsed = parseDate(value).getTime();
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;
}

export function buildCalibration(baselineItems = [], sourceItems = []) {
  return CONTRACTS.map((definition) => {
    const candidates = [
      ...baselineItems.filter((item) => item?.symbol === definition.symbol).map((item) => ({ ...item, source_name: '上期所官方延时', source_id: 'shfe_official_delayed', data_label: '官方延时 · CNY' })),
      ...sourceItems.filter((item) => item?.symbol === definition.symbol),
    ].filter((item) => Number.isFinite(item.price));
    const prices = candidates.map((item) => item.price);
    const consensus = median(prices);
    const low = prices.length ? Math.min(...prices) : null;
    const high = prices.length ? Math.max(...prices) : null;
    const spread = consensus && low !== null && high !== null ? ((high - low) / consensus) * 100 : null;
    const sourceIds = [...new Set(candidates.map((item) => item.source_id || item.provider))];
    const agreement = !consensus ? '无可用报价' : sourceIds.length < 2 ? '单源待核对' : spread <= 0.15 ? '一致' : spread <= 0.5 ? '轻微偏差' : '差异需复核';
    const calibrationStatus = sourceIds.length >= 2 && spread !== null && spread <= 0.5 ? '可用于研究校准' : sourceIds.length ? '仅供参考，暂不合成交易价' : '待接入';
    return {
      symbol: definition.symbol, asset: definition.asset, name: definition.name, contract: definition.contract, currency: 'CNY',
      consensus_price: consensus, low_price: low, high_price: high, spread_pct: spread, source_count: sourceIds.length, quote_count: candidates.length,
      agreement, calibration_status: calibrationStatus, tolerance_pct: 0.5,
      quotes: candidates.map((item) => ({ source: item.source_name || item.provider, provider: item.provider, price: item.price, as_of: item.as_of || nowIso(), age_seconds: ageSeconds(item.as_of), data_label: item.data_label || '授权实时' })),
      note: '多源中位价只用于研究校准；价差超过 0.5% 或来源不足时不合成交易价。',
    };
  });
}

export function buildStrategies(calibration = [], news = []) {
  return CONTRACTS.map((definition) => {
    const item = calibration.find((row) => row.symbol === definition.symbol);
    const related = news.filter((event) => event.asset === definition.asset).slice(0, 4);
    const bullish = related.filter((event) => event.side === '利多').length;
    const bearish = related.filter((event) => event.side === '利空').length;
    const score = item?.consensus_price === null || item?.consensus_price === undefined ? null : clamp(50 + (bullish - bearish) * 8 + (item.source_count >= 2 ? 6 : -8) - (item.spread_pct && item.spread_pct > 0.5 ? 15 : 0), 20, 80);
    const bias = score === null ? '等待数据' : score >= 62 && bullish >= bearish ? '条件偏多' : score <= 42 && bearish > bullish ? '条件偏空' : '等待确认';
    const action = bias === '条件偏多' ? '仅在价格回踩后、两类来源方向一致时轻仓跟随' : bias === '条件偏空' ? '反弹承压且利空资讯得到第二来源确认时减仓或防守' : '保持观望，先等待报价与资讯完成跨源确认';
    const trigger = item?.consensus_price ? `多源中位价 ${item.consensus_price.toLocaleString('en-US', { maximumFractionDigits: 3 })} CNY 附近，且价差 ≤ 0.5%` : '至少两类来源返回同一合约报价';
    const invalid = item?.spread_pct && item.spread_pct > 0.5 ? '来源价差超过 0.5%，停止合成信号并复核合约/时间戳' : '跌破结构支撑、来源时间过期或事件方向反转';
    return {
      symbol: definition.symbol, asset: definition.asset, horizon: '未来 7 日', bias, score, evidence_confidence: score === null ? 0 : clamp(Math.round((item.source_count >= 2 ? 68 : 48) + (related.length ? 8 : 0) - (item.spread_pct && item.spread_pct > 0.5 ? 18 : 0)), 0, 90),
      evidence_count: item.quote_count + related.length, action, trigger, invalid, position: score !== null && score >= 65 ? '单品种风险 ≤ 0.5R；组合仓位 ≤ 30%' : '单品种风险 ≤ 0.25R；组合仓位 ≤ 20%',
      sources: [...new Set([...(item.quotes || []).map((quote) => quote.source), ...related.map((event) => event.source)])], data_status: item.calibration_status, disclaimer: '证据置信度不是胜率；策略仅供研究参考，不构成投资建议。',
    };
  });
}

async function safeCall(task) {
  try { return await task(); } catch (cause) { return { source: null, items: [], news: [], error: cause instanceof Error ? cause.message : 'source error' }; }
}

export async function chinaSources(env = {}) {
  const cacheKey = [
    envValue(env, SOURCE_INFO.ths_ifind.tokenKeys),
    envValue(env, SOURCE_INFO.eastmoney_choice.tokenKeys),
    envValue(env, ['THS_IFIND_API_URL']),
    envValue(env, ['EASTMONEY_CHOICE_API_URL']),
    envValue(env, ['THS_CONTRACT_CODES']),
    envValue(env, ['EASTMONEY_CONTRACT_CODES']),
    envValue(env, ['THS_NEWS_FEED_URL']),
    envValue(env, ['EASTMONEY_NEWS_FEED_URL']),
    envValue(env, ['DOMESTIC_DELAYED_URL', 'SHFE_DELAYED_API_URL']),
    envValue(env, ['DOMESTIC_DELAYED_TOKEN', 'SHFE_DELAYED_API_KEY']),
    envValue(env, ['CHINA_SOURCE_TIMEOUT_MS']),
    envValue(env, ['DOMESTIC_SOURCE_TIMEOUT_MS', 'DOMESTIC_DELAYED_TIMEOUT_MS']),
  ].join('|');
  if (cached.payload && cached.key === cacheKey && Date.now() < cached.expiresAt) return { ...cached.payload, sync: { ...cached.payload.sync, cached: true } };
  const started = Date.now();
  const [thsMarket, choiceMarket, thsNews, choiceNews, domestic] = await Promise.all([
    safeCall(() => fetchThsMarket(env)), safeCall(() => fetchChoiceMarket(env)), safeCall(() => fetchNewsFeed(env, SOURCE_INFO.ths_ifind)), safeCall(() => fetchNewsFeed(env, SOURCE_INFO.eastmoney_choice)), safeCall(() => domesticDelayedBoard(env)),
  ]);
  const sourceCards = [
    thsMarket.source || sourceStatus(SOURCE_INFO.ths_ifind, 'provider_error', thsMarket.error || 'iFinD 未返回'),
    choiceMarket.source || sourceStatus(SOURCE_INFO.eastmoney_choice, 'provider_error', choiceMarket.error || 'Choice 未返回'),
    thsNews.source || sourceStatus(SOURCE_INFO.ths_ifind, 'provider_error', thsNews.error || '同花顺资讯 Feed 未返回'),
    choiceNews.source || sourceStatus(SOURCE_INFO.eastmoney_choice, 'provider_error', choiceNews.error || '东方财富资讯 Feed 未返回'),
  ];
  const dedupedCards = Object.values(sourceCards.reduce((groups, card) => {
    if (!card?.id) return groups;
    const previous = groups[card.id];
    if (!previous) {
      groups[card.id] = { ...card };
      return groups;
    }
    const statuses = [previous.status, card.status];
    const status = statuses.includes('ok') ? 'ok' : statuses.includes('provider_error') ? 'provider_error' : statuses.includes('empty') ? 'empty' : 'not_configured';
    const messages = [previous.message, card.message].filter(Boolean);
    groups[card.id] = {
      ...previous,
      status,
      message: messages.length > 1 ? messages.join('；') : messages[0] || previous.message,
      market_count: (previous.market_count || 0) + (card.market_count || 0),
      news_count: (previous.news_count || 0) + (card.news_count || 0),
      updated_at: card.updated_at || previous.updated_at,
      error_code: previous.error_code || card.error_code,
      error_kind: previous.error_kind || card.error_kind,
      next_step: previous.next_step || card.next_step,
    };
    return groups;
  }, {}));
  const sourceItems = [...(thsMarket.items || []), ...(choiceMarket.items || [])];
  const baselineItems = Array.isArray(domestic?.items) ? domestic.items : [];
  const news = dedupeNews([...(thsNews.news || []), ...(choiceNews.news || [])]);
  const calibration = buildCalibration(baselineItems, sourceItems);
  const strategies = buildStrategies(calibration, news);
  const configuredSourceCount = dedupedCards.filter((card) => card.status !== 'not_configured' && ['同花顺 iFinD', '东方财富 Choice'].includes(card.name)).length;
  const hasAnyData = sourceItems.length > 0 || baselineItems.some((item) => item.available);
  const status = sourceItems.length && configuredSourceCount >= 1 ? 'ok' : hasAnyData || configuredSourceCount >= 1 ? 'partial' : 'not_configured';
  const syncedAt = nowIso();
  const payload = {
    status, as_of: syncedAt, items: sourceItems, calibration, strategies, news,
    sources: [
      ...dedupedCards,
      sourceStatus({ ...SOURCE_INFO.ths_ifind, id: 'shfe_official_delayed', name: '上期所官方延时', kind: 'baseline', mode: 'official_delayed' }, baselineItems.some((item) => item.available) ? 'ok' : 'provider_error', baselineItems.some((item) => item.available) ? '官方延时基准已返回' : '官方延时基准暂不可用', { market_count: baselineItems.filter((item) => item.available).length, docs_url: 'https://www.shfe.com.cn/reports/marketdata/delayedquotes/', public_url: 'https://www.shfe.com.cn/data/tradedata/future/delaymarket/delaymarket_all.dat' }),
    ],
    policy: {
      note: '仅允许官方授权 API、授权分销商 Feed 和上期所公开延时基准；不抓取同花顺/东方财富网页、Cookie、登录态或逆向终端协议。',
      allowed_sources: ['同花顺 iFinD 官方 API', '东方财富 Choice 官方 API', '上期所公开延时 JSON', '用户明确配置的 HTTPS 资讯 Feed'],
      blocked_methods: ['网页 HTML 抓取', 'Cookie/登录态读取', '逆向终端协议', '未授权转载或自动下单'],
    },
    sync: { status, synced_at: syncedAt, latency_ms: Math.max(0, Date.now() - started), refresh_mode: 'polling', cache_ttl_seconds: CACHE_TTL_MS / 1000, source_count: dedupedCards.length + 1, configured_source_count: Math.min(2, configuredSourceCount), news_count: news.length, baseline_warning: !baselineItems.some((item) => item.available) },
  };
  cached = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, payload };
  return payload;
}

export { CONTRACTS, SOURCE_INFO, THS_API_URL, THS_DOCS_URL, EASTMONEY_DOCS_URL, classifyChoiceFailure, choiceFailureFromPayload };
