import { marketSnapshotHistory } from '../../../../../lib/market-snapshot-history.js';

export async function onRequestGet({ request, env }) {
  return marketSnapshotHistory({ request, env: env || {} });
}
