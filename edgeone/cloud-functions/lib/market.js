const MARKET_DEFINITIONS = {
  gold: { name: '黄金', price: 2654.8, change: 1.28, score: 72, avSymbol: 'GOLD', function: 'GOLD_SILVER_SPOT', mode: 'spot_realtime', source: 'https://www.alphavantage.co/documentation/' },
  silver: { name: '白银', price: 31.642, change: 0.86, score: 64, avSymbol: 'SILVER', function: 'GOLD_SILVER_SPOT', mode: 'spot_realtime', source: 'https://www.alphavantage.co/documentation/' },
  copper: { name: '铜', price: 9842.5, change: 0.34, score: 58, avSymbol: 'COPPER', function: 'COPPER', mode: 'daily_reference', source: 'https://www.alphavantage.co/documentation/' },
  tin: { name: '锡', price: 256780, change: -0.42, score: 43, avSymbol: 'TIN', function: '', mode: 'licensed_delayed_required', source: 'https://www.lme.com/Metals/Non-ferrous/LME-Tin' },
  crude: { name: '原油', price: 78.42, change: -0.67, score: 47, avSymbol: 'WTI', function: 'WTI', mode: 'daily_reference', source: 'https://www.alphavantage.co/documentation/' },
  usd: { name: '美元', price: 103.42, change: -0.18, score: 52, avSymbol: 'USD/CNY', function: 'CURRENCY_EXCHANGE_RATE', mode: 'fx_realtime', source: 'https://www.alphavantage.co/documentation/' },
};

const LIVE_MODES = new Set(['spot_realtime', 'fx_realtime']);
const BOARD_TTL_MS = 15_000;
let boardCache = null;
let boardExpiresAt = 0;

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
