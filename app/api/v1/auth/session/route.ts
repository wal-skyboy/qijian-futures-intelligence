import {
  onRequestDeleteSession,
  onRequestGetSession,
} from '../../../../../edgeone/lib/public-auth.js';
import { runtimeEnv } from '../../../_runtime';

export const runtime = 'edge';

export async function GET(request: Request) {
  return onRequestGetSession({ request, env: runtimeEnv() });
}

export async function DELETE(request: Request) {
  return onRequestDeleteSession({ request, env: runtimeEnv() });
}
