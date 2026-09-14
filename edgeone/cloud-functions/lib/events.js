const CACHE_TTL_MS = 60_000;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DEFAULT_QUERY = '(gold OR bullion OR XAU OR silver OR XAG OR copper OR tin OR "crude oil" OR WTI OR "US dollar" OR DXY)';
const DEFAULT_RSS_URL = 'https://news.google.com/rss/search';
const DEFAULT_RSS_QUERY = 'gold OR silver OR copper OR tin OR "crude oil" OR dollar when:7d';
const DEFAULT_EVENTS_TIMEOUT_MS = 1400;
// This is a public economic-calendar feed, not an exchange-authorized quote feed.
// GLOBAL_CALENDAR_URL can replace it with an official/licensed calendar when available.
const DEFAULT_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const DEFAULT_CALENDAR_NAME = '公开经济日历';
const DEFAULT_CALENDAR_TTL_MS = 5 * 60_000;

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
let calendarCached = { key: '', expiresAt: 0, rows: [], error: '' };

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
  // Calendar feeds often publish a date without a timezone. Treat it as a
  // Beijing calendar date so the displayed day does not shift at UTC midnight.
  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  const localWithoutTimezone = raw.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/);
  const localValue = localWithoutTimezone ? raw.replace(' ', 'T') : raw;
  const parsed = new Date(dateOnly ? `${dateOnly[1]}T00:00:00+08:00` : localWithoutTimezone ? `${localValue}+08:00` : raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function calendarDateTime(dateValue, timeValue) {
  const date = text(dateValue);
  const time = text(timeValue);
  if (!date || !time || /[T ]\d{1,2}:\d{2}/.test(date)) return date;
  // Public calendars sometimes split a Beijing calendar date and a 12-hour
  // release time into separate fields. Join them so events later today are
  // not incorrectly classified as already past at midnight.
  const match = time.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return date;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const second = Number(match[3] || 0);
  const meridiem = text(match[4]).toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return date;
  const isoDate = date.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1];
  if (!isoDate) return date;
  return `${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+08:00`;
}

function shanghaiTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function shanghaiDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
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

function relatedAssets(value, primary) {
  const source = text(value);
  const related = new Set([primary]);
  if (/silver|xag|白银/i.test(source)) related.add('白银');
  if (/gold|bullion|xau|黄金/i.test(source)) related.add('黄金');
  if (/copper|cuprum|铜/i.test(source)) related.add('铜');
  if (/tin|锡/i.test(source)) related.add('锡');
  if (/crude|wti|brent|oil|原油|石油/i.test(source)) related.add('原油');
  if (/dollar|dxy|usd|美元|汇率/i.test(source)) related.add('美元');
  // Central-bank, US macro and real-rate releases are shared precious-metal
  // catalysts even when the feed title does not say “gold” or “silver”.
  if (/fed|fomc|cpi|ppi|payroll|employment|jobs?|inflation|interest rate|yield|gdp|pmi|retail sales|industrial production|housing|consumer confidence|manufacturing|nonfarm|央行|利率|通胀|就业|非农|收益率|国内生产总值|零售销售|工业增加值|制造业/i.test(source)) {
    related.add('黄金');
    related.add('白银');
    related.add('美元');
  }
  // China demand releases are most directly relevant to industrial metals.
  if (/china|chinese|cny|yuan|中国|人民币|制造业|工业增加值|零售销售|pmi/i.test(source)) {
    related.add('铜');
    related.add('锡');
  }
  if (/soybean|corn|usda|大豆|玉米|农业|农产品/i.test(source)) related.add(primary);
  return [...related];
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
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./i, '');
    if (/faireconomy\.media|forexfactory/i.test(hostname)) return DEFAULT_CALENDAR_NAME;
    return hostname;
  } catch { return 'GDELT'; }
}

function sourceUrlFor(raw, providerUrl) {
  const candidate = text(raw?.sourceUrl || raw?.source_url || raw?.url || raw?.link);
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return providerUrl;
}

function firstText(raw, keys) {
  for (const key of keys) {
    const value = text(raw?.[key]);
    if (value) return value;
  }
  return '';
}

function impactValue(value, side, scheduled) {
  const numeric = number(value, null);
  if (numeric !== null) return numeric;
  const label = text(value).toLowerCase();
  if (/high|重要|重大|红色|高/.test(label)) return 88;
  if (/medium|中等|橙色|中/.test(label)) return 72;
  if (/low|次要|黄色|低/.test(label)) return 48;
  return scheduled ? 58 : side === '中性' ? 52 : 68;
}

function isKeyCalendarItem(item) {
  if (!item?.scheduled) return false;
  if (item.impact >= 68) return true;
  return /fomc|fed|ecb|boe|boj|cpi|ppi|payroll|employment|unemployment|inflation|gdp|pmi|retail sales|industrial production|interest rate|rate decision|central bank|opec|eia|crude oil inventories|库存|央行|利率|通胀|非农|就业|国内生产总值|工业增加值|零售销售|制造业/i.test(item.title);
}

function normaliseItem(raw, index, providerUrl) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title || raw.headline || raw.name);
  const summary = text(raw.summary || raw.description || raw.snippet || raw.seendescription);
  if (!title && !summary) return null;
  const sourceUrl = sourceUrlFor(raw, providerUrl);
  const publishedRaw = firstText(raw, ['publishedAt', 'published_at', 'pubDate', 'timestamp', 'seendate', 'seenDate']);
  const genericDate = firstText(raw, ['date', 'Date']);
  const calendarTime = firstText(raw, ['time', 'eventTime', 'event_time', 'releaseTime', 'release_time']);
  const scheduledRaw = firstText(raw, [
    'scheduledAt', 'scheduled_at', 'eventAt', 'event_at', 'eventDate', 'event_date',
    'releaseAt', 'release_at', 'startTime', 'start_time', 'scheduledDate', 'scheduled_date',
  ]) || (!publishedRaw ? calendarDateTime(genericDate, calendarTime) : '');
  const published = parseDate(publishedRaw || scheduledRaw);
  const eventDate = scheduledRaw ? parseDate(scheduledRaw) : published;
  const scheduled = Boolean(scheduledRaw);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(scheduledRaw);
  // Keep an all-day item visible as a future window until the end of its
  // calendar day. A midnight timestamp would otherwise become "past" as
  // soon as the page is opened that morning.
  const eventAtDate = dateOnly ? parseDate(`${scheduledRaw}T23:59:59`) : eventDate;
  const publishedAt = published.toISOString();
  const eventAt = eventAtDate.toISOString();
  const context = `${title} ${summary} ${text(raw.country || raw.currency || raw.region)}`;
  const asset = text(raw.asset) && ASSET_RULES.some((rule) => rule.asset === raw.asset) ? raw.asset : inferAsset(context);
  const side = classify(context, raw.side || raw.sentiment);
  const impact = clamp(impactValue(raw.impact ?? raw.impact_score ?? raw.importance, side, scheduled), 35, 98);
  const confidence = clamp(number(raw.confidence, scheduled ? 78 : side === '中性' ? 56 : 70), 35, 96);
  const source = sourceName(raw, sourceUrl);
  const tags = Array.isArray(raw.tags) ? raw.tags.map(text).filter(Boolean).slice(0, 4) : inferTags(`${title} ${summary}`, asset);
  const finalSummary = summary || `${asset}相关全球资讯已抓取；请结合价格、美元、实际利率、库存和持仓交叉验证。`;
  return {
    id: number(raw.id, stableId(`${sourceUrl}|${title}`, index)),
    asset,
    relatedAssets: relatedAssets(context, asset),
    side,
    title: title || `${asset}全球关键事件`,
    summary: finalSummary,
    source,
    sourceUrl,
    publishedAt,
    eventAt,
    scheduledAt: scheduled ? eventAt : null,
    scheduled,
    time: dateOnly ? '' : calendarTime || shanghaiTime(eventDate),
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
  const lowerBound = now - WINDOW_MS;
  const upperBound = now + WINDOW_MS;
  const seen = new Set();
  const rows = [];
  items.forEach((item) => {
    const eventAt = item.scheduledAt || item.eventAt || item.publishedAt;
    const timestamp = Date.parse(eventAt || '');
    if (!Number.isFinite(timestamp) || timestamp < lowerBound || timestamp > upperBound) return;
    const eventDate = new Date(timestamp);
    const assetNames = Array.isArray(item.relatedAssets) && item.relatedAssets.length ? item.relatedAssets : [item.asset];
    assetNames.forEach((assetName, assetIndex) => {
      const key = `${item.sourceUrl}|${item.title}|${eventAt}|${assetName}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        id: assetIndex ? stableId(`${item.id}|${assetName}`, assetIndex) : item.id,
        date: shanghaiDate(eventDate),
        eventAt: eventDate.toISOString(),
        time: item.time || '',
        window: timestamp >= now ? '未来7天' : '过去7天',
        scheduled: Boolean(item.scheduled || item.scheduledAt || timestamp >= now),
        side: item.side,
        impact: item.impact >= 80 ? '高' : '中',
        title: item.title,
        assets: assetName,
        why: item.summary,
        source: item.source,
        sourceUrl: item.sourceUrl,
      });
    });
  });
  return rows.sort((a, b) => {
    if (a.window !== b.window) return a.window === '未来7天' ? -1 : 1;
    const difference = Date.parse(a.eventAt) - Date.parse(b.eventAt);
    return a.window === '未来7天' ? difference : -difference;
  });
}

function articleRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.articles)) return payload.articles;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.calendar)) return payload.calendar;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function decodeXml(value) {
  return text(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function rssRows(xml) {
  return [...String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const block = match[1];
    const read = (tag) => decodeXml(block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '');
    const source = read('source');
    return {
      title: read('title'),
      description: read('description'),
      link: read('link'),
      pubDate: read('pubDate'),
      source: source || undefined,
    };
  });
}

function atomRows(xml) {
  return [...String(xml || '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const block = match[1];
    const read = (tag) => decodeXml(block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '');
    const link = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || read('link');
    return {
      title: read('title'),
      description: read('summary') || read('content'),
      link: decodeXml(link),
      pubDate: read('published') || read('updated'),
    };
  });
}

async function fetchWithTimeout(url, timeoutMs, accept = 'application/json') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Accept: accept }, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function feedRows(url, timeoutMs) {
  const response = await fetchWithTimeout(url, timeoutMs, 'application/json, application/rss+xml, application/atom+xml, text/xml');
  if (!response.ok) throw new Error(`events provider ${response.status}`);
  const body = await response.text();
  try {
    return articleRows(JSON.parse(body));
  } catch {
    const rows = rssRows(body);
    return rows.length ? rows : atomRows(body);
  }
}

function calendarSource(env) {
  const configured = text(env?.GLOBAL_CALENDAR_URL);
  if (configured) {
    return {
      url: configured,
      name: text(env?.GLOBAL_CALENDAR_NAME) || '授权经济日历',
      mode: 'configured',
    };
  }
  return { url: DEFAULT_CALENDAR_URL, name: DEFAULT_CALENDAR_NAME, mode: 'public' };
}

async function calendarRowsCached(source, timeoutMs, forceRefresh) {
  const current = Date.now();
  // The public feed asks consumers not to download more than twice in five
  // minutes. Keep its own cache even when the user manually refreshes news.
  const canUseCache = calendarCached.key === source.url && current < calendarCached.expiresAt;
  const bypass = forceRefresh && source.mode === 'configured';
  if (canUseCache && !bypass) {
    return {
      rows: calendarCached.rows,
      error: calendarCached.error,
      fetchedAt: calendarCached.fetchedAt || '',
      expiresAt: calendarCached.expiresAt,
      cached: true,
    };
  }
  try {
    const rows = await feedRows(source.url, timeoutMs);
    calendarCached = {
      key: source.url,
      rows,
      error: '',
      fetchedAt: nowIso(),
      expiresAt: Date.now() + DEFAULT_CALENDAR_TTL_MS,
    };
    return { rows, error: '', fetchedAt: calendarCached.fetchedAt, expiresAt: calendarCached.expiresAt, cached: false };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'calendar provider error';
    // Short negative caching prevents a failing public feed from being hit on
    // every page refresh while still recovering promptly.
    calendarCached = {
      key: source.url,
      rows: [],
      error,
      fetchedAt: nowIso(),
      expiresAt: Date.now() + 60_000,
    };
    return { rows: [], error, fetchedAt: calendarCached.fetchedAt, expiresAt: calendarCached.expiresAt, cached: false };
  }
}

export async function globalEvents(env = {}) {
  const configured = text(env?.GLOBAL_EVENTS_URL);
  const calendar = calendarSource(env);
  const forceRefresh = text(env?.EVENTS_FORCE_REFRESH) === '1';
  const providerUrl = configured || DEFAULT_GDELT_URL;
  const cacheKey = `${providerUrl}|${calendar.url}|${configured ? 'configured' : DEFAULT_QUERY}|7d`;
  const current = Date.now();
  if (!forceRefresh && cached.payload && cached.key === cacheKey && current < cached.expiresAt) {
    return { ...cached.payload, sync: { ...cached.payload.sync, cached: true, next_refresh_at: new Date(cached.expiresAt).toISOString() } };
  }

  const started = Date.now();
  const fetchedAt = nowIso();
  try {
    // The public Site request can be cancelled after a few seconds. Cap each
    // provider attempt so a slow feed never leaves the radar spinning; the
    // two public feeds below are requested in parallel.
    const requestedTimeout = Number(env?.EVENTS_FETCH_TIMEOUT_MS) || DEFAULT_EVENTS_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 500), 2500);
    const sourceUrl = providerUrl;
    const providerName = configured ? `configured_events+${calendar.mode}_calendar` : `gdelt+google_news+${calendar.mode}_calendar`;
    const historyResult = (async () => {
      try {
        if (configured) {
          const rows = await feedRows(providerUrl, timeoutMs);
          return { rows, error: rows.length ? '' : 'history feed empty' };
        }
        const gdeltUrl = `${providerUrl}?${new URLSearchParams({
          query: DEFAULT_QUERY, mode: 'artlist', format: 'json', maxrecords: '80', sort: 'datedesc', timespan: '7d',
        }).toString()}`;
        const rssUrl = `${DEFAULT_RSS_URL}?${new URLSearchParams({ q: DEFAULT_RSS_QUERY, hl: 'en-US', gl: 'US', ceid: 'US:en' }).toString()}`;
        const [gdeltResult, rssResult] = await Promise.allSettled([
          fetchWithTimeout(gdeltUrl, timeoutMs).then(async (response) => ({
            ok: response.ok,
            status: response.status,
            rows: response.ok ? articleRows(await response.json()) : [],
          })),
          fetchWithTimeout(rssUrl, timeoutMs, 'application/rss+xml, application/xml, text/xml').then(async (response) => ({
            ok: response.ok,
            status: response.status,
            rows: response.ok ? rssRows(await response.text()) : [],
          })),
        ]);
        const gdelt = gdeltResult.status === 'fulfilled' ? gdeltResult.value : null;
        const rss = rssResult.status === 'fulfilled' ? rssResult.value : null;
        const rows = [...(gdelt?.rows || []), ...(rss?.rows || [])];
        if (rows.length) return { rows, error: '' };
        const gdeltStatus = gdelt?.status ? `gdelt ${gdelt.status}` : 'gdelt timeout';
        const rssStatus = rss?.status ? `rss ${rss.status}` : 'rss timeout';
        return { rows: [], error: `events providers unavailable (${gdeltStatus}; ${rssStatus})` };
      } catch (cause) {
        return { rows: [], error: cause instanceof Error ? cause.message : 'events provider error' };
      }
    })();
    const calendarResult = calendarRowsCached(calendar, Math.min(Math.max(Number(env?.CALENDAR_FETCH_TIMEOUT_MS) || 3500, 700), 6000), forceRefresh);
    const [history, calendarData] = await Promise.all([historyResult, calendarResult]);
    const historyRows = history.rows;
    const calendarRows = calendarData.rows;
    const historyError = history.error;
    const calendarError = calendarData.error;
    const historyItems = historyRows.map((row, index) => normaliseItem(row, index, sourceUrl)).filter(Boolean);
    const calendarItems = calendarRows.map((row, index) => normaliseItem(row, index, calendar.url)).filter(Boolean);
    const items = dedupe(historyItems.filter((item) => !item.scheduled));
    const scheduledItems = calendarItems.filter(isKeyCalendarItem);
    const timeline = timelineFor([...items, ...scheduledItems]);
    const historyCount = items.length;
    const futureCount = timeline.filter((item) => item.window === '未来7天').length;
    const status = items.length || futureCount
      ? (historyError || calendarError ? 'partial' : 'ok')
      : 'provider_error';
    const calendarNextRefreshAt = new Date(calendarData.expiresAt || Date.now() + DEFAULT_CALENDAR_TTL_MS).toISOString();
    const result = {
      status,
      provider: providerName,
      fetched_at: fetchedAt,
      source_url: sourceUrl,
      calendar_source_url: calendar.url,
      calendar_source_name: calendar.name,
      calendar_mode: calendar.mode,
      calendar_fetched_at: calendarData.fetchedAt || null,
      // "configured" describes the selected source; "available" describes
      // whether the last fetch succeeded. Keeping both prevents an empty or
      // failed feed from being presented as a live calendar.
      calendar_configured: true,
      calendar_available: !calendarError,
      calendar_row_count: calendarRows.length,
      calendar_error: calendarError || undefined,
      history_error: historyError || undefined,
      history_window_days: 7,
      future_window_days: 7,
      items,
      timeline,
      sync: {
        status,
        synced_at: fetchedAt,
        latency_ms: Math.max(0, Date.now() - started),
        refresh_mode: 'polling',
        cache_ttl_seconds: CACHE_TTL_MS / 1000,
        item_count: items.length,
        history_count: historyCount,
        future_count: futureCount,
        calendar_item_count: scheduledItems.length,
        calendar_configured: true,
        calendar_available: !calendarError,
        calendar_row_count: calendarRows.length,
        calendar_mode: calendar.mode,
        calendar_source_name: calendar.name,
        calendar_fetched_at: calendarData.fetchedAt || undefined,
        calendar_next_refresh_at: calendarNextRefreshAt,
        calendar_error: calendarError || undefined,
        history_error: historyError || undefined,
        stale: false,
        next_refresh_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      },
    };
    cached = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, payload: result };
    return result;
  } catch (cause) {
    return {
      status: 'provider_error',
      provider: configured ? `configured_events+${calendar.mode}_calendar` : `gdelt+google_news+${calendar.mode}_calendar`,
      fetched_at: fetchedAt,
      source_url: providerUrl,
      calendar_source_url: calendar.url,
      calendar_source_name: calendar.name,
      calendar_mode: calendar.mode,
      calendar_fetched_at: calendarCached.key === calendar.url ? calendarCached.fetchedAt || null : null,
      calendar_configured: true,
      calendar_available: false,
      calendar_row_count: 0,
      calendar_error: cause instanceof Error ? cause.message : 'events provider error',
      history_window_days: 7,
      future_window_days: 7,
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
        history_count: 0,
        future_count: 0,
        calendar_item_count: 0,
        calendar_configured: true,
        calendar_available: false,
        calendar_row_count: 0,
        calendar_mode: calendar.mode,
        calendar_source_name: calendar.name,
        calendar_next_refresh_at: new Date(Date.now() + DEFAULT_CALENDAR_TTL_MS).toISOString(),
        calendar_error: cause instanceof Error ? cause.message : 'events provider error',
        stale: true,
        next_refresh_at: new Date(Date.now() + 15_000).toISOString(),
      },
    };
  }
}
