import { defineConfig, env } from 'prisma/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Prisma 7 no longer loads .env automatically. The repo keeps one .env at the
// root rather than one per package, so point dotenv at it explicitly. Without
// this the CLI fails with a message that never mentions the real cause.
loadEnv({ path: resolve(__dirname, '../../.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },

  // IMPORTANT — this file configures the Prisma CLI ONLY: migrate, introspect,
  // studio. It is never loaded by the application at runtime.
  //
  // So it uses MIGRATION_DATABASE_URL (healthcloud_owner), which owns the tables
  // and may alter schema. The running application connects through
  // src/client.ts as healthcloud_app, a non-owner role that row-level security
  // actually applies to (ADR-005).
  //
  // If you ever find application code reading MIGRATION_DATABASE_URL, that is a
  // bug: it hands the app schema privileges and lets it sidestep RLS.
  datasource: {
    url: env('MIGRATION_DATABASE_URL'),

    // Throwaway database that Prisma replays migration history into, for
    // drift detection and `migrate dev`. Its schema is DROPPED AND RECREATED on
    // every use, so it must be healthcloud_shadow — never dev or test.
    // scripts/migrate-check.mjs asserts that before running anything.
    shadowDatabaseUrl: env('SHADOW_DATABASE_URL'),
  },
});
