import { onRequestPost } from '../../../../edgeone/cloud-functions/api/v1/image-analysis.js';

export const runtime = 'edge';

export async function POST(request: Request) {
  return onRequestPost({ request, env: typeof process !== 'undefined' && process.env ? process.env : {} });
}
