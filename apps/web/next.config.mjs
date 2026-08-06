/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Production builds write to `.next-build`; `next dev` keeps `.next`.
   *
   * They shared one directory, and that caused real breakage twice: running
   * `pnpm verify` (which runs `next build`) while `pnpm dev` was running left
   * the dev server with a half-rewritten module graph, surfacing as
   * `__webpack_modules__[moduleId] is not a function` or 404s on every chunk.
   *
   * That is not an edge case — the pre-push hook runs `pnpm verify`, and you
   * push while the dev server is running. Separating the outputs makes the
   * collision impossible rather than something to remember.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',

  // The staff console renders patient data, so the defaults are not enough —
  // see the full-stack checklist, "Transport & headers".
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
