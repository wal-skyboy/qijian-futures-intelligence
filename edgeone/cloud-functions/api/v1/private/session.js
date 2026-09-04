import { json } from '../../../lib/market.js';
import {
  authConfiguration,
  issuePrivateSession,
  sessionCookie,
  verifyAccessCode,
  verifyPrivateSession,
} from '../../../lib/private-auth.js';

function noStore(extra = {}) {
  return { 'Cache-Control': 'no-store', Vary: 'Cookie', ...extra };
}

export async function onRequestGet({ request, env }) {
  const status = await verifyPrivateSession(request, env || {});
  if (!status.configured) {
    return json({ authenticated: false, status: 'private_auth_not_configured', message: '私有版尚未配置 PRIVATE_ACCESS_CODE。' }, 503, noStore());
  }
  return json({ authenticated: status.authorized, status: status.authorized ? 'authenticated' : 'logged_out' }, status.authorized ? 200 : 401, noStore());
}

export async function onRequestPost({ request, env }) {
  const config = authConfiguration(env || {});
  if (!config.configured) {
    return json({ authenticated: false, status: 'private_auth_not_configured', message: '请先在 EdgeOne 服务端配置 PRIVATE_ACCESS_CODE。' }, 503, noStore());
  }
  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ authenticated: false, status: 'invalid_request', message: '请输入访问码。' }, 400, noStore());
  }
  const result = await verifyAccessCode(payload?.access_code, env || {});
  if (!result.valid) return json({ authenticated: false, status: 'invalid_access_code', message: '访问码不正确。' }, 401, noStore());
  const token = await issuePrivateSession(env || {});
  return json({ authenticated: true, status: 'authenticated', expires_in: 8 * 60 * 60 }, 200, noStore({ 'Set-Cookie': sessionCookie(token) }));
}

export async function onRequestDelete({ request, env }) {
  const config = authConfiguration(env || {});
  if (!config.configured) return json({ authenticated: false, status: 'private_auth_not_configured' }, 503, noStore());
  return json({ authenticated: false, status: 'logged_out' }, 200, noStore({ 'Set-Cookie': sessionCookie('', 0) }));
}
