import type { NextConfig } from 'next';

// EdgeOne Pages serves this project as a static Next.js export.  The app has
// no server-only routes; API calls are intentionally adapter-backed and fall
// back to labelled demo data when the API is not configured.
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
