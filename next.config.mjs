export default {
  poweredByHeader: false,
  devIndicators: false,
  distDir: process.env.LB_NEXT_OUTPUT || '.next',
  output: 'standalone',
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'X-Frame-Options', value: 'DENY' }
    ] }]
  },
}

