import { onRequestVerifyCode } from '../../../../../../edgeone/cloud-functions/lib/public-auth.js';
import { runtimeEnv } from '../../../../_runtime';

export const runtime = 'edge';

export async function POST(request: Request) {
  return onRequestVerifyCode({ request, env: runtimeEnv() });
}
