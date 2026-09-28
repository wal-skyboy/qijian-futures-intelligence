import { json } from '../../../../lib/market.js';
import { sourceReadiness } from '../../../../lib/source-status.js';

export async function onRequestGet({ env }) {
  return json(sourceReadiness(env || {}), 200, {
    'Cache-Control': 'private, max-age=15, stale-while-revalidate=30',
  });
}
