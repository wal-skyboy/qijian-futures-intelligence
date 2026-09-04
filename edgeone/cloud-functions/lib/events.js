const CACHE_TTL_MS = 60_000;
const DEFAULT_GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DEFAULT_QUERY = '(gold OR bullion OR XAU OR silver OR XAG OR copper OR tin OR "crude oil" OR WTI OR "US dollar" OR DXY)';

const ASSET_RULES = [
  { asset: '黄金', terms: /gold|bullion|xau|贵金属|黄金/i, tags: ['贵金属', '宏观'] },
  { asset: '白银', terms: /silver|xag|白银/i, tags: ['贵金属', '工业需求'] },
  { asset: '铜', terms: /copper|cuprum|铜/i, tags: ['有色', '中国需求'] },
  { asset: '锡', terms: /tin|锡/i, tags: ['有色', '供应'] },
  { asset: '原油', terms: /crude|wti|brent|oil|原油|石油/i, tags: ['能源', '供给'] },
  { asset: '美元', terms: /dollar|dxy|usd|美元|汇率/i, tags: ['外汇', '宏观'] },
];

const BULLISH_TERMS = /safe haven|risk-off|dovish|rate cut|cuts? rates?|yield (?:falls?|drops?|declines?)|weaker dollar|dollar (?:falls?|weakens?)|demand (?:rises?|improves?)|supply disruption|shortage|stimulus|避险|降息|收益率回落|美元走弱|需求改善|供应扰动|上涨|走强|流入/i;
const BEARISH_TERMS = /hawkish|rate hike|higher for longer|yield (?:rises?|jumps?|climbs?)|stronger dollar|dollar (?:rises?|strengthens?)|inventory (?:build|rises?|increase)|oversupply|sell[- ]?off|demand (?:falls?|slows?)|recession|tightening|加息|收益率上行|美元走强|库存增加|累库|供应过剩|下跌|走弱/i;

let cached = { key: '', expiresAt: 0, payload: null };

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function number(value, fallback = null) {
  if (value === undefined || value === null || text(value) === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseDate(value) {
  const raw = text(value);
  if (!raw) return new Date();
  // GDELT uses YYYYMMDDTHHMMSSZ. Normalise it before handing it to Date.
  const gdelt = raw.match(/^(\d{8})T(\d{6})Z$/);
  if (gdelt) {
    const [, date, time] = gdelt;
    return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function shanghaiTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function stableId(value, index) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.abs(hash >>> 0) || 9000 + index;
}

function inferAsset(value) {
  const source = text(value);
  return ASSET_RULES.find((rule) => rule.terms.test(source))?.asset || '黄金';
}

function inferTags(value, asset) {
  const source = text(value);
  const rule = ASSET_RULES.find((candidate) => candidate.asset === asset);
  const tags = rule ? [...rule.tags] : [];
  if (/central bank|fed|ecb|interest rate|yield|央行|利率|收益率/i.test(source)) tags.push('宏观');
  if (/inventory|stock|warehouse|库存|仓单|持仓/i.test(source)) tags.push('库存/持仓');
  if (/trade|tariff|sanction|war|conflict|制裁|关税|冲突/i.test(source)) tags.push('地缘');
  return [...new Set(tags)].slice(0, 4);
}

function classify(value, rawSide) {
  if (rawSide === '利多' || rawSide === 'bullish' || rawSide === 'positive') return '利多';
  if (rawSide === '利空' || rawSide === 'bearish' || rawSide === 'negative') return '利空';
  const source = text(value);
  const bull = BULLISH_TERMS.test(source);
  const bear = BEARISH_TERMS.test(source);
  if (bull && !bear) return '利多';
  if (bear && !bull) return '利空';
  return '中性';
}

function sourceName(raw, sourceUrl) {
  const explicit = text(raw?.source || raw?.publisher || raw?.domain);
  if (explicit) return explicit.replace(/^www\./i, '');
  try { return new URL(sourceUrl).hostname.replace(/^www\./i, ''); } catch { return 'GDELT'; }
}

function sourceUrlFor(raw, providerUrl) {
  const candidate = text(raw?.sourceUrl || raw?.source_url || raw?.url || raw?.link);
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return providerUrl;
}

function normaliseItem(raw, index, providerUrl) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title || raw.headline || raw.name);
  const summary = text(raw.summary || raw.description || raw.snippet || raw.seendescription);
  if (!title && !summary) return null;
  const sourceUrl = sourceUrlFor(raw, providerUrl);
  const published = parseDate(raw.publishedAt || raw.published_at || raw.timestamp || raw.seendate || raw.date);
  const publishedAt = published.toISOString();
  const asset = text(raw.asset) && ASSET_RULES.some((rule) => rule.asset === raw.asset) ? raw.asset : inferAsset(`${title} ${summary}`);
  const side = classify(`${title} ${summary}`, raw.side || raw.sentiment);
  const impact = clamp(number(raw.impact ?? raw.impact_score, side === '中性' ? 52 : 68), 35, 98);
  const confidence = clamp(number(raw.confidence, side === '中性' ? 56 : 70), 35, 96);
  const source = sourceName(raw, sourceUrl);
  const tags = Array.isArray(raw.tags) ? raw.tags.map(text).filter(Boolean).slice(0, 4) : inferTags(`${title} ${summary}`, asset);
  const finalSummary = summary || `${asset}相关全球资讯已抓取；请结合价格、美元、实际利率、库存和持仓交叉验证。`;
  return {
    id: number(raw.id, stableId(`${sourceUrl}|${title}`, index)),
    asset,
    side,
    title: title || `${asset}全球关键事件`,
    summary: finalSummary,
    source,
    sourceUrl,
    publishedAt,
    time: text(raw.time) || shanghaiTime(published),
    impact,
    confidence,
    tags: tags.length ? tags : ['全球事件', '待验证'],
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.sourceUrl}|${item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 40);
}

function timelineFor(items) {
  const now = Date.now();
  return items.map((item) => ({
    id: item.id,
    date: item.publishedAt.slice(0, 10),
    window: Date.parse(item.publishedAt) > now ? '未来7天' : '过去7天',
    side: item.side,
    impact: item.impact >= 80 ? '高' : '中',
    title: item.title,
    assets: item.asset,
    why: item.summary,
    source: item.source,
    sourceUrl: item.sourceUrl,
  }));
}

function articleRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.articles)) return payload.articles;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function globalEvents(env = {}) {
  const configured = text(env?.GLOBAL_EVENTS_URL);
  const providerUrl = configured || DEFAULT_GDELT_URL;
  const cacheKey = `${providerUrl}|${configured ? 'configured' : DEFAULT_QUERY}`;
  const current = Date.now();
  if (cached.payload && cached.key === cacheKey && current < cached.expiresAt) {
    return { ...cached.payload, sync: { ...cached.payload.sync, cached: true, next_refresh_at: new Date(cached.expiresAt).toISOString() } };
  }

  const started = Date.now();
  const fetchedAt = nowIso();
  try {
    const url = configured ? providerUrl : `${providerUrl}?${new URLSearchParams({
      query: DEFAULT_QUERY, mode: 'artlist', format: 'json', maxrecords: '40', sort: 'datedesc', timespan: '24h',
    }).toString()}`;
    const response = await fetchWithTimeout(url, Number(env?.EVENTS_FETCH_TIMEOUT_MS) || 8000);
    if (!response.ok) throw new Error(`events provider ${response.status}`);
    const payload = await response.json();
    const items = dedupe(articleRows(payload).map((row, index) => normaliseItem(row, index, providerUrl)).filter(Boolean));
    const result = {
      status: items.length ? 'ok' : 'empty',
      provider: configured ? 'configured_events' : 'gdelt',
      fetched_at: fetchedAt,
      source_url: providerUrl,
      items,
      timeline: timelineFor(items),
      sync: {
        status: items.length ? 'ok' : 'empty',
        synced_at: fetchedAt,
        latency_ms: Math.max(0, Date.now() - started),
        refresh_mode: 'polling',
        cache_ttl_seconds: CACHE_TTL_MS / 1000,
        item_count: items.length,
        stale: false,
        next_refresh_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      },
    };
    cached = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, payload: result };
    return result;
  } catch (cause) {
    return {
      status: 'provider_error',
      provider: configured ? 'configured_events' : 'gdelt',
      fetched_at: fetchedAt,
      source_url: providerUrl,
      items: [],
      timeline: [],
      error: cause instanceof Error ? cause.message : 'events provider error',
      sync: {
        status: 'error',
        synced_at: fetchedAt,
        latency_ms: Math.max(0, Date.now() - started),
        refresh_mode: 'polling',
        cache_ttl_seconds: CACHE_TTL_MS / 1000,
        item_count: 0,
        stale: true,
        next_refresh_at: new Date(Date.now() + 15_000).toISOString(),
      },
    };
  }
}
