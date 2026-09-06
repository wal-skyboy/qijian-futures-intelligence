export type RuntimeEnv = Record<string, string | undefined>;

/**
 * Sites/Vinext exposes production secrets through process.env. Keeping this
 * small adapter in one place makes route handlers easy to test without ever
 * sending a secret to the browser bundle.
 */
export function runtimeEnv(): RuntimeEnv {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}
