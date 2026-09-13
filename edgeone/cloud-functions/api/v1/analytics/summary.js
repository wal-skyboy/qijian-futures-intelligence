import { onRequestSummary } from '../../../lib/visitor-analytics.js';

export async function onRequestGet({ request, env }) {
  return onRequestSummary({ request, env: env || {} });
}
