import { domesticDelayedBoard } from '../../../../../edgeone/cloud-functions/lib/domestic.js';
import { json } from '../../../../../edgeone/cloud-functions/lib/market.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET() {
  return json(await domesticDelayedBoard(runtimeEnv()), 200, {
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
  });
}
