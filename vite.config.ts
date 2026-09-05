import { sites } from '@openai/sites-vite-plugin';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// EdgeOne Pages consumes the static client output directly. The OpenAI Sites
// lifecycle plugin is only needed by the Sites runtime and expects Next.js
// server metadata that is intentionally not produced by a static export.
const isEdgeOneBuild = process.env.EDGEONE_BUILD === '1';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/app-router-entry',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Sites validates the emitted server entry as a Worker. Keep the Cloudflare
  // plugin in the production build so the default export includes fetch().
  // EdgeOne's separate static builder does not need this plugin.
  const cloudflarePlugin = isEdgeOneBuild
    ? null
    : (await import('@cloudflare/vite-plugin')).cloudflare;

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      ...(isEdgeOneBuild ? [] : [sites()]),
      ...(cloudflarePlugin
        ? [
            cloudflarePlugin({
              viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
              config: localBindingConfig,
            }),
          ]
        : []),
    ],
  };
});
