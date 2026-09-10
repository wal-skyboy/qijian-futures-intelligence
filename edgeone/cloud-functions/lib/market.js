const MARKET_DEFINITIONS = {
  gold: { name: '黄金', price: 2654.8, change: 1.28, score: 72, currency: 'USD', instrument_type: 'spot', contract: 'XAU/USD', quote_unit: 'USD/oz', avSymbol: 'GOLD', function: 'GOLD_SILVER_SPOT', historyFunction: 'GOLD_SILVER_HISTORY', mode: 'spot_realtime', source: 'https://www.alphavantage.co/documentation/' },
  silver: { name: '白银', price: 31.642, change: 0.86, score: 64, currency: 'USD', instrument_type: 'spot', contract: 'XAG/USD', quote_unit: 'USD/oz', avSymbol: 'SILVER', function: 'GOLD_SILVER_SPOT', historyFunction: 'GOLD_SILVER_HISTORY', mode: 'spot_realtime', source: 'https://www.alphavantage.co/documentation/' },
  copper: { name: '铜', price: 9842.5, change: 0.34, score: 58, currency: 'USD', instrument_type: 'reference', contract: 'COPPER', quote_unit: 'USD/metric ton', avSymbol: 'COPPER', function: 'COPPER', historyFunction: 'COPPER', mode: 'daily_reference', source: 'https://www.alphavantage.co/documentation/' },
  tin: { name: '锡', price: 256780, change: -0.42, score: 43, currency: 'USD', instrument_type: 'exchange_futures', contract: 'LME Tin', quote_unit: 'USD/metric ton', avSymbol: 'TIN', function: '', historyFunction: '', mode: 'licensed_delayed_required', source: 'https://www.lme.com/Metals/Non-ferrous/LME-Tin' },
  crude: { name: '原油', price: 78.42, change: -0.67, score: 47, currency: 'USD', instrument_type: 'reference', contract: 'WTI', quote_unit: 'USD/barrel', avSymbol: 'WTI', function: 'WTI', historyFunction: 'WTI', mode: 'daily_reference', source: 'https://www.alphavantage.co/documentation/' },
  usd: { name: '美元', price: 7.18, change: -0.18, score: 52, currency: 'USD/CNY', instrument_type: 'fx', contract: 'USD/CNY', quote_unit: 'CNY per USD', avSymbol: 'USD/CNY', function: 'CURRENCY_EXCHANGE_RATE', historyFunction: 'FX_DAILY', mode: 'fx_realtime', source: 'https://www.alphavantage.co/documentation/' },
};

// COMEX Gold continuous futures are deliberately kept outside the six-item
// international board.  This prevents a USD/oz spot quote from being shown as
// a futures quote while still giving the UI a dedicated one-troy-ounce field.
const COMEX_GOLD_DEFINITION = {
  symbol: 'comex_gold_1oz',
  name: 'COMEX黄金主连',
  price: null,
  score: 72,
  currency: 'COMEX_USD',
  instrument_type: 'futures',
  contract: 'GC1!',
  quote_unit: 'USD/oz',
  mode: 'licensed_realtime_required',
  source: 'https://www.cmegroup.com/markets/metals/precious/gold.html',
};

const LIVE_MODES = new Set(['spot_realtime', 'fx_realtime']);
const BOARD_TTL_MS = 15_000;
let boardCache = null;
let boardExpiresAt = 0;
let boardCacheKey = '';
const CANDLE_TTL_MS = 60_000;
const CANDLE_INTERVALS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'yearly']);
const candleCache = new Map();
const QUOTE_TTL_MS = 15_000;
const quoteCache = new Map();
const COMEX_QUOTE_TTL_MS = 15_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 3_000;
let comexGoldCache = null;
let comexGoldExpiresAt = 0;
let comexGoldCacheKey = '';

function nowIso() {
  return new Date().toISOString();
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=15, stale-while-revalidate=30',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function definition(symbol) {
  return MARKET_DEFINITIONS[symbol] || MARKET_DEFINITIONS.gold;
}

export function demoSnapshot(symbol, overrides = {}) {
  const item = definition(symbol);
  return {
    symbol,
    name: item.name,
    instrument_type: item.instrument_type,
    contract: item.contract,
    quote_unit: item.quote_unit,
    // Keep the static definition only as a generator for local chart shapes.
    // Never expose it as a quote when a provider has not returned a value.
    price: null,
    change_pct: null,
    currency: item.currency,
    bull_bear_score: item.score,
    provider: 'free',
    delayed: true,
    data_mode: 'demo_fallback_no_key',
    source_url: item.source,
    quote_status: 'unavailable',
    freshness: '暂无可核验报价',
    as_of: nowIso(),
    ...overrides,
  };
}

function valueFrom(payload, keys) {
  for (const key of keys) {
    const raw = payload?.[key];
    const value = Number(raw);
    if (raw !== undefined && raw !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function textFrom(payload, keys) {
  for (const key of keys) {
    const raw = payload?.[key];
    if (raw !== undefined && raw !== null && String(raw).trim()) return String(raw);
  }
  return null;
}

function looseNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/[,，\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function looseValueFrom(payload, keys) {
  for (const key of keys) {
    const raw = payload?.[key];
    const value = looseNumber(raw);
    if (value !== null) return value;
  }
  return null;
}

function looseTextFrom(payload, keys) {
  for (const key of keys) {
    const raw = payload?.[key];
    if (raw !== undefined && raw !== null && String(raw).trim()) return String(raw).trim();
  }
  return null;
}

function comexRecords(payload, output = [], depth = 0, seen = new Set()) {
  if (!payload || depth > 6) return output;
  if (Array.isArray(payload)) {
    payload.forEach((item) => comexRecords(item, output, depth + 1, seen));
    return output;
  }
  if (typeof payload !== 'object' || seen.has(payload)) return output;
  seen.add(payload);
  const price = looseValueFrom(payload, ['price', 'last', 'last_price', 'lastPrice', 'latest', 'latest_price', 'close', 'settlement', 'settle', 'value', '05. price', '最新价', '最新', '成交价']);
  if (price !== null) output.push({ payload, price });
  Object.values(payload).forEach((value) => comexRecords(value, output, depth + 1, seen));
  return output;
}

function parseComexQuote(payload) {
  const record = comexRecords(payload)[0];
  if (!record) throw new Error('COMEX price missing');
  const row = record.payload;
  const price = record.price;
  const directChange = looseValueFrom(row, ['change_pct', 'changePercent', 'percent_change', 'percentChange', 'pct_change', '涨跌幅']);
  const absoluteChange = looseValueFrom(row, ['change', 'net_change', 'netChange', 'delta', '涨跌']);
  const previous = looseValueFrom(row, ['previous_close', 'previousClose', 'prev_close', 'prior_close', '昨结']);
  const change = directChange !== null
    ? directChange
    : absoluteChange !== null && previous
      ? (absoluteChange / previous) * 100
      : null;
  const asOf = looseTextFrom(row, ['as_of', 'asOf', 'timestamp', 'updated_at', 'updatedAt', 'time', 'datetime', 'date', '更新时间']);
  const delayed = row?.delayed === true || row?.is_delayed === true || row?.delayed === 'true' || row?.is_delayed === 'true';
  return {
    price,
    change_pct: change,
    as_of: asOf || nowIso(),
    delayed,
    source_url: looseTextFrom(row, ['source_url', 'sourceUrl', 'source']) || null,
  };
}

function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

async function fetchProvider(url, options = {}, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function comexPendingSnapshot(reason = '未接入 COMEX 授权行情') {
  return {
    symbol: COMEX_GOLD_DEFINITION.symbol,
    name: COMEX_GOLD_DEFINITION.name,
    instrument_type: COMEX_GOLD_DEFINITION.instrument_type,
    contract: COMEX_GOLD_DEFINITION.contract,
    quote_unit: COMEX_GOLD_DEFINITION.quote_unit,
    price: null,
    change_pct: null,
    currency: COMEX_GOLD_DEFINITION.currency,
    bull_bear_score: COMEX_GOLD_DEFINITION.score,
    provider: 'none',
    delayed: true,
    available: false,
    data_mode: COMEX_GOLD_DEFINITION.mode,
    data_label: 'COMEX主连 · 待授权行情',
    source_url: COMEX_GOLD_DEFINITION.source,
    quote_status: 'authorization_required',
    freshness: reason,
    as_of: nowIso(),
    note: 'GC1! 为 COMEX 黄金连续合约，价格单位为美元/金衡盎司（USD/oz）；未接入授权行情时不以黄金现货或沪金价格替代。',
  };
}

async function fetchComexGold(env) {
  const url = envValue(env, ['COMEX_GOLD_FUTURES_URL', 'COMEX_GOLD_URL', 'COMEX_GC_URL']);
  if (!url) return null;
  const token = envValue(env, ['COMEX_GOLD_FUTURES_TOKEN', 'COMEX_GOLD_TOKEN', 'COMEX_GC_TOKEN']);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchProvider(url, { headers });
  if (!response.ok) throw new Error(`COMEX provider ${response.status}`);
  const payload = await response.json();
  const parsed = parseComexQuote(payload);
  return { ...parsed, provider: 'comex_authorized', source_url: parsed.source_url || url };
}

export async function comexGoldSnapshot(env = {}) {
  const configuredUrl = envValue(env, ['COMEX_GOLD_FUTURES_URL', 'COMEX_GOLD_URL', 'COMEX_GC_URL']);
  const token = envValue(env, ['COMEX_GOLD_FUTURES_TOKEN', 'COMEX_GOLD_TOKEN', 'COMEX_GC_TOKEN']);
  const current = Date.now();
  // Include the credential in the key so a newly rotated token cannot reuse a
  // quote/error cached under the previous credential.
  const cacheKey = `${configuredUrl || 'unconfigured'}|${token}`;
  if (comexGoldCache && comexGoldCacheKey === cacheKey && current < comexGoldExpiresAt) return comexGoldCache;
  if (!configuredUrl) {
    const pending = comexPendingSnapshot();
    comexGoldCache = pending;
    comexGoldCacheKey = cacheKey;
    comexGoldExpiresAt = Date.now() + COMEX_QUOTE_TTL_MS;
    return pending;
  }
  try {
    const quote = await fetchComexGold(env);
    const payload = {
      ...comexPendingSnapshot(),
      ...quote,
      provider: quote.provider,
      available: true,
      delayed: quote.delayed,
      data_mode: 'comex_authorized_quote',
      data_label: quote.delayed ? 'COMEX主连 · 授权延时' : 'COMEX主连 · 授权实时',
      quote_status: 'provider_returned',
      freshness: quote.delayed ? '授权延时源返回（时效以 Provider 为准）' : '授权源返回（时效以 Provider 为准）',
      source_url: quote.source_url || configuredUrl,
      note: 'GC1! COMEX 黄金连续合约，价格单位为美元/金衡盎司（USD/oz）；与黄金现货 XAU/USD、沪金 AU主连分开核对。',
    };
    comexGoldCache = payload;
    comexGoldCacheKey = cacheKey;
    comexGoldExpiresAt = Date.now() + COMEX_QUOTE_TTL_MS;
    return payload;
  } catch {
    const failed = comexPendingSnapshot('COMEX 授权行情 Provider 异常，未使用现货替代值');
    failed.data_mode = 'comex_provider_error';
    failed.quote_status = 'provider_error';
    failed.data_label = 'COMEX主连 · Provider 异常';
    failed.freshness = 'Provider 异常，未使用旧报价';
    comexGoldCache = failed;
    comexGoldCacheKey = cacheKey;
    comexGoldExpiresAt = Date.now() + COMEX_QUOTE_TTL_MS;
    return failed;
  }
}

function parseAlpha(payload, fn) {
  if (fn === 'GOLD_SILVER_SPOT') {
    return { price: valueFrom(payload, ['price', '05. price']), asOf: textFrom(payload, ['last_refreshed', '7. Last Refreshed']), change: null };
  }
  if (fn === 'CURRENCY_EXCHANGE_RATE') {
    return { price: valueFrom(payload, ['5. Exchange Rate', 'exchange_rate', 'rate']), asOf: textFrom(payload, ['6. Last Refreshed', 'timestamp']), change: null };
  }
  const rows = payload?.data || payload?.values || payload?.series || [];
  const parsed = Array.isArray(rows) ? rows.map((row) => ({
    price: valueFrom(row, ['value', 'close', 'price', '4. close']),
    asOf: textFrom(row, ['date', 'timestamp', 'time']),
  })).filter((row) => row.price !== null) : [];
  if (!parsed.length) return { price: valueFrom(payload, ['price', 'value', '05. price']), asOf: null, change: null };
  const latest = parsed[0];
  const previous = parsed[1];
  return {
    price: latest.price,
    asOf: latest.asOf,
    change: previous?.price ? ((latest.price - previous.price) / previous.price) * 100 : null,
  };
}

function apiKey(env) {
  return env?.ALPHAVANTAGE_API_KEY || env?.alpha_vantage_api_key || env?.ALPHA_VANTAGE_API_KEY || '';
}

async function fetchAlpha(symbol, env) {
  const item = definition(symbol);
  const key = apiKey(env);
  if (!key || !item.function) return null;
  const cacheKey = `${symbol}:${key}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.at < QUOTE_TTL_MS) return cached.quote;
  const params = new URLSearchParams({ function: item.function, apikey: key });
  if (item.function === 'GOLD_SILVER_SPOT') params.set('symbol', item.avSymbol);
  if (item.function === 'CURRENCY_EXCHANGE_RATE') {
    params.set('from_currency', 'USD');
    params.set('to_currency', 'CNY');
  }
  if (item.function !== 'GOLD_SILVER_SPOT' && item.function !== 'CURRENCY_EXCHANGE_RATE') {
    params.set('interval', 'daily');
    params.set('datatype', 'json');
  }
  const response = await fetchProvider(`https://www.alphavantage.co/query?${params.toString()}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Alpha Vantage ${response.status}`);
  const payload = await response.json();
  const parsed = parseAlpha(payload, item.function);
  if (!parsed.price || !Number.isFinite(parsed.price)) throw new Error('price missing');
  const quote = {
    price: parsed.price,
    change_pct: parsed.change,
    as_of: parsed.asOf || nowIso(),
  };
  quoteCache.set(cacheKey, { at: Date.now(), quote });
  return quote;
}

export async function marketSnapshot(symbol, env = {}) {
  const normalized = String(symbol || '').toLowerCase();
  if (normalized === COMEX_GOLD_DEFINITION.symbol || normalized === 'comex_gold' || normalized === 'gc1!') {
    return comexGoldSnapshot(env);
  }
  if (!MARKET_DEFINITIONS[normalized]) return demoSnapshot(normalized || 'gold', { data_mode: 'demo_fallback' });
  const item = MARKET_DEFINITIONS[normalized];
  if (!apiKey(env)) {
    return demoSnapshot(normalized, {
      data_mode: item.mode === 'licensed_delayed_required' ? item.mode : 'demo_fallback_no_key',
      quote_status: item.mode === 'licensed_delayed_required' ? 'authorization_required' : 'waiting_key',
      freshness: item.mode === 'licensed_delayed_required' ? '交易所授权数据' : '待配置免费 Key',
    });
  }
  if (!item.function) {
    return demoSnapshot(normalized, { data_mode: item.mode, quote_status: 'authorization_required', freshness: '交易所授权数据' });
  }
  try {
    const live = await fetchAlpha(normalized, env);
    return demoSnapshot(normalized, {
      ...live,
      provider: 'alpha_vantage',
      data_mode: item.mode,
      quote_status: 'provider_returned',
      delayed: !LIVE_MODES.has(item.mode),
      freshness: item.mode === 'daily_reference' ? '日频参考' : '免费源实时返回',
    });
  } catch {
    return demoSnapshot(normalized, { data_mode: 'fallback_provider_error', quote_status: 'provider_error', freshness: 'Provider 异常，未使用旧报价' });
  }
}

function calibrationStatus(item) {
  const priceAvailable = typeof item.price === 'number' && Number.isFinite(item.price);
  if (item.quote_status === 'provider_error' || item.data_mode === 'fallback_provider_error') return 'provider_error';
  if (item.data_mode === 'licensed_delayed_required') return priceAvailable ? 'provider_aligned' : 'authorization_required';
  if (item.data_mode === 'spot_realtime' || item.data_mode === 'fx_realtime') return priceAvailable ? 'provider_aligned' : 'waiting_key';
  if (item.data_mode === 'daily_reference') return priceAvailable ? 'reference_only' : 'waiting_key';
  return priceAvailable ? 'provider_aligned' : 'waiting_key';
}

function calibrationNote(status, item) {
  if (status === 'provider_aligned') return '同一 Provider 返回报价；可用于同口径比较。';
  if (status === 'reference_only') return '仅日频参考，不等同交易所实时期货报价。';
  if (status === 'authorization_required') return '交易所级报价需要持牌行情或经纪商授权。';
  if (status === 'provider_error') return 'Provider 暂时异常；未回退到旧静态价格。';
  return item.data_mode === 'demo_fallback_no_key' ? '尚未配置免费 Key；当前不显示报价。' : '等待可核验 Provider 返回。';
}

function calibrationFor(item) {
  const status = calibrationStatus(item);
  const asOf = item.as_of ? Date.parse(item.as_of) : NaN;
  return {
    symbol: item.symbol,
    name: item.name,
    contract: item.contract,
    instrument_type: item.instrument_type,
    quote_unit: item.quote_unit,
    currency: item.currency,
    price_available: typeof item.price === 'number' && Number.isFinite(item.price),
    source_present: Boolean(item.source_url),
    timestamp_present: Number.isFinite(asOf),
    age_seconds: Number.isFinite(asOf) ? Math.max(0, Math.round((Date.now() - asOf) / 1000)) : null,
    status,
    note: calibrationNote(status, item),
  };
}

export async function marketBoard(env = {}) {
  const current = Date.now();
  const boardKey = [
    apiKey(env),
    envValue(env, ['COMEX_GOLD_FUTURES_URL', 'COMEX_GOLD_URL', 'COMEX_GC_URL']),
    envValue(env, ['COMEX_GOLD_FUTURES_TOKEN', 'COMEX_GOLD_TOKEN', 'COMEX_GC_TOKEN']),
  ].join('|');
  if (boardCache && boardCacheKey === boardKey && current < boardExpiresAt) return boardCache;
  const started = Date.now();
  const symbols = Object.keys(MARKET_DEFINITIONS);
  const [items, comexGold] = await Promise.all([
    Promise.all(symbols.map((symbol) => marketSnapshot(symbol, env))),
    comexGoldSnapshot(env),
  ]);
  const calibration = items.map(calibrationFor);
  const syncedAt = nowIso();
  boardCache = {
    items,
    comex_gold: comexGold,
    calibration,
    as_of: syncedAt,
    sync: {
      status: 'ok',
      synced_at: syncedAt,
      latency_ms: Math.max(0, Date.now() - started),
      refresh_mode: 'polling',
      cache_ttl_seconds: BOARD_TTL_MS / 1000,
      live_count: items.filter((item) => LIVE_MODES.has(item.data_mode)).length,
      calibrated_count: calibration.filter((item) => ['provider_aligned', 'reference_only'].includes(item.status)).length,
      item_count: items.length,
    },
    coverage: [
      { name: '黄金 / 白银现货', mode: 'spot_realtime', source_url: 'https://www.alphavantage.co/documentation/' },
      { name: 'COMEX 黄金主连 GC1! · 1金衡盎司', mode: comexGold.data_mode, source_url: COMEX_GOLD_DEFINITION.source },
      { name: '美元 USD/CNY', mode: 'fx_realtime', source_url: 'https://www.alphavantage.co/documentation/' },
      { name: '铜 / WTI 原油', mode: 'daily_reference', source_url: 'https://www.alphavantage.co/documentation/' },
      { name: 'LME 锡', mode: 'licensed_delayed_required', source_url: 'https://www.lme.com/Metals/Non-ferrous/LME-Tin' },
    ],
  };
  boardCacheKey = boardKey;
  boardExpiresAt = Date.now() + BOARD_TTL_MS;
  return boardCache;
}

function normalizeCandleInterval(symbol, requested) {
  const value = String(requested || 'daily').toLowerCase();
  return CANDLE_INTERVALS.has(value) ? value : 'daily';
}

function providerInterval(symbol, interval) {
  const item = definition(symbol);
  if (interval === 'hourly') return null;
  if (interval === 'yearly') return item.historyFunction === 'COPPER' ? 'annual' : 'monthly';
  if (item.historyFunction === 'COPPER') return interval === 'monthly' ? 'monthly' : null;
  return interval;
}

function intervalAvailable(symbol, interval) {
  return providerInterval(symbol, interval) !== null;
}

function numberFrom(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowNumber(row, keys) {
  for (const key of keys) {
    const value = numberFrom(row?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function rowText(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return null;
}

function historyRows(payload) {
  const rows = [];
  const push = (time, row) => {
    if (!row || typeof row !== 'object') return;
    const close = rowNumber(row, ['close', '4. close', 'value', 'price', '5. value']);
    const date = time || rowText(row, ['date', 'timestamp', 'time', 'datetime']);
    if (close === null || !date) return;
    rows.push({
      time: String(date),
      open: rowNumber(row, ['open', '1. open']),
      high: rowNumber(row, ['high', '2. high']),
      low: rowNumber(row, ['low', '3. low']),
      close,
      volume: rowNumber(row, ['volume', '5. volume', '6. volume']),
    });
  };
  const arrayPayload = payload?.data || payload?.values || payload?.series;
  if (Array.isArray(arrayPayload)) arrayPayload.forEach((row) => push(null, row));
  for (const [key, value] of Object.entries(payload || {})) {
    if (!value || Array.isArray(value) || typeof value !== 'object') continue;
    const looksLikeSeries = /time series|fx \(/i.test(key) || Object.values(value).some((row) => row && typeof row === 'object' && ('4. close' in row || 'value' in row || 'close' in row));
    if (!looksLikeSeries) continue;
    for (const [time, row] of Object.entries(value)) push(time, row);
  }
  const deduped = new Map();
  rows.forEach((row) => deduped.set(row.time, row));
  return [...deduped.values()].sort((a, b) => String(a.time).localeCompare(String(b.time))).slice(-60);
}

function toCandleRows(rows, item) {
  let previous = null;
  let synthetic = false;
  const candles = rows.map((row) => {
    const close = row.close;
    const open = row.open ?? previous ?? close;
    const range = Math.max(Math.abs(close) * (item.name === '原油' ? 0.006 : 0.004), 0.0001);
    const high = row.high ?? Math.max(open, close) + range;
    const low = row.low ?? Math.max(0, Math.min(open, close) - range);
    if (row.open === null || row.high === null || row.low === null) synthetic = true;
    previous = close;
    return { time: row.time, open, high, low, close, ...(row.volume === null ? {} : { volume: row.volume }) };
  });
  return { candles, synthetic };
}

function aggregateYearly(candles) {
  const years = new Map();
  [...candles].sort((a, b) => String(a.time).localeCompare(String(b.time))).forEach((candle) => {
    const date = new Date(candle.time);
    const year = Number.isNaN(date.getTime()) ? String(candle.time).slice(0, 4) : String(date.getUTCFullYear());
    if (!year || year === 'NaN') return;
    const current = years.get(year);
    if (!current) {
      years.set(year, { ...candle, time: `${year}-12-31T00:00:00.000Z` });
      return;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    if (Number.isFinite(candle.volume)) current.volume = (current.volume || 0) + candle.volume;
  });
  return [...years.values()];
}

function unsupportedIntervalOverrides(symbol, interval) {
  if (interval === 'hourly') {
    return {
      provider: 'free',
      data_mode: 'intraday_not_supported',
      data_label: '小时K线需实时源',
      freshness: '免费商品源不支持小时历史',
      interval_note: '免费商品历史接口不提供小时级历史；配置持牌实时/延时 intraday Provider 后才会显示真实小时 OHLC。',
      note: '当前小时图仅作界面占位，所有蜡烛均标记为合成数据，不代表交易所实时 OHLC。',
    };
  }
  if (symbol === 'copper' && ['daily', 'weekly'].includes(interval)) {
    return {
      provider: 'free',
      data_mode: 'interval_not_supported',
      data_label: '当前源仅提供月/季/年频',
      freshness: '免费月频参考',
      interval_note: '铜的免费全球价格源只提供月、季、年频；日/周需配置期货行情 Provider。',
      note: '当前周期没有可用的免费历史 OHLC，未将月频数据冒充日/周线。',
    };
  }
  return {};
}

function referenceOverrides(symbol, quote, latestBarKind = 'reference_quote') {
  if (!quote?.price || !Number.isFinite(quote.price)) return {};
  const item = definition(symbol);
  const label = item.mode === 'fx_realtime' ? '免费外汇实时' : item.mode === 'daily_reference' ? '免费日频参考' : '免费现货实时';
  return {
    reference_price: quote.price,
    reference_as_of: quote.as_of || nowIso(),
    reference_provider: 'alpha_vantage',
    reference_data_mode: item.mode,
    reference_data_label: label,
    latest_bar_kind: latestBarKind,
    calibration_status: latestBarKind === 'reference_quote' ? 'reference_aligned' : 'reference_aligned_synthetic',
  };
}

function candleFallback(symbol, interval, overrides = {}) {
  const item = definition(symbol);
  const referencePrice = numberFrom(overrides.reference_price);
  const hasReference = referencePrice !== null;
  const shapePrice = item.price;
  const referenceAsOf = hasReference ? (overrides.reference_as_of || nowIso()) : null;
  const rows = [];
  const step = interval === 'hourly' ? 60 * 60 * 1000 : interval === 'monthly' ? 30 * 86400000 : interval === 'yearly' ? 365 * 86400000 : interval === 'weekly' ? 7 * 86400000 : 86400000;
  let previous = shapePrice * 0.972;
  for (let index = 0; index < 36; index += 1) {
    const close = index === 35 && hasReference ? referencePrice : shapePrice * (0.972 + 0.004 * Math.sin(index * 0.63) + (index / 35) * 0.012);
    const open = previous;
    const range = Math.max(Math.abs(close) * 0.004, 0.0001);
    rows.push({
      time: new Date(Date.now() - (35 - index) * step).toISOString(),
      open,
      high: Math.max(open, close) + range,
      low: Math.max(0, Math.min(open, close) - range),
      close,
    });
    previous = close;
  }
  return {
    symbol,
    name: item.name,
    instrument_type: item.instrument_type,
    contract: item.contract,
    quote_unit: item.quote_unit,
    interval,
    requested_interval: interval,
    effective_interval: overrides.effective_interval || interval,
    source_interval: overrides.source_interval || interval,
    provider: overrides.provider || 'demo',
    data_mode: overrides.data_mode || (item.mode === 'licensed_delayed_required' ? item.mode : 'demo_fallback_no_key'),
    currency: item.currency,
    data_label: overrides.data_label || (item.mode === 'licensed_delayed_required' ? '交易所授权待接入' : '本地演示K线'),
    is_live: false,
    synthetic: true,
    as_of: nowIso(),
    reference_price: referencePrice,
    reference_as_of: referenceAsOf,
    reference_provider: hasReference ? (overrides.reference_provider || 'alpha_vantage') : 'demo',
    reference_data_mode: hasReference ? (overrides.reference_data_mode || item.mode) : 'demo_fallback_no_key',
    reference_data_label: hasReference ? (overrides.reference_data_label || (item.mode === 'daily_reference' ? '免费日频参考' : item.mode === 'fx_realtime' ? '免费外汇实时' : '免费现货实时')) : '暂无可核验参考价',
    latest_bar_kind: overrides.latest_bar_kind || (hasReference ? 'reference_quote_on_synthetic' : 'synthetic'),
    calibration_status: overrides.calibration_status || (hasReference ? 'reference_aligned' : 'demo_only'),
    source_url: item.source,
    freshness: overrides.freshness || (overrides.data_mode === 'fallback_provider_error' ? 'Provider 异常，已回退演示K线' : '演示数据'),
    note: overrides.note || '免费源未返回可用历史 K 线，已显示本地演示形态；不代表交易所实时 OHLC。',
    interval_note: overrides.interval_note,
    candles: rows,
  };
}

function historyParams(symbol, interval, key) {
  const item = definition(symbol);
  const fxFunction = interval === 'weekly' ? 'FX_WEEKLY' : interval === 'monthly' ? 'FX_MONTHLY' : 'FX_DAILY';
  const functionName = item.historyFunction === 'FX_DAILY' ? fxFunction : item.historyFunction;
  const params = new URLSearchParams({ function: functionName, apikey: key, datatype: 'json' });
  if (item.historyFunction === 'GOLD_SILVER_HISTORY') {
    params.set('symbol', item.avSymbol);
    params.set('interval', interval);
  } else if (item.historyFunction === 'FX_DAILY') {
    params.set('from_symbol', 'USD');
    params.set('to_symbol', 'CNY');
    params.set('outputsize', 'compact');
  } else {
    params.set('interval', interval);
  }
  return params;
}

async function fetchAlphaCandles(symbol, interval, env) {
  const item = definition(symbol);
  const key = apiKey(env);
  if (!key || !item.historyFunction) return null;
  const sourceInterval = providerInterval(symbol, interval);
  if (!sourceInterval) throw new Error('interval unsupported');
  const response = await fetchProvider(`https://www.alphavantage.co/query?${historyParams(symbol, sourceInterval, key).toString()}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Alpha Vantage ${response.status}`);
  const payload = await response.json();
  if (payload?.Note || payload?.Information || payload?.['Error Message']) throw new Error('Alpha Vantage response not usable');
  const rows = historyRows(payload);
  if (rows.length < 2) throw new Error('history missing');
  let parsed = toCandleRows(rows, item);
  if (interval === 'yearly' && sourceInterval !== 'annual') {
    parsed = { candles: aggregateYearly(parsed.candles), synthetic: parsed.synthetic };
  }
  if (parsed.candles.length < 2) throw new Error('aggregated history missing');
  let asOf = parsed.candles.at(-1)?.time || nowIso();
  let isLive = false;
  let latestBarKind = 'period_close';
  let referenceQuote = null;
  let note = parsed.synthetic ? '历史接口主要提供收盘价，OHLC 已按相邻收盘价生成，仅用于结构观察。' : '历史接口返回 OHLC；当前数据按免费源周期更新。';
  if (item.function && item.mode !== 'licensed_delayed_required') {
    referenceQuote = await fetchAlpha(symbol, env);
    if (referenceQuote?.price) {
      const last = parsed.candles.at(-1);
      const current = { time: referenceQuote.as_of || nowIso(), open: last?.close ?? referenceQuote.price, high: Math.max(last?.close ?? referenceQuote.price, referenceQuote.price), low: Math.min(last?.close ?? referenceQuote.price, referenceQuote.price), close: referenceQuote.price };
      const sameDay = last && String(last.time).slice(0, 10) === String(current.time).slice(0, 10);
      if (interval === 'daily' && sameDay) parsed.candles[parsed.candles.length - 1] = current;
      else if (interval === 'daily') parsed.candles.push(current);
      if (interval === 'daily') {
        asOf = current.time;
        latestBarKind = 'reference_quote';
      }
      isLive = LIVE_MODES.has(item.mode) && interval === 'daily';
      note = `${parsed.synthetic ? '历史收盘价 OHLC 为合成结构；' : ''}${latestBarKind === 'reference_quote' ? `最后一根为${item.mode === 'fx_realtime' ? '外汇' : item.mode === 'daily_reference' ? '免费日频参考' : '免费现货'}当前报价，不等同交易所实时期货K线。` : `主力参考价为当前${item.mode === 'fx_realtime' ? '外汇' : item.mode === 'daily_reference' ? '日频参考' : '现货'}报价；当前 ${interval} K 线显示该周期最近收盘，二者并非同一根数据。`}`;
    }
  }
  const referencePrice = referenceQuote?.price ?? parsed.candles.at(-1)?.close ?? null;
  const referenceAsOf = referenceQuote?.as_of || asOf;
  const referenceLabel = item.mode === 'fx_realtime' ? '免费外汇实时' : item.mode === 'daily_reference' ? '免费日频参考' : '免费现货实时';
  return {
    symbol,
    name: item.name,
    instrument_type: item.instrument_type,
    contract: item.contract,
    quote_unit: item.quote_unit,
    interval,
    requested_interval: interval,
    effective_interval: interval,
    source_interval: sourceInterval,
    provider: 'alpha_vantage',
    data_mode: item.mode,
    currency: item.currency,
    data_label: isLive ? `免费${item.mode === 'fx_realtime' ? '外汇' : '现货'}实时 + 历史K线` : item.mode === 'daily_reference' ? '免费日频参考K线' : '免费历史K线',
    is_live: isLive,
    synthetic: parsed.synthetic,
    as_of: asOf,
    reference_price: referencePrice,
    reference_as_of: referenceAsOf,
    reference_provider: referenceQuote ? 'alpha_vantage' : 'alpha_vantage_history',
    reference_data_mode: item.mode,
    reference_data_label: referenceQuote ? referenceLabel : '历史收盘价',
    latest_bar_kind: latestBarKind,
    calibration_status: latestBarKind === 'reference_quote' ? 'reference_aligned' : referenceQuote ? 'period_close_vs_reference' : 'history_only',
    source_url: item.source,
    freshness: isLive ? '当前报价实时；历史按所选周期' : item.mode === 'daily_reference' ? '日频参考' : '历史周期',
    note,
    calibration_note: latestBarKind === 'reference_quote' ? '主力参考价与日K最后一根当前报价使用同一 Provider 快照。' : referenceQuote ? `主力参考价 ${referencePrice} 与 ${interval} 最近收盘分别代表当前报价和周期收盘，请勿直接比较为同一时点。` : '未取得独立当前报价，仅显示历史收盘。',
    interval_note: sourceInterval === 'monthly' && interval === 'yearly' ? '年线由可用月线按自然年聚合，最后一年可能为未完结年度。' : undefined,
    candles: parsed.candles.slice(-48),
  };
}

export async function marketCandles(symbol, requestedInterval = 'daily', env = {}) {
  const normalized = String(symbol || '').toLowerCase();
  const item = MARKET_DEFINITIONS[normalized] ? definition(normalized) : definition('gold');
  const actualSymbol = MARKET_DEFINITIONS[normalized] ? normalized : 'gold';
  const interval = normalizeCandleInterval(actualSymbol, requestedInterval);
  // Provider configuration is part of the cache identity.  Without this, a
  // request made before an API key is configured can mask the first valid
  // provider response until the one-minute candle TTL expires.
  const key = `${actualSymbol}:${interval}:${apiKey(env)}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.at < CANDLE_TTL_MS) return cached.payload;
  const intervalOverrides = unsupportedIntervalOverrides(actualSymbol, interval);
  if (!intervalAvailable(actualSymbol, interval)) {
    let referenceQuote = null;
    if (apiKey(env) && item.function && item.mode !== 'licensed_delayed_required') {
      try { referenceQuote = await fetchAlpha(actualSymbol, env); } catch { referenceQuote = null; }
    }
    const payload = candleFallback(actualSymbol, interval, { ...intervalOverrides, ...referenceOverrides(actualSymbol, referenceQuote, 'reference_quote_on_synthetic') });
    candleCache.set(key, { at: Date.now(), payload });
    return payload;
  }
  if (!apiKey(env)) {
    const payload = candleFallback(actualSymbol, interval, item.mode === 'licensed_delayed_required' ? { data_mode: item.mode, data_label: '交易所授权待接入', freshness: '交易所授权数据', note: '锡的交易所级实时/延迟K线需要持牌行情授权；当前仅展示演示形态。' } : intervalOverrides);
    candleCache.set(key, { at: Date.now(), payload });
    return payload;
  }
  if (!item.historyFunction) {
    const payload = candleFallback(actualSymbol, interval, { provider: 'free', data_mode: item.mode, data_label: '交易所授权待接入', freshness: '交易所授权数据', note: '该品种的交易所级实时/延迟K线需要持牌行情授权；当前仅展示演示形态。' });
    candleCache.set(key, { at: Date.now(), payload });
    return payload;
  }
  try {
    const payload = await fetchAlphaCandles(actualSymbol, interval, env);
    candleCache.set(key, { at: Date.now(), payload });
    return payload;
  } catch {
    let referenceQuote = null;
    if (apiKey(env) && item.function && item.mode !== 'licensed_delayed_required') {
      try { referenceQuote = await fetchAlpha(actualSymbol, env); } catch { referenceQuote = null; }
    }
    const payload = candleFallback(actualSymbol, interval, { ...intervalOverrides, ...referenceOverrides(actualSymbol, referenceQuote, 'reference_quote_on_synthetic'), provider: 'free', data_mode: 'fallback_provider_error', data_label: intervalOverrides.data_label || '免费源暂时异常 · 演示K线', freshness: intervalOverrides.freshness || 'Provider 异常，已回退演示K线' });
    candleCache.set(key, { at: Date.now(), payload });
    return payload;
  }
}
