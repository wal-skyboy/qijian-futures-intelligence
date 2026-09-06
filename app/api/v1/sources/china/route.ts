import { chinaSources } from '../../../../../edgeone/cloud-functions/lib/china-sources.js';
import { json } from '../../../../../edgeone/cloud-functions/lib/market.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET() {
  return json(await chinaSources(runtimeEnv()), 200, {
    'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
  });
}
