import { json } from '../../../../lib/market.js';
import { authConfiguration, verifyPrivateSession } from '../../../../lib/private-auth.js';

const DEFAULT_TIMEOUT_MS = 5000;

function noStore(extra = {}) {
  return { 'Cache-Control': 'no-store', Vary: 'Cookie', ...extra };
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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeQuote(raw, index) {
  return {
    symbol: textOrNull(raw?.symbol || raw?.code || raw?.合约代码) || `ctp-${index + 1}`,
    name: textOrNull(raw?.name || raw?.名称) || textOrNull(raw?.symbol || raw?.code) || `合约 ${index + 1}`,
    contract: textOrNull(raw?.contract || raw?.instrument || raw?.合约) || textOrNull(raw?.symbol || raw?.code) || `ctp-${index + 1}`,
    last: numberOrNull(raw?.last ?? raw?.price ?? raw?.最新价),
    bid: numberOrNull(raw?.bid ?? raw?.bid_price ?? raw?.买一价),
    ask: numberOrNull(raw?.ask ?? raw?.ask_price ?? raw?.卖一价),
    change_pct: numberOrNull(raw?.change_pct ?? raw?.changePercent ?? raw?.涨跌幅),
    volume: numberOrNull(raw?.volume ?? raw?.成交量),
    open_interest: numberOrNull(raw?.open_interest ?? raw?.openInterest ?? raw?.持仓量),
    currency: 'CNY',
    as_of: textOrNull(raw?.as_of ?? raw?.timestamp ?? raw?.time ?? raw?.更新时间),
  };
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.quotes)) return payload.quotes;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export async function onRequestGet({ request, env }) {
  const config = authConfiguration(env || {});
  if (!config.configured) {
    return json({ status: 'private_auth_not_configured', audience: 'private_owner', data_mode: 'ctp_realtime_private', message: '私有版尚未配置 PRIVATE_ACCESS_CODE。' }, 503, noStore());
  }
  const auth = await verifyPrivateSession(request, env || {});
  if (!auth.authorized) return json({ status: 'unauthorized', audience: 'private_owner', message: '请先登录私有版。' }, 401, noStore());

  const bridgeUrl = envValue(env, ['CTP_BRIDGE_URL']);
  if (!bridgeUrl) {
    return json({
      status: 'ctp_bridge_not_configured',
      audience: 'private_owner',
      data_mode: 'ctp_realtime_private',
      provider: 'ctp_bridge',
      items: [],
      note: 'EdgeOne Pages 不能直接维持 CTP TCP 长连接；请部署本人期货公司 CTP Bridge，并配置 CTP_BRIDGE_URL 与可选 CTP_BRIDGE_TOKEN。',
    }, 503, noStore());
  }

  const headers = { Accept: 'application/json' };
  const bridgeToken = envValue(env, ['CTP_BRIDGE_TOKEN']);
  if (bridgeToken) headers.Authorization = `Bearer ${bridgeToken}`;
  try {
    const response = await fetchWithTimeout(bridgeUrl, { headers });
    if (!response.ok) throw new Error(`ctp bridge ${response.status}`);
    const payload = await response.json();
    const items = extractItems(payload).map(normalizeQuote).filter((item) => item.last !== null || item.bid !== null || item.ask !== null);
    const asOf = textOrNull(payload?.as_of ?? payload?.timestamp) || items.find((item) => item.as_of)?.as_of || new Date().toISOString();
    return json({
      status: 'ok',
      audience: 'private_owner',
      scope: '仅限本人登录',
      provider: 'ctp_bridge',
      data_mode: 'ctp_realtime_private',
      delayed: false,
      as_of: asOf,
      latency_ms: numberOrNull(payload?.latency_ms),
      items,
      note: 'CTP 实时行情仅在本人会话内展示，不对公开版输出。',
    }, 200, noStore());
  } catch {
    return json({
      status: 'ctp_bridge_error',
      audience: 'private_owner',
      data_mode: 'ctp_realtime_private',
      provider: 'ctp_bridge',
      items: [],
      note: 'CTP Bridge 暂时不可用；已停止显示旧报价，避免把过期数据当作实时。',
    }, 502, noStore());
  }
}
