import { globalEvents } from '../../lib/events.js';
import { json } from '../../lib/market.js';

export async function onRequestGet({ env }) {
  const payload = await globalEvents(env || {});
  return json(payload, 200, {
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
  });
}
