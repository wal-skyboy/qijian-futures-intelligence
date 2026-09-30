import { marketSnapshotHistory } from '../../../../../../edgeone/lib/market-snapshot-history.js';
import { runtimeEnv } from '../../../../_runtime';

export async function GET(request: Request) {
  return marketSnapshotHistory({ request, env: runtimeEnv() });
}
