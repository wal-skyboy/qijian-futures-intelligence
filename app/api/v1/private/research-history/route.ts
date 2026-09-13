import {
  onRequestDelete,
  onRequestGet,
  onRequestPost,
} from '../../../../../edgeone/cloud-functions/lib/research-history.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET(request: Request) {
  return onRequestGet({ request, env: runtimeEnv() });
}

export async function POST(request: Request) {
  return onRequestPost({ request, env: runtimeEnv() });
}

export async function DELETE(request: Request) {
  return onRequestDelete({ request, env: runtimeEnv() });
}
