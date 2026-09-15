import { onRequestGet } from '../../../../../edgeone/cloud-functions/api/v1/private/choice-history.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET(request: Request) {
  return onRequestGet({ request, env: runtimeEnv() });
}
