import { onRequestGet } from '../../../../../../edgeone/cloud-functions/api/v1/private/ctp/board.js';

export const runtime = 'edge';

export async function GET(request: Request) {
  return onRequestGet({ request, env: typeof process !== 'undefined' && process.env ? process.env : {} });
}
