-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "slug" VARCHAR(63) NOT NULL,
    "legal_name" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "address_line" VARCHAR(500),
    "city" VARCHAR(120),
    "state" VARCHAR(120),
    "postal_code" VARCHAR(12),
    "hfr_id" VARCHAR(64),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "location_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "location_tenant_id_is_active_idx" ON "location"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "location_tenant_id_name_key" ON "location"("tenant_id", "name");

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- ROW-LEVEL SECURITY  (ADR-005)
--
-- Deliberately in the SAME migration as the CREATE TABLE above. If policies
-- lived in a later migration, there would exist a database state — however
-- brief — where a tenant-scoped table has no isolation. There must not be one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenant context accessor.
--
-- Reads the per-transaction GUC set by set_config('app.tenant_id', ..., true).
--
-- FAILS CLOSED, which is the entire point:
--   * GUC never set      -> current_setting(..., true) returns NULL -> NULL
--   * GUC set to ''      -> NULLIF turns it into NULL               -> NULL
-- and `tenant_id = NULL` evaluates to NULL, which is not TRUE, so the policy
-- denies. A forgotten tenant context yields zero rows, never all rows.
--
-- Without the `true` (missing_ok) argument, an unset GUC would instead raise an
-- exception — which is arguably safe too, but produces incoherent errors deep in
-- unrelated queries rather than an empty result the caller can reason about.
--
-- STABLE, not IMMUTABLE: the value changes between transactions.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION current_tenant_id() IS
  'Current tenant from the app.tenant_id GUC. Returns NULL when unset, so RLS policies fail closed.';

GRANT EXECUTE ON FUNCTION current_tenant_id() TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- location — first tenant-scoped table
--
-- ENABLE turns policies on. FORCE additionally applies them to the table's
-- owner. The application connects as a non-owner (healthcloud_app) so ENABLE
-- alone would be sufficient, but FORCE means an accidental owner-role
-- connection is still contained. Two independent things must be wrong before
-- data crosses a tenant boundary.
-- -----------------------------------------------------------------------------
ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location" FORCE ROW LEVEL SECURITY;

-- USING      filters what SELECT/UPDATE/DELETE can see.
-- WITH CHECK validates what INSERT/UPDATE may write.
--
-- Both are required. USING alone would let a caller INSERT a row stamped with
-- another tenant's id — writing across a boundary it cannot read across.
CREATE POLICY tenant_isolation ON "location"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Explicit grants. ALTER DEFAULT PRIVILEGES in bootstrap.sql already covers
-- tables created by this role, but stating it here means the migration is
-- self-contained and does not silently depend on bootstrap having run first.
GRANT SELECT, INSERT, UPDATE, DELETE ON "location" TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- tenant — deliberately NOT tenant-scoped.
--
-- It is the table that defines tenants, so there is no tenant to filter it by.
-- It is on the allowlist in scripts/rls-check.mjs, which requires a documented
-- reason for every entry.
--
-- Login has to resolve a slug to a tenant before any tenant context can exist,
-- so this table must be readable without one. It holds no patient data — only
-- clinic names and status. Restricting which tenant rows a session may see is
-- an application-layer concern, enforced by the auth guard.
--
-- INSERT/UPDATE/DELETE are withheld from the app role entirely: creating and
-- suspending tenants is a platform-admin operation, not something the running
-- application can do.
-- -----------------------------------------------------------------------------
GRANT SELECT ON "tenant" TO healthcloud_app;
