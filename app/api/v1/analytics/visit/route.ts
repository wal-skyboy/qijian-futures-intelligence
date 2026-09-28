import { recordVisitorPost } from '../../../../../edgeone/lib/visitor-analytics.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function POST(request: Request) {
  return recordVisitorPost({ request, env: runtimeEnv() });
}
