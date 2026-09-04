import { json, marketSnapshot } from '../../../lib/market.js';

export async function onRequestGet({ params, env }) {
  return json(await marketSnapshot(params?.symbol || 'gold', env || {}));
}
