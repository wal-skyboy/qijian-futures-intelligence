import { onRequestSendCode } from '../../../../../lib/public-auth.js';

export async function onRequestPost({ request, env }) {
  return onRequestSendCode({ request, env: env || {} });
}
