import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

/**
 * The runtime database client.
 *
 * Connects as `healthcloud_app` via DATABASE_URL — a non-owner role that
 * row-level security applies to (ADR-005).
 *
 * It deliberately does NOT read MIGRATION_DATABASE_URL. That URL belongs to
 * `healthcloud_owner`, which owns the tables; using it here would hand the
 * running application schema privileges and let it bypass every tenant
 * isolation policy. If you ever need it in application code, you don't.
 */

export type { PrismaClient } from './generated/prisma/client.js';

function requireAppDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, then run `pnpm preflight`.',
    );
  }

  // Guard against the single most damaging misconfiguration: pointing the
  // application at the owning role. That role bypasses RLS by virtue of owning
  // the tables, so tenant isolation would silently stop applying — no error, no
  // symptom, until one clinic sees another's patients.
  if (url.includes('healthcloud_owner')) {
    throw new Error(
      'DATABASE_URL is using the healthcloud_owner role. The application must connect ' +
        'as healthcloud_app so row-level security applies (ADR-005). Refusing to start.',
    );
  }

  return url;
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const connectionString = databaseUrl ?? requireAppDatabaseUrl();

  /**
   * Pin the database session to UTC.
   *
   * PostgreSQL renders `timestamptz` in the SESSION timezone, and the driver
   * then parses that rendering. Left at the server's local zone, an appointment
   * stored correctly as 03:30Z came back as 23:30Z on a machine running EDT —
   * off by exactly the local offset.
   *
   * This is worse than an ordinary bug because it hides: a UTC production
   * server gets the right answer by accident, so the fault only appears on a
   * developer's machine, or on the first server that is not UTC. Every
   * appointment time, audit timestamp and session expiry depends on it.
   *
   * Conversion to clinic-local time is the application's job (see the tenant
   * timezone and apps/api/src/scheduling/clinic-time.ts). The database speaks
   * UTC and nothing else.
   */
  const adapter = new PrismaPg({
    connectionString,
    options: '-c timezone=UTC',
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

let singleton: PrismaClient | undefined;

/** Process-wide client. Prefer injecting the client in application code; this
 *  exists for scripts and tests that just need one. */
export function getPrismaClient(): PrismaClient {
  singleton ??= createPrismaClient();
  return singleton;
}
