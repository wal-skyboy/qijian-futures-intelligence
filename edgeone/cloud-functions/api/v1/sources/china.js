import { chinaSources } from '../../../../lib/china-sources.js';
import { json } from '../../../../lib/market.js';
import { recordMarketSnapshot } from '../../../../lib/market-snapshot-history.js';

export async function onRequestGet({ env }) {
  const payload = await chinaSources(env || {});
  const recording = payload?.sync?.cached ? { status: 'cached', saved: false, data_mode: 'persistent_market_snapshot' } : await recordMarketSnapshot(env || {}, payload);
  return json({ ...payload, recording }, 200, {
    'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
  });
}
