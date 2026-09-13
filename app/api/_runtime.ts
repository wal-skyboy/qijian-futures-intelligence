import { env as cloudflareEnv } from 'cloudflare:workers';

export type RuntimeEnv = Record<string, unknown>;

/**
 * Sites/Vinext exposes production secrets through process.env. Keeping this
 * small adapter in one place makes route handlers easy to test without ever
 * sending a secret to the browser bundle.
 */
export function runtimeEnv(): RuntimeEnv {
  const processEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  // Vinext's Cloudflare runtime exposes D1/R2 and other bindings through the
  // native `cloudflare:workers` module. Merging it here keeps existing route
  // handlers secret-safe while making logical bindings available to helpers.
  return { ...processEnv, ...(cloudflareEnv || {}) };
}
