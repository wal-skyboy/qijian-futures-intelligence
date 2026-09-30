import { chinaSources } from '../../../../../edgeone/lib/china-sources.js';
import { json } from '../../../../../edgeone/lib/market.js';
import { marketSnapshotHistory, recordMarketSnapshot } from '../../../../../edgeone/lib/market-snapshot-history.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET(request: Request) {
  const env = runtimeEnv();
  if (new URL(request.url).searchParams.get('history') === '1') return marketSnapshotHistory({ request, env });
  const payload = await chinaSources(env);
  const recording = payload?.sync?.cached ? { status: 'cached', saved: false, data_mode: 'persistent_market_snapshot' } : await recordMarketSnapshot(env, payload);
  return json({ ...payload, recording }, 200, {
    'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
  });
}
