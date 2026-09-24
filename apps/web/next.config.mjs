/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Output directory, set by scripts/next-with-dist.mjs.
   *
   *   pnpm dev    -> .next-dev
   *   pnpm build  -> .next-build
   *   anything else (a bare `next build` run by hand) -> .next
   *
   * Dev and build shared one directory originally, and it broke the running dev
   * server twice: `pnpm verify` builds, the pre-push hook runs verify, and you
   * push while developing. The result was a half-rewritten module graph —
   * `Cannot find module './501.js'` or 404s on every chunk.
   *
   * The variable is read from the environment rather than derived from
   * NEXT_PHASE or process.argv because Next loads this config in worker
   * processes too. Only `process.env` is inherited by those workers; NEXT_PHASE
   * is undefined during a build in 15.5, and a worker's argv is
   * `processChild.js`. Both were tried, both silently fell back, and both let
   * the collision happen again.
   *
   * The `.next` fallback matters: without it this config throws whenever the
   * variable is absent, which breaks any direct `next build`.
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
