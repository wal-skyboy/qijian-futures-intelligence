import { json } from './market.js';
import { historyDatabase } from './research-history.js';

/**
 * Lightweight, app-owned passwordless authentication for ordinary visitors.
 *
 * This is deliberately separate from private-auth.js: a phone account never
 * grants access to the owner's CTP bridge or private research history. The
 * only data stored for an ordinary account is a normalized phone identifier,
 * a short-lived one-time-code challenge, and a revocable session hash.
 */
const USER_SESSION_COOKIE = 'qijian_user_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CODE_TTL_SECONDS = 5 * 60;
const DEFAULT_RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_PHONE_LENGTH = 20;

const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS public_users (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  updated_at TEXT NOT NULL
);`;

const CREATE_USERS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_public_users_phone
ON public_users (phone_e164);`;

const CREATE_CHALLENGES_TABLE = `
CREATE TABLE IF NOT EXISTS sms_challenges (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  last_sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;

const CREATE_CHALLENGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sms_challenges_phone_created
ON sms_challenges (phone_e164, created_at DESC);`;

const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS public_user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);`;

const CREATE_SESSIONS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_public_user_sessions_user_expires
ON public_user_sessions (user_id, expires_at DESC);`;

function envValue(env, keys, fallback = '') {
  for (const key of keys) {
    const value = env?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return fallback;
}

function authSecret(env) {
  // Do not fall back to PRIVATE_ACCESS_CODE: the two account domains must not
  // share a signing secret or make an ordinary phone account an owner session.
  return envValue(env, ['PUBLIC_AUTH_SECRET', 'USER_AUTH_SECRET']);
}

function numberValue(env, keys, fallback, minimum, maximum) {
  const raw = envValue(env, keys);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function codeTtlSeconds(env) {
  return numberValue(env, ['SMS_CODE_TTL_SECONDS'], DEFAULT_CODE_TTL_SECONDS, 60, 15 * 60);
}

function resendCooldownSeconds(env) {
  return numberValue(env, ['SMS_RESEND_COOLDOWN_SECONDS'], DEFAULT_RESEND_COOLDOWN_SECONDS, 10, 15 * 60);
}

function dailyLimit(env) {
  return numberValue(env, ['SMS_DAILY_LIMIT'], DEFAULT_DAILY_LIMIT, 1, 50);
}

function maxAttempts(env) {
  return numberValue(env, ['SMS_MAX_ATTEMPTS'], DEFAULT_MAX_ATTEMPTS, 3, 10);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacBytes(value, keyMaterial) {
  const keyBytes = typeof keyMaterial === 'string' ? new TextEncoder().encode(keyMaterial) : keyMaterial;
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(value)));
  return new Uint8Array(signature);
}

async function hmacHex(value, secret) {
  return bytesToHex(await hmacBytes(value, secret));
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function randomId(prefix) {
  try {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  }
}

function randomCode() {
  const bytes = new Uint32Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
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

function normalizePhone(value) {
  let phone = String(value ?? '').trim().replace(/[\s()-]/g, '');
  if (phone.startsWith('0086')) phone = `+86${phone.slice(4)}`;
  if (/^1\d{10}$/.test(phone)) phone = `+86${phone}`;
  if (!/^\+861\d{10}$/.test(phone) || phone.length > MAX_PHONE_LENGTH) return '';
  return phone;
}

function maskPhone(phone) {
  if (!phone) return '';
  return `${phone.slice(0, 6)}****${phone.slice(-4)}`;
}

function userId() {
  return randomId('user');
}

function sessionCookie(token, maxAge = SESSION_TTL_MS / 1000) {
  return `${USER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; Secure; SameSite=Lax`;
}

function noStore(extra = {}) {
  return { 'Cache-Control': 'no-store', Vary: 'Cookie', ...extra };
}

function originAllowed(request, env) {
  const origin = request?.headers?.get('origin');
  const configured = envValue(env, ['ALLOWED_ORIGINS']);
  if (!origin || !configured) return true;
  return configured.split(',').map((item) => item.trim()).filter(Boolean).includes(origin);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    phone: maskPhone(String(row.phone_e164 || '')),
    created_at: row.created_at || undefined,
    last_login_at: row.last_login_at || undefined,
  };
}

function smsProviderConfiguration(env) {
  const provider = envValue(env, ['SMS_PROVIDER']).toLowerCase();
  if (provider === 'tencent_cloud') {
    const required = [
      'TENCENTCLOUD_SECRET_ID',
      'TENCENTCLOUD_SECRET_KEY',
      'TENCENTCLOUD_SMS_SDK_APP_ID',
      'TENCENTCLOUD_SMS_SIGN_NAME',
      'TENCENTCLOUD_SMS_TEMPLATE_ID',
    ];
    return { provider, configured: required.every((key) => Boolean(envValue(env, [key]))), region: envValue(env, ['TENCENTCLOUD_SMS_REGION'], 'ap-guangzhou') };
  }
  if (provider === 'webhook') {
    const url = envValue(env, ['SMS_PROVIDER_URL']);
    return { provider, configured: /^https:\/\//i.test(url) || /^http:\/\/localhost(?::\d+)?\//i.test(url), url };
  }
  // Console delivery is intentionally limited to local/non-production use;
  // it helps an operator test the full flow without exposing codes to a UI.
  if (provider === 'console') {
    const environment = envValue(env, ['APP_ENV', 'NODE_ENV'], 'development').toLowerCase();
    return { provider, configured: environment !== 'production' };
  }
  return { provider: provider || 'none', configured: false };
}

export function publicAuthConfiguration(env = {}) {
  const provider = smsProviderConfiguration(env);
  return {
    configured: Boolean(authSecret(env)),
    sms_configured: provider.configured,
    sms_provider: provider.provider,
  };
}

async function ensureSchema(db) {
  await db.prepare(CREATE_USERS_TABLE).run();
  await db.prepare(CREATE_USERS_INDEX).run();
  await db.prepare(CREATE_CHALLENGES_TABLE).run();
  await db.prepare(CREATE_CHALLENGES_INDEX).run();
  await db.prepare(CREATE_SESSIONS_TABLE).run();
  await db.prepare(CREATE_SESSIONS_INDEX).run();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function sendTencentCloudSms(phone, code, ttlSeconds, env, provider) {
  const host = 'sms.tencentcloudapi.com';
  const service = 'sms';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = utcDateKey(new Date(timestamp * 1000));
  const body = JSON.stringify({
    PhoneNumberSet: [phone],
    SmsSdkAppId: envValue(env, ['TENCENTCLOUD_SMS_SDK_APP_ID']),
    SignName: envValue(env, ['TENCENTCLOUD_SMS_SIGN_NAME']),
    TemplateId: envValue(env, ['TENCENTCLOUD_SMS_TEMPLATE_ID']),
    TemplateParamSet: [code, String(Math.ceil(ttlSeconds / 60))],
  });
  const hashedBody = await sha256Hex(body);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedBody}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;
  const secretKey = envValue(env, ['TENCENTCLOUD_SECRET_KEY']);
  const secretDate = await hmacBytes(date, new TextEncoder().encode(`TC3${secretKey}`));
  const secretService = await hmacBytes(service, secretDate);
  const secretSigning = await hmacBytes('tc3_request', secretService);
  const signature = bytesToHex(await hmacBytes(stringToSign, secretSigning));
  const authorization = `TC3-HMAC-SHA256 Credential=${envValue(env, ['TENCENTCLOUD_SECRET_ID'])}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetchWithTimeout(`https://${host}/`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': 'SendSms',
      'X-TC-Version': '2021-01-11',
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': provider.region,
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  const status = payload?.Response?.SendStatusSet?.[0];
  if (!response.ok || status?.Code !== 'Ok') {
    throw new Error('Tencent Cloud SMS rejected the request');
  }
}

async function sendWebhookSms(phone, code, ttlSeconds, env, provider) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const token = envValue(env, ['SMS_PROVIDER_TOKEN']);
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchWithTimeout(provider.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone, code, ttl_seconds: ttlSeconds, purpose: 'login' }),
  });
  if (!response.ok) throw new Error('SMS webhook rejected the request');
}

async function deliverSmsCode(phone, code, ttlSeconds, env) {
  const provider = smsProviderConfiguration(env);
  if (!provider.configured) throw new Error('SMS provider is not configured');
  if (provider.provider === 'tencent_cloud') await sendTencentCloudSms(phone, code, ttlSeconds, env, provider);
  else if (provider.provider === 'webhook') await sendWebhookSms(phone, code, ttlSeconds, env, provider);
  else if (provider.provider === 'console') console.info(`[public-auth] console SMS code for ${phone}: ${code}`);
  else throw new Error('SMS provider is not configured');
  return provider.provider;
}

async function sessionHash(token, secret) {
  return hmacHex(`public-session:${token}`, secret);
}

async function currentUser(request, env) {
  const secret = authSecret(env);
  if (!secret) return { configured: false, database: null, user: null };
  const db = historyDatabase(env);
  if (!db) return { configured: true, database: null, user: null };
  const token = parseCookies(request)[USER_SESSION_COOKIE] || '';
  if (!token || token.length > 180) return { configured: true, database: db, user: null };
  try {
    await ensureSchema(db);
    const tokenHash = await sessionHash(token, secret);
    const now = new Date().toISOString();
    const session = await db.prepare('SELECT user_id, expires_at FROM public_user_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1').bind(tokenHash, now).first();
    if (!session?.user_id) return { configured: true, database: db, user: null };
    const row = await db.prepare('SELECT id, phone_e164, status, created_at, last_login_at FROM public_users WHERE id = ? LIMIT 1').bind(session.user_id).first();
    if (!row || row.status !== 'active') return { configured: true, database: db, user: null };
    await db.prepare('UPDATE public_user_sessions SET last_seen_at = ? WHERE token_hash = ?').bind(now, tokenHash).run();
    return { configured: true, database: db, user: row, expires_at: session.expires_at };
  } catch {
    return { configured: true, database: db, user: null, error: true };
  }
}

function authNotConfigured() {
  return json({ status: 'public_auth_not_configured', authenticated: false, message: '普通账号服务尚未配置 PUBLIC_AUTH_SECRET，请联系管理员。' }, 503, noStore());
}

function databaseNotConfigured() {
  return json({ status: 'public_auth_database_not_configured', authenticated: false, message: '普通账号数据库尚未绑定 D1，请联系管理员。' }, 503, noStore());
}

function invalidCodeResponse() {
  return json({ status: 'invalid_code', authenticated: false, message: '验证码无效或已过期，请重新获取。' }, 401, noStore());
}

export async function onRequestGetSession({ request, env }) {
  const status = await currentUser(request, env || {});
  if (!status.configured) return authNotConfigured();
  if (!status.database) return databaseNotConfigured();
  if (status.error) return json({ status: 'public_auth_error', authenticated: false, message: '普通账号会话暂时不可用，请稍后重试。' }, 502, noStore());
  if (!status.user) return json({ status: 'logged_out', authenticated: false }, 401, noStore());
  return json({ status: 'authenticated', authenticated: true, expires_at: status.expires_at, user: publicUser(status.user) }, 200, noStore());
}

export async function onRequestDeleteSession({ env }) {
  const config = publicAuthConfiguration(env || {});
  if (!config.configured) return json({ status: 'logged_out', authenticated: false }, 200, noStore({ 'Set-Cookie': sessionCookie('', 0) }));
  return json({ status: 'logged_out', authenticated: false }, 200, noStore({ 'Set-Cookie': sessionCookie('', 0) }));
}

export async function onRequestSendCode({ request, env }) {
  const environment = env || {};
  if (!originAllowed(request, environment)) return json({ status: 'origin_not_allowed', message: '请求来源未被允许。' }, 403, noStore());
  if (!authSecret(environment)) return authNotConfigured();
  const db = historyDatabase(environment);
  if (!db) return databaseNotConfigured();
  const provider = smsProviderConfiguration(environment);
  if (!provider.configured) return json({ status: 'sms_not_configured', authenticated: false, message: '短信服务尚未配置，请联系管理员。' }, 503, noStore());
  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ status: 'invalid_request', message: '请输入手机号。' }, 400, noStore());
  }
  if (payload?.consent !== true) return json({ status: 'consent_required', message: '请先同意手机号用于验证码登录与安全风控。' }, 400, noStore());
  const phone = normalizePhone(payload?.phone);
  if (!phone) return json({ status: 'invalid_phone', message: '请输入有效的中国大陆手机号。' }, 400, noStore());
  const now = new Date();
  const nowIso = now.toISOString();
  const cooldown = resendCooldownSeconds(environment);
  const recentSince = new Date(now.getTime() - cooldown * 1000).toISOString();
  const dailySince = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  try {
    await ensureSchema(db);
    const recent = await db.prepare('SELECT created_at FROM sms_challenges WHERE phone_e164 = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1').bind(phone, recentSince).first();
    if (recent?.created_at) {
      const retryAfter = Math.max(1, Math.ceil((new Date(recent.created_at).getTime() + cooldown * 1000 - now.getTime()) / 1000));
      return json({ status: 'cooldown', retry_after: retryAfter, message: `请 ${retryAfter} 秒后再获取验证码。` }, 429, noStore());
    }
    const countRow = await db.prepare('SELECT COUNT(*) AS count FROM sms_challenges WHERE phone_e164 = ? AND created_at >= ?').bind(phone, dailySince).first();
    if (Number(countRow?.count || 0) >= dailyLimit(environment)) return json({ status: 'rate_limited', message: '今日验证码次数已达上限，请明日再试。' }, 429, noStore());
    const ttl = codeTtlSeconds(environment);
    const code = randomCode();
    const challengeId = randomId('sms');
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    const codeHash = await hmacHex(`sms-code:${phone}:${code}`, authSecret(environment));
    await db.prepare('UPDATE sms_challenges SET consumed_at = ? WHERE phone_e164 = ? AND consumed_at IS NULL').bind(nowIso, phone).run();
    await db.prepare('INSERT INTO sms_challenges (id, phone_e164, code_hash, expires_at, attempts, consumed_at, last_sent_at, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)').bind(challengeId, phone, codeHash, expiresAt, nowIso, nowIso).run();
    try {
      await deliverSmsCode(phone, code, ttl, environment);
    } catch {
      await db.prepare('UPDATE sms_challenges SET consumed_at = ? WHERE id = ?').bind(new Date().toISOString(), challengeId).run().catch(() => undefined);
      return json({ status: 'sms_send_failed', message: '短信发送失败，请稍后重试。' }, 502, noStore());
    }
    return json({ status: 'ok', delivery: 'sent', expires_in: ttl, retry_after: cooldown, message: '验证码已发送，请在有效期内完成登录。' }, 200, noStore());
  } catch {
    return json({ status: 'public_auth_error', message: '验证码服务暂时不可用，请稍后重试。' }, 502, noStore());
  }
}

export async function onRequestVerifyCode({ request, env }) {
  const environment = env || {};
  if (!originAllowed(request, environment)) return json({ status: 'origin_not_allowed', authenticated: false, message: '请求来源未被允许。' }, 403, noStore());
  const secret = authSecret(environment);
  if (!secret) return authNotConfigured();
  const db = historyDatabase(environment);
  if (!db) return databaseNotConfigured();
  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return invalidCodeResponse();
  }
  if (payload?.consent !== true) return json({ status: 'consent_required', authenticated: false, message: '请先同意手机号用于验证码登录与安全风控。' }, 400, noStore());
  const phone = normalizePhone(payload?.phone);
  const code = String(payload?.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) return invalidCodeResponse();
  const now = new Date().toISOString();
  try {
    await ensureSchema(db);
    const challenge = await db.prepare('SELECT id, phone_e164, code_hash, expires_at, attempts, consumed_at FROM sms_challenges WHERE phone_e164 = ? ORDER BY created_at DESC LIMIT 1').bind(phone).first();
    if (!challenge || challenge.consumed_at || challenge.expires_at <= now || Number(challenge.attempts || 0) >= maxAttempts(environment)) return invalidCodeResponse();
    const expectedHash = await hmacHex(`sms-code:${phone}:${code}`, secret);
    if (!constantTimeEqual(String(challenge.code_hash || ''), expectedHash)) {
      await db.prepare('UPDATE sms_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL').bind(challenge.id).run();
      return invalidCodeResponse();
    }
    const consumed = await db.prepare('UPDATE sms_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').bind(now, challenge.id).run();
    if (Number(consumed?.meta?.changes || 0) !== 1) return invalidCodeResponse();
    const existing = await db.prepare('SELECT id, phone_e164, status, created_at, last_login_at FROM public_users WHERE phone_e164 = ? LIMIT 1').bind(phone).first();
    const id = existing?.id || userId();
    const createdAt = existing?.created_at || now;
    const statements = existing
      ? [db.prepare('UPDATE public_users SET status = \'active\', last_login_at = ?, updated_at = ? WHERE id = ?').bind(now, now, id)]
      : [db.prepare('INSERT INTO public_users (id, phone_e164, status, created_at, last_login_at, updated_at) VALUES (?, ?, \'active\', ?, ?, ?)').bind(id, phone, createdAt, now, now)];
    const token = randomId('session');
    const tokenHash = await sessionHash(token, secret);
    const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    statements.push(db.prepare('INSERT INTO public_user_sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').bind(tokenHash, id, sessionExpiresAt, now, now));
    await db.batch(statements);
    const row = { id, phone_e164: phone, status: 'active', created_at: createdAt, last_login_at: now };
    return json({ status: 'authenticated', authenticated: true, expires_at: sessionExpiresAt, user: publicUser(row) }, 200, noStore({ 'Set-Cookie': sessionCookie(token) }));
  } catch {
    return json({ status: 'public_auth_error', authenticated: false, message: '验证码校验暂时不可用，请稍后重试。' }, 502, noStore());
  }
}

export {
  CREATE_CHALLENGES_INDEX,
  CREATE_CHALLENGES_TABLE,
  CREATE_SESSIONS_INDEX,
  CREATE_SESSIONS_TABLE,
  CREATE_USERS_INDEX,
  CREATE_USERS_TABLE,
  USER_SESSION_COOKIE,
  SESSION_TTL_MS,
  maskPhone,
  normalizePhone,
  sessionCookie,
};
