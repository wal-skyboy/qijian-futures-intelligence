import { json, marketSnapshot } from '../../../../../edgeone/lib/market.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET(_request: Request, context: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await context.params;
  return json(await marketSnapshot(symbol || 'gold', runtimeEnv()));
}
