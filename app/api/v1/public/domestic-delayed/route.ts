import { domesticDelayedBoard } from '../../../../../edgeone/lib/domestic.js';
import { json } from '../../../../../edgeone/lib/market.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET() {
  return json(await domesticDelayedBoard(runtimeEnv()), 200, {
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
  });
}
