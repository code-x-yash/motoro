/** @type {import('next').NextConfig} */

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:8787';

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@rr/ui', '@rr/types', '@rr/config', '@rr/validation'],
  async rewrites() {
    // Same-origin API proxy so the session cookie is shared with the web app.
    return [
      {
        source: '/api/:path*',
        destination: `${API_BASE_URL}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
