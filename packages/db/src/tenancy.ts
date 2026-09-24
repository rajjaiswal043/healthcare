import type { PrismaClient } from './generated/prisma/client.js';

/**
 * Tenant context (ADR-005).
 *
 * Row-level security policies compare `tenant_id` against `current_tenant_id()`,
 * which reads the `app.tenant_id` GUC. That GUC has to be set on the same
 * connection, inside the same transaction, as the queries it governs — which is
 * exactly what this module guarantees and why every tenant-scoped read or write
 * goes through `withTenant`.
 *
 * The security property: forgetting to call this does not leak data. An unset
 * GUC makes `current_tenant_id()` return NULL, every policy evaluates to NULL,
 * and every query returns zero rows. The failure is visible and empty, never
 * silent and complete.
 */

/** A transaction-scoped client with tenant context applied. */
export type TenantClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`Invalid tenant id: ${JSON.stringify(value)}. Expected a UUID.`);
    this.name = 'InvalidTenantIdError';
  }
}

/**
 * Run `fn` with tenant context set, inside a transaction.
 *
 * @param prisma   client connected as healthcloud_app
 * @param tenantId tenant UUID — must come from the authenticated session,
 *                 NEVER from a request body, query string or header
 * @param fn       receives a transactional client; use it for all queries
 *
 * @example
 * const locations = await withTenant(prisma, session.tenantId, (tx) =>
 *   tx.location.findMany({ where: { isActive: true } }),
 * );
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  // The value is passed as a bound parameter below, so this is not an injection
  // guard — it is a fail-fast one. A malformed tenant id would otherwise surface
  // as a confusing cast error from inside current_tenant_id(), far from the
  // caller that actually got it wrong.
  if (!UUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  return prisma.$transaction(async (tx) => {
    // set_config(name, value, is_local => true) is the parameterisable
    // equivalent of SET LOCAL. Plain `SET LOCAL` cannot take a bind parameter,
    // which would force string interpolation into SQL — precisely what we are
    // not going to do with a value that governs data isolation.
    //
    // is_local = true scopes it to this transaction, so it cannot leak to the
    // next user of this pooled connection. That property is load-bearing: with
    // a session-scoped SET, connection reuse would carry one tenant's context
    // into another tenant's request.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`;

    return fn(tx as TenantClient);
  });
}

/**
 * Escape hatch for genuinely cross-tenant platform work — tenant provisioning,
 * platform-wide reporting, support tooling.
 *
 * There is intentionally no implementation that disables RLS. The app role
 * cannot bypass policies at all (it has NOBYPASSRLS and owns nothing), so
 * cross-tenant access means iterating tenants explicitly and auditing each
 * step. That is deliberate friction: "just show me everything" should be
 * awkward to write and obvious in review.
 */
export async function forEachTenant<T>(
  prisma: PrismaClient,
  tenantIds: readonly string[],
  fn: (tx: TenantClient, tenantId: string) => Promise<T>,
): Promise<Array<{ tenantId: string; result: T }>> {
  const results: Array<{ tenantId: string; result: T }> = [];

  for (const tenantId of tenantIds) {
    const result = await withTenant(prisma, tenantId, (tx) => fn(tx, tenantId));
    results.push({ tenantId, result });
  }

  return results;
}
