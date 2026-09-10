import { globalEvents } from '../../lib/events.js';
import { json } from '../../lib/market.js';

export async function onRequestGet({ env, request }) {
  const fresh = new URL(request?.url || 'https://events.local').searchParams.get('fresh') === '1';
  const payload = await globalEvents({ ...(env || {}), EVENTS_FORCE_REFRESH: fresh ? '1' : '' });
  return json(payload, 200, {
    'Cache-Control': fresh ? 'no-store' : 'public, max-age=60, stale-while-revalidate=300',
  });
}
