import { json } from '../../../../lib/market.js';
import { authConfiguration, verifyPrivateSession } from '../../../../lib/private-auth.js';
import { fetchChoiceHistory } from '../../../../lib/choice-history.js';

function noStore(extra = {}) {
  return { 'Cache-Control': 'no-store', Vary: 'Cookie', ...extra };
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function queryValue(url, key) {
  try { return text(new URL(url).searchParams.get(key)); } catch { return ''; }
}

export async function onRequestGet({ request, env }) {
  const config = authConfiguration(env || {});
  if (!config.configured) {
    return json({ status: 'private_auth_not_configured', audience: 'private_owner', data_mode: 'choice_authorized_history_private', message: '私有版尚未配置 PRIVATE_ACCESS_CODE。' }, 503, noStore());
  }
  const auth = await verifyPrivateSession(request, env || {});
  if (!auth.authorized) return json({ status: 'unauthorized', audience: 'private_owner', message: '请先登录私有版。' }, 401, noStore());

  const url = request?.url || '';
  const rawCodes = queryValue(url, 'codes') || queryValue(url, 'code') || 'AU0.SHF';
  const codes = rawCodes.split(/[,;，；]/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
  const result = await fetchChoiceHistory(env || {}, {
    codes,
    interval: queryValue(url, 'interval') || 'daily',
    start: queryValue(url, 'start'),
    end: queryValue(url, 'end'),
    days: queryValue(url, 'days') || 30,
  });
  const status = result.status === 'ok' || result.status === 'empty' ? 200 : result.status === 'needs_setup' || result.status === 'error' ? 503 : 502;
  return json({ audience: 'private_owner', data_mode: result.data_mode || 'choice_authorized_history_private', ...result, token: undefined }, status, noStore());
}
