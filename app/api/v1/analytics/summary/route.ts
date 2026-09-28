import { onRequestSummary } from '../../../../../edgeone/lib/visitor-analytics.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET(request: Request) {
  return onRequestSummary({ request, env: runtimeEnv() });
}
