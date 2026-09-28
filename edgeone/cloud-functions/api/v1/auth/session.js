import {
  onRequestDeleteSession,
  onRequestGetSession,
} from '../../../../lib/public-auth.js';

export async function onRequestGet({ request, env }) {
  return onRequestGetSession({ request, env: env || {} });
}

export async function onRequestDelete({ request, env }) {
  return onRequestDeleteSession({ request, env: env || {} });
}
