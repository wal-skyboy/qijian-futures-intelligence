import type { NextConfig } from 'next';

// The production site runs as a Vinext/Cloudflare Worker so the API adapters
// under app/api remain available at runtime.  When a provider key is absent,
// the adapters still return explicitly labelled fallback data.
const nextConfig: NextConfig = {
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
