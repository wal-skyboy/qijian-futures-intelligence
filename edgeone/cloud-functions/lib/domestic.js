const OFFICIAL_SHFE_URL = 'https://www.shfe.com.cn/eng/services/';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Public domestic futures contract metadata.
 *
 * The public page intentionally does not invent a domestic futures quote. A
 * licensed/delayed feed can be connected by setting DOMESTIC_DELAYED_URL. The
 * adapter accepts a small normalized JSON payload so the provider can be
 * replaced without changing the UI.
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
  const value = String(raw?.symbol || raw?.code || raw?.品种 || '').trim().toLowerCase();
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
    note: '公开版只展示官方延时国内期货；请在 EdgeOne 配置 DOMESTIC_DELAYED_URL（及可选 DOMESTIC_DELAYED_TOKEN）后自动替换。',
  };
}

function normalizeSnapshot(raw, index) {
  const definition = definitionFor(raw, index);
  const price = numberOrNull(raw?.price ?? raw?.last ?? raw?.latest ?? raw?.最新价);
  const change = numberOrNull(raw?.change_pct ?? raw?.changePercent ?? raw?.涨跌幅);
  if (price === null) return pendingSnapshot(definition, '官方延时源返回字段不完整');
  const asOf = textOrNull(raw?.as_of ?? raw?.asOf ?? raw?.timestamp ?? raw?.time ?? raw?.更新时间) || nowIso();
  return {
    symbol: definition.symbol,
    name: textOrNull(raw?.name || raw?.名称) || definition.name,
    contract: textOrNull(raw?.contract || raw?.合约) || definition.contract,
    price,
    change_pct: change,
    high: numberOrNull(raw?.high ?? raw?.最高),
    low: numberOrNull(raw?.low ?? raw?.最低),
    open: numberOrNull(raw?.open ?? raw?.开盘),
    volume: numberOrNull(raw?.volume ?? raw?.成交量),
    open_interest: numberOrNull(raw?.open_interest ?? raw?.openInterest ?? raw?.持仓量),
    delayed: true,
    available: true,
    provider: textOrNull(raw?.provider) || 'official_delayed_provider',
    data_mode: 'official_delayed',
    data_label: '官方延时行情',
    freshness: textOrNull(raw?.freshness) || '官方延时',
    as_of: asOf,
    source_url: textOrNull(raw?.source_url || raw?.sourceUrl) || definition.source_url,
    note: '公开版官方延时行情；不是交易所实时 Tick 或 Level-2 盘口。',
  };
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.quotes)) return payload.quotes;
  return [];
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
  const url = envValue(env, ['DOMESTIC_DELAYED_URL', 'SHFE_DELAYED_API_URL']);
  if (!url) return null;
  const token = envValue(env, ['DOMESTIC_DELAYED_TOKEN', 'SHFE_DELAYED_API_KEY']);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchWithTimeout(url, { headers });
  if (!response.ok) throw new Error(`domestic delayed provider ${response.status}`);
  const payload = await response.json();
  const rows = extractRows(payload);
  if (!rows.length) throw new Error('domestic delayed provider returned no rows');
  return { payload, rows };
}

export async function domesticDelayedBoard(env = {}) {
  const started = Date.now();
  const configured = Boolean(envValue(env, ['DOMESTIC_DELAYED_URL', 'SHFE_DELAYED_API_URL']));
  let rows = [];
  let status = configured ? 'provider_pending' : 'not_configured';
  let error = '';
  try {
    if (configured) {
      const feed = await fetchConfiguredFeed(env);
      rows = feed?.rows || [];
      status = 'ok';
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'provider error';
    status = 'provider_error';
  }

  const bySymbol = new Map(rows.map((row, index) => [definitionFor(row, index).symbol, row]));
  const items = DOMESTIC_DEFINITIONS.map((definition) => {
    const row = bySymbol.get(definition.symbol);
    return row ? normalizeSnapshot(row, DOMESTIC_DEFINITIONS.indexOf(definition)) : pendingSnapshot(definition, configured ? '官方延时源暂无该品种' : '未配置官方延时源');
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
      note: '公开版不展示国内期货实时 Tick、Level-2 或未授权数据。',
    },
    sync: {
      status,
      synced_at: syncedAt,
      latency_ms: Math.max(0, Date.now() - started),
      refresh_mode: 'polling',
      cache_ttl_seconds: 60,
      delayed_count: available.length,
      item_count: items.length,
      configured,
      ...(error ? { error: '官方延时 Provider 请求失败，已保留待接入状态' } : {}),
    },
  };
}

export { DOMESTIC_DEFINITIONS, OFFICIAL_SHFE_URL };
