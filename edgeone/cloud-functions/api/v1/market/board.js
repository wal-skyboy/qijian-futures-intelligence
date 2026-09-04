import { json, marketBoard } from '../../../lib/market.js';

export async function onRequestGet({ env }) {
  return json(await marketBoard(env || {}));
}
