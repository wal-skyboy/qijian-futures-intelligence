import { globalEvents } from '../../../../edgeone/cloud-functions/lib/events.js';
import { json } from '../../../../edgeone/cloud-functions/lib/market.js';
import { runtimeEnv } from '../../_runtime';

export const runtime = 'edge';

export async function GET() {
  return json(await globalEvents(runtimeEnv()), 200, {
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
  });
}
