import { onRequestVerifyCode } from '../../../../lib/public-auth.js';

export async function onRequestPost({ request, env }) {
  return onRequestVerifyCode({ request, env: env || {} });
}
