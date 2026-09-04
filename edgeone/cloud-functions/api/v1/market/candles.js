import { json, marketCandles } from '../../../lib/market.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  return json(await marketCandles(url.searchParams.get('symbol') || 'gold', url.searchParams.get('interval') || 'daily', env || {}), 200, {
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
  });
}
