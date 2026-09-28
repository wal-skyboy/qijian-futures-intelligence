import { chinaSources } from '../../../../lib/china-sources.js';
import { json } from '../../../../lib/market.js';

export async function onRequestGet({ env }) {
  return json(await chinaSources(env || {}), 200, {
    'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
  });
}
