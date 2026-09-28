import { sourceReadiness } from '../../../../../edgeone/lib/source-status.js';
import { json } from '../../../../../edgeone/lib/market.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET() {
  return json(sourceReadiness(runtimeEnv()), 200, {
    'Cache-Control': 'private, max-age=15, stale-while-revalidate=30',
  });
}
