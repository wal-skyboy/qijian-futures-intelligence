const OFFICIAL_SHFE_URL = 'https://www.shfe.com.cn/reports/marketdata/delayedquotes/';
const OFFICIAL_SHFE_DELAYED_URL = 'https://www.shfe.com.cn/data/tradedata/future/delaymarket/delaymarket_all.dat';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Public domestic futures contract metadata.
 *
 * The public page uses SHFE's public delayed-quote JSON by default. A licensed
 * distributor can replace it by setting DOMESTIC_DELAYED_URL. The adapter
 * accepts both the official nested payload and a small normalized JSON payload
 * so the provider can be replaced without changing the UI.
 */
const DOMESTIC_DEFINITIONS = [
  { symbol: 'au', name: '沪金', contract: 'AU主连', source_url: OFFICIAL_SHFE_URL },
  { symbol: 'ag', name: '沪银', contract: 'AG主连', source_url: OFFICIAL_SHFE_URL },
  { symbol: 'cu', name: '沪铜', contract: 'CU主连', source_url: OFFICIAL_SHFE_URL },
  { symbol: 'sn', name: '沪锡', contract: 'SN主连', source_url: OFFICIAL_SHFE_URL },
  { symbol: 'sc', name: '原油', contract: 'SC主连', source_url: OFFICIAL_SHFE_URL },
];

function nowIso() {
  return new Date().toISOString();
}

function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return String(value).trim();
}

function definitionFor(raw, index) {
  const value = String(raw?.symbol || raw?.code || raw?.instrumentid || raw?.productid || raw?.品种 || '').trim().toLowerCase();
  const aliases = {
    au: 'au', gold: 'au', 沪金: 'au',
    ag: 'ag', silver: 'ag', 沪银: 'ag',
    cu: 'cu', copper: 'cu', 沪铜: 'cu',
    sn: 'sn', tin: 'sn', 沪锡: 'sn',
    sc: 'sc', crude: 'sc', oil: 'sc', 原油: 'sc',
  };
  const symbol = aliases[value] || DOMESTIC_DEFINITIONS[index]?.symbol || `provider-${index + 1}`;
  return DOMESTIC_DEFINITIONS.find((item) => item.symbol === symbol) || {
    symbol,
    name: textOrNull(raw?.name || raw?.名称) || symbol.toUpperCase(),
    contract: textOrNull(raw?.contract || raw?.合约) || symbol.toUpperCase(),
    source_url: OFFICIAL_SHFE_URL,
  };
}

function pendingSnapshot(definition, reason = '未配置官方延时源') {
  return {
    symbol: definition.symbol,
    name: definition.name,
    contract: definition.contract,
    price: null,
    change_pct: null,
    delayed: true,
    available: false,
    provider: 'shfe_official_delayed',
    data_mode: 'official_delayed_config_required',
    data_label: '官方延时 · 待接入',
    freshness: reason,
    as_of: null,
    source_url: definition.source_url,
    note: '公开版使用上期所官网公开延时行情 JSON；授权分销商可通过 DOMESTIC_DELAYED_URL 替换，未授权时不展示实时 Tick 或 Level-2。',
  };
}

function normalizeSnapshot(raw, index) {
  const definition = definitionFor(raw, index);
  const price = numberOrNull(raw?.price ?? raw?.last ?? raw?.latest ?? raw?.lastprice ?? raw?.最新价);
  const rawChange = numberOrNull(raw?.change_pct ?? raw?.changePercent ?? raw?.涨跌幅);
  const previousSettlement = numberOrNull(raw?.presettlementprice ?? raw?.preSettlementPrice ?? raw?.昨结);
  const absoluteChange = numberOrNull(raw?.upperdown ?? raw?.涨跌);
  const change = rawChange !== null ? rawChange : (absoluteChange !== null && previousSettlement ? (absoluteChange / previousSettlement) * 100 : null);
  if (price === null) return pendingSnapshot(definition, '官方延时源返回字段不完整');
  const asOf = textOrNull(raw?.as_of ?? raw?.asOf ?? raw?.timestamp ?? raw?.time ?? raw?.updatetime ?? raw?.更新时间) || nowIso();
  return {
    symbol: definition.symbol,
    name: textOrNull(raw?.name || raw?.名称) || definition.name,
    contract: textOrNull(raw?.contract || raw?.合约 || raw?.contractname) || definition.contract,
    price,
    change_pct: change,
    high: numberOrNull(raw?.high ?? raw?.最高 ?? raw?.highprice),
    low: numberOrNull(raw?.low ?? raw?.最低 ?? raw?.lowerprice),
    open: numberOrNull(raw?.open ?? raw?.开盘 ?? raw?.openprice),
    volume: numberOrNull(raw?.volume ?? raw?.成交量),
    open_interest: numberOrNull(raw?.open_interest ?? raw?.openInterest ?? raw?.持仓量 ?? raw?.openinterest),
    bid: numberOrNull(raw?.bid ?? raw?.bidprice ?? raw?.买一),
    ask: numberOrNull(raw?.ask ?? raw?.askprice ?? raw?.卖一),
    delayed: true,
    available: true,
    provider: textOrNull(raw?.provider) || 'shfe_official_delayed',
    data_mode: 'official_delayed',
    data_label: '官方延时行情',
    freshness: textOrNull(raw?.freshness) || '上期所官网延时',
    as_of: asOf,
    source_url: textOrNull(raw?.source_url || raw?.sourceUrl) || definition.source_url,
    note: '上期所官网公开延时行情；不是交易所实时 Tick 或 Level-2 盘口。主力参考合约按当前持仓量优先选择。',
  };
}

function flattenRows(value) {
  if (Array.isArray(value)) return value.flatMap((item) => flattenRows(item));
  return value && typeof value === 'object' ? [value] : [];
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.delaymarket)) return flattenRows(payload.delaymarket);
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.quotes)) return payload.quotes;
  return [];
}

function cacheBustedUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set('params', String(Date.now()));
  return url.toString();
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

async function fetchConfiguredFeed(env) {
  const configuredUrl = envValue(env, ['DOMESTIC_DELAYED_URL', 'SHFE_DELAYED_API_URL']);
  const providerUrl = configuredUrl || OFFICIAL_SHFE_DELAYED_URL;
  const token = envValue(env, ['DOMESTIC_DELAYED_TOKEN', 'SHFE_DELAYED_API_KEY']);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchWithTimeout(cacheBustedUrl(providerUrl), { headers });
  if (!response.ok) throw new Error(`domestic delayed provider ${response.status}`);
  const payload = await response.json();
  const rows = extractRows(payload);
  if (!rows.length) throw new Error('domestic delayed provider returned no rows');
  return { payload, rows, providerUrl, configured: Boolean(configuredUrl) };
}

function rowNumber(row, keys) {
  for (const key of keys) {
    const value = numberOrNull(row?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function rowContract(row) {
  return textOrNull(row?.contract || row?.contractname || row?.合约) || '';
}

function pickPrimaryRow(rows, definition) {
  const candidates = rows.filter((row) => definitionFor(row, -1).symbol === definition.symbol);
  if (!candidates.length) return null;
  return [...candidates].sort((left, right) => {
    const leftOpenInterest = rowNumber(left, ['openinterest', 'open_interest', 'openInterest', '持仓量']);
    const rightOpenInterest = rowNumber(right, ['openinterest', 'open_interest', 'openInterest', '持仓量']);
    if (leftOpenInterest !== null || rightOpenInterest !== null) return (rightOpenInterest || 0) - (leftOpenInterest || 0);
    const leftVolume = rowNumber(left, ['volume', '成交量']);
    const rightVolume = rowNumber(right, ['volume', '成交量']);
    if (leftVolume !== null || rightVolume !== null) return (rightVolume || 0) - (leftVolume || 0);
    return rowContract(left).localeCompare(rowContract(right));
  })[0];
}

export async function domesticDelayedBoard(env = {}) {
  const started = Date.now();
  const configuredOverride = Boolean(envValue(env, ['DOMESTIC_DELAYED_URL', 'SHFE_DELAYED_API_URL']));
  let rows = [];
  let status = 'provider_pending';
  let providerUrl = OFFICIAL_SHFE_DELAYED_URL;
  let sourceMode = 'shfe_official_public_json';
  let error = '';
  try {
    const feed = await fetchConfiguredFeed(env);
    rows = feed?.rows || [];
    providerUrl = feed?.providerUrl || providerUrl;
    sourceMode = feed?.configured ? 'authorized_provider' : sourceMode;
    status = rows.length ? 'ok' : 'empty';
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'provider error';
    status = 'provider_error';
  }

  const items = DOMESTIC_DEFINITIONS.map((definition) => {
    const row = pickPrimaryRow(rows, definition);
    return row ? normalizeSnapshot(row, DOMESTIC_DEFINITIONS.indexOf(definition)) : pendingSnapshot(definition, error ? '上期所官方延时源请求失败' : '官方延时源暂无该品种');
  });
  const available = items.filter((item) => item.available);
  const syncedAt = nowIso();
  return {
    items,
    as_of: syncedAt,
    policy: {
      audience: 'public',
      data_label: '官方延时国内期货',
      source_url: OFFICIAL_SHFE_URL,
      feed_url: providerUrl,
      note: '公开版默认读取上期所官网延时行情 JSON；授权分销商可通过环境变量替换，不展示实时 Tick、Level-2 或未授权数据。',
    },
    sync: {
      status,
      synced_at: syncedAt,
      latency_ms: Math.max(0, Date.now() - started),
      refresh_mode: 'polling',
      cache_ttl_seconds: 60,
      delayed_count: available.length,
      item_count: items.length,
      configured: true,
      provider: sourceMode,
      source_url: providerUrl,
      ...(configuredOverride ? { override: true } : {}),
      ...(error ? { error: '上期所官方延时 Provider 请求失败，已保留清晰待接入状态' } : {}),
    },
  };
}

export { DOMESTIC_DEFINITIONS, OFFICIAL_SHFE_URL, OFFICIAL_SHFE_DELAYED_URL };
