import { domesticDelayedBoard } from '../../../lib/domestic.js';
import { json } from '../../../lib/market.js';

export async function onRequestGet({ env }) {
  return json(await domesticDelayedBoard(env || {}), 200, {
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
  });
}
