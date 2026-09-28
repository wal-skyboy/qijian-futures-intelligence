import {
  historyRequestDelete,
  historyRequestGet,
  historyRequestPost,
} from '../../../../../edgeone/lib/research-history.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET(request: Request) {
  return historyRequestGet({ request, env: runtimeEnv() });
}

export async function POST(request: Request) {
  return historyRequestPost({ request, env: runtimeEnv() });
}

export async function DELETE(request: Request) {
  return historyRequestDelete({ request, env: runtimeEnv() });
}
