import { globalEvents } from '../../../../edgeone/cloud-functions/lib/events.js';
import { json } from '../../../../edgeone/cloud-functions/lib/market.js';
import { runtimeEnv } from '../../_runtime';

export const runtime = 'edge';

export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  return json(await globalEvents({ ...runtimeEnv(), EVENTS_FORCE_REFRESH: fresh ? '1' : '' }), 200, {
    'Cache-Control': fresh ? 'no-store' : 'public, max-age=60, stale-while-revalidate=300',
  });
}
