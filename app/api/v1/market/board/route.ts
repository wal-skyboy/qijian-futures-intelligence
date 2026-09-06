import { json, marketBoard } from '../../../../../edgeone/cloud-functions/lib/market.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET() {
  return json(await marketBoard(runtimeEnv()));
}
