const MARKET_DEFINITIONS = {
  gold: { name: '黄金', price: 2654.8, change: 1.28, score: 72, currency: 'USD', avSymbol: 'GOLD', function: 'GOLD_SILVER_SPOT', historyFunction: 'GOLD_SILVER_HISTORY', mode: 'spot_realtime', source: 'https://www.alphavantage.co/documentation/' },
  silver: { name: '白银', price: 31.642, change: 0.86, score: 64, currency: 'USD', avSymbol: 'SILVER', function: 'GOLD_SILVER_SPOT', historyFunction: 'GOLD_SILVER_HISTORY', mode: 'spot_realtime', source: 'https://www.alphavantage.co/documentation/' },
  copper: { name: '铜', price: 9842.5, change: 0.34, score: 58, currency: 'USD', avSymbol: 'COPPER', function: 'COPPER', historyFunction: 'COPPER', mode: 'daily_reference', source: 'https://www.alphavantage.co/documentation/' },
  tin: { name: '锡', price: 256780, change: -0.42, score: 43, currency: 'USD', avSymbol: 'TIN', function: '', historyFunction: '', mode: 'licensed_delayed_required', source: 'https://www.lme.com/Metals/Non-ferrous/LME-Tin' },
  crude: { name: '原油', price: 78.42, change: -0.67, score: 47, currency: 'USD', avSymbol: 'WTI', function: 'WTI', historyFunction: 'WTI', mode: 'daily_reference', source: 'https://www.alphavantage.co/documentation/' },
  usd: { name: '美元', price: 7.18, change: -0.18, score: 52, currency: 'USD/CNY', avSymbol: 'USD/CNY', function: 'CURRENCY_EXCHANGE_RATE', historyFunction: 'FX_DAILY', mode: 'fx_realtime', source: 'https://www.alphavantage.co/documentation/' },
};

const LIVE_MODES = new Set(['spot_realtime', 'fx_realtime']);
const BOARD_TTL_MS = 15_000;
let boardCache = null;
let boardExpiresAt = 0;
const CANDLE_TTL_MS = 60_000;
const CANDLE_INTERVALS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'yearly']);
const candleCache = new Map();

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
    price: item.price,
    change_pct: item.change,
    currency: item.currency,
    bull_bear_score: item.score,
    provider: 'free',
    delayed: true,
    data_mode: 'demo_fallback_no_key',
    source_url: item.source,
    freshness: '待配置免费 Key',
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
  const response = await fetch(`https://www.alphavantage.co/query?${params.toString()}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Alpha Vantage ${response.status}`);
  const payload = await response.json();
  const parsed = parseAlpha(payload, item.function);
  if (!parsed.price || !Number.isFinite(parsed.price)) throw new Error('price missing');
  return {
    price: parsed.price,
    change_pct: parsed.change,
    as_of: parsed.asOf || nowIso(),
  };
}

export async function marketSnapshot(symbol, env = {}) {
  const normalized = String(symbol || '').toLowerCase();
  if (!MARKET_DEFINITIONS[normalized]) return demoSnapshot(normalized || 'gold', { data_mode: 'demo_fallback' });
  const item = MARKET_DEFINITIONS[normalized];
  if (!apiKey(env)) {
    return demoSnapshot(normalized, {
      data_mode: item.mode === 'licensed_delayed_required' ? item.mode : 'demo_fallback_no_key',
      freshness: item.mode === 'licensed_delayed_required' ? '交易所授权数据' : '待配置免费 Key',
    });
  }
  if (!item.function) {
    return demoSnapshot(normalized, { data_mode: item.mode, freshness: '交易所授权数据' });
  }
  try {
    const live = await fetchAlpha(normalized, env);
    return demoSnapshot(normalized, {
      ...live,
      provider: 'alpha_vantage',
      data_mode: item.mode,
      delayed: !LIVE_MODES.has(item.mode),
      freshness: item.mode === 'daily_reference' ? '日频参考' : '免费源实时返回',
    });
  } catch {
    return demoSnapshot(normalized, { data_mode: 'fallback_provider_error', freshness: 'Provider 异常，已回退演示值' });
  }
}

export async function marketBoard(env = {}) {
  const current = Date.now();
  if (boardCache && current < boardExpiresAt) return boardCache;
  const started = Date.now();
  const symbols = Object.keys(MARKET_DEFINITIONS);
  const items = await Promise.all(symbols.map((symbol) => marketSnapshot(symbol, env)));
  const syncedAt = nowIso();
  boardCache = {
    items,
    as_of: syncedAt,
    sync: {
      status: 'ok',
      synced_at: syncedAt,
      latency_ms: Math.max(0, Date.now() - started),
      refresh_mode: 'polling',
      cache_ttl_seconds: BOARD_TTL_MS / 1000,
      live_count: items.filter((item) => LIVE_MODES.has(item.data_mode)).length,
      item_count: items.length,
    },
    coverage: [
      { name: '黄金 / 白银现货', mode: 'spot_realtime', source_url: 'https://www.alphavantage.co/documentation/' },
      { name: '美元 USD/CNY', mode: 'fx_realtime', source_url: 'https://www.alphavantage.co/documentation/' },
      { name: '铜 / WTI 原油', mode: 'daily_reference', source_url: 'https://www.alphavantage.co/documentation/' },
      { name: 'LME 锡', mode: 'licensed_delayed_required', source_url: 'https://www.lme.com/Metals/Non-ferrous/LME-Tin' },
    ],
  };
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

function candleFallback(symbol, interval, overrides = {}) {
  const item = definition(symbol);
  const rows = [];
  const step = interval === 'monthly' ? 30 * 86400000 : interval === 'weekly' ? 7 * 86400000 : 86400000;
  let previous = item.price * 0.972;
  for (let index = 0; index < 36; index += 1) {
    const close = item.price * (0.972 + 0.004 * Math.sin(index * 0.63) + (index / 35) * 0.012);
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
  const response = await fetch(`https://www.alphavantage.co/query?${historyParams(symbol, sourceInterval, key).toString()}`, { headers: { Accept: 'application/json' } });
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
  let note = parsed.synthetic ? '历史接口主要提供收盘价，OHLC 已按相邻收盘价生成，仅用于结构观察。' : '历史接口返回 OHLC；当前数据按免费源周期更新。';
  if (LIVE_MODES.has(item.mode)) {
    const quote = await fetchAlpha(symbol, env);
    if (quote?.price) {
      const last = parsed.candles.at(-1);
      const current = { time: quote.as_of || nowIso(), open: last?.close ?? quote.price, high: Math.max(last?.close ?? quote.price, quote.price), low: Math.min(last?.close ?? quote.price, quote.price), close: quote.price };
      if (last && String(last.time).slice(0, 10) === String(current.time).slice(0, 10)) parsed.candles[parsed.candles.length - 1] = current;
      else parsed.candles.push(current);
      asOf = current.time;
      isLive = true;
      note = `${parsed.synthetic ? '历史收盘价 OHLC 为合成结构；' : ''}最后一根为免费${item.mode === 'fx_realtime' ? '外汇' : '现货'}实时报价，不等同交易所实时期货K线。`;
    }
  }
  return {
    symbol,
    name: item.name,
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
    source_url: item.source,
    freshness: isLive ? '当前报价实时；历史按所选周期' : item.mode === 'daily_reference' ? '日频参考' : '历史周期',
    note,
    interval_note: sourceInterval === 'monthly' && interval === 'yearly' ? '年线由可用月线按自然年聚合，最后一年可能为未完结年度。' : undefined,
    candles: parsed.candles.slice(-48),
  };
}

export async function marketCandles(symbol, requestedInterval = 'daily', env = {}) {
  const normalized = String(symbol || '').toLowerCase();
  const item = MARKET_DEFINITIONS[normalized] ? definition(normalized) : definition('gold');
  const actualSymbol = MARKET_DEFINITIONS[normalized] ? normalized : 'gold';
  const interval = normalizeCandleInterval(actualSymbol, requestedInterval);
  const key = `${actualSymbol}:${interval}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.at < CANDLE_TTL_MS) return cached.payload;
  const intervalOverrides = unsupportedIntervalOverrides(actualSymbol, interval);
  if (!intervalAvailable(actualSymbol, interval)) {
    const payload = candleFallback(actualSymbol, interval, intervalOverrides);
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
    const payload = candleFallback(actualSymbol, interval, { ...intervalOverrides, provider: 'free', data_mode: 'fallback_provider_error', data_label: intervalOverrides.data_label || '免费源暂时异常 · 演示K线', freshness: intervalOverrides.freshness || 'Provider 异常，已回退演示K线' });
    candleCache.set(key, { at: Date.now(), payload });
    return payload;
  }
}
