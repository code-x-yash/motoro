/** @type {import('next').NextConfig} */

// NEXT_OUTPUT=export builds the static site that the Cloudflare Worker serves
// alongside the API (same origin — no proxy needed). Dev mode keeps the
// /api/* rewrite so `next dev` can reach `wrangler dev` on :8787.
const isExport = process.env.NEXT_OUTPUT === 'export';

let API_BASE_URL = (process.env.API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
if (API_BASE_URL.endsWith('/api')) API_BASE_URL = API_BASE_URL.slice(0, -'/api'.length);

if (process.env.VERCEL && !process.env.API_BASE_URL) {
  throw new Error(
    'API_BASE_URL is not set. Every /api/* call would be proxied to http://127.0.0.1:8787, ' +
      'which Vercel refuses (X-Vercel-Error: DNS_HOSTNAME_RESOLVED_PRIVATE) and answers 404. ' +
      'The supported deployment is the Cloudflare Worker (`npm run deploy`), which serves the ' +
      'frontend and the API from one origin; if you still deploy to Vercel, set API_BASE_URL ' +
      'to a publicly reachable Worker URL.',
  );
}

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@rr/ui', '@rr/types', '@rr/config', '@rr/validation'],
  ...(isExport ? { output: 'export', images: { unoptimized: true } } : {}),
};

// rewrites()/headers() are unsupported with output: 'export' — security headers
// for static files live in public/_headers (read by Workers Static Assets).
if (!isExport) {
  nextConfig.rewrites = async () => [
    {
      source: '/api/:path*',
      destination: `${API_BASE_URL}/api/:path*`,
    },
  ];
  nextConfig.headers = async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
  ];
}

module.exports = nextConfig;
