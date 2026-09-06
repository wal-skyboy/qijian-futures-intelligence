import {
  authConfiguration,
  issuePrivateSession,
  sessionCookie,
  verifyAccessCode,
  verifyPrivateSession,
} from '../../../../../edgeone/cloud-functions/lib/private-auth.js';
import { json } from '../../../../../edgeone/cloud-functions/lib/market.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

const noStore = (extra: Record<string, string> = {}) => ({
  'Cache-Control': 'no-store',
  Vary: 'Cookie',
  ...extra,
});

export async function GET(request: Request) {
  const status = await verifyPrivateSession(request, runtimeEnv());
  if (!status.configured) {
    return json({ authenticated: false, status: 'private_auth_not_configured', message: '私有版尚未配置 PRIVATE_ACCESS_CODE。' }, 503, noStore());
  }
  return json({ authenticated: status.authorized, status: status.authorized ? 'authenticated' : 'logged_out', ...(status.expires_at ? { expires_at: status.expires_at } : {}) }, status.authorized ? 200 : 401, noStore());
}

export async function POST(request: Request) {
  const env = runtimeEnv();
  if (!authConfiguration(env).configured) {
    return json({ authenticated: false, status: 'private_auth_not_configured', message: '请先在生产服务端配置 PRIVATE_ACCESS_CODE。' }, 503, noStore());
  }
  let payload: { access_code?: string } = {};
  try {
    payload = await request.json();
  } catch {
    return json({ authenticated: false, status: 'invalid_request', message: '请输入访问码。' }, 400, noStore());
  }
  const result = await verifyAccessCode(payload?.access_code, env);
  if (!result.valid) return json({ authenticated: false, status: 'invalid_access_code', message: '访问码不正确。' }, 401, noStore());
  const token = await issuePrivateSession(env);
  return json({ authenticated: true, status: 'authenticated', expires_in: 8 * 60 * 60, expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() }, 200, noStore({ 'Set-Cookie': sessionCookie(token || '') }));
}

export async function DELETE() {
  const env = runtimeEnv();
  if (!authConfiguration(env).configured) return json({ authenticated: false, status: 'private_auth_not_configured' }, 503, noStore());
  return json({ authenticated: false, status: 'logged_out' }, 200, noStore({ 'Set-Cookie': sessionCookie('', 0) }));
}
