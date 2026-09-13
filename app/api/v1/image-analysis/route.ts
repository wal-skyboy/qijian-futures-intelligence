import { onRequestPost } from '../../../../edgeone/cloud-functions/api/v1/image-analysis.js';
import { runtimeEnv } from '../../_runtime';

export const runtime = 'edge';

export async function POST(request: Request) {
  return onRequestPost({ request, env: runtimeEnv() });
}
