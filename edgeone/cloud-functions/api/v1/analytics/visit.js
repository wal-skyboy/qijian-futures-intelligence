import { recordVisitorPost as handleVisitor } from '../../../../lib/visitor-analytics.js';

export async function onRequestPost({ request, env }) {
  return handleVisitor({ request, env: env || {} });
}
