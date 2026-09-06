import { json, marketCandles } from '../../../../../edgeone/cloud-functions/lib/market.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const payload = await marketCandles(
    url.searchParams.get('symbol') || 'gold',
    url.searchParams.get('interval') || 'daily',
    runtimeEnv(),
  );
  return json(payload, 200, {
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
  });
}
