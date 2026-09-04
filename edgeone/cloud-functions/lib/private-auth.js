const SESSION_COOKIE = 'qijian_private_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function secretFrom(env) {
  return String(env?.PRIVATE_ACCESS_CODE || env?.PRIVATE_LOGIN_SECRET || '').trim();
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmac(value, secret) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function parseCookies(request) {
  const header = request?.headers?.get('cookie') || '';
  return header.split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
    return cookies;
  }, {});
}

export function authConfiguration(env = {}) {
  return { configured: Boolean(secretFrom(env)) };
}

export async function issuePrivateSession(env = {}) {
  const secret = secretFrom(env);
  if (!secret) return null;
  const nonce = globalThis.crypto.randomUUID();
  const payload = `${Date.now()}.${nonce}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifyPrivateSession(request, env = {}) {
  const secret = secretFrom(env);
  if (!secret) return { configured: false, authorized: false };
  const token = parseCookies(request)[SESSION_COOKIE] || '';
  const parts = token.split('.');
  if (parts.length !== 3) return { configured: true, authorized: false };
  const timestamp = Number(parts[0]);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp < 0 || Date.now() - timestamp > SESSION_TTL_MS) {
    return { configured: true, authorized: false };
  }
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = await hmac(payload, secret);
  return { configured: true, authorized: constantTimeEqual(parts[2], expected) };
}

export async function verifyAccessCode(candidate, env = {}) {
  const secret = secretFrom(env);
  if (!secret) return { configured: false, valid: false };
  const supplied = String(candidate || '');
  const [expected, actual] = await Promise.all([hmac('access-code', secret), hmac('access-code', supplied)]);
  return { configured: true, valid: constantTimeEqual(expected, actual) };
}

export function sessionCookie(token, maxAge = SESSION_TTL_MS / 1000) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; Secure; SameSite=Lax`;
}

export { SESSION_COOKIE, SESSION_TTL_MS };
