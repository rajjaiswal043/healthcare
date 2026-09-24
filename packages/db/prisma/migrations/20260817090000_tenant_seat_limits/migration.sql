-- =============================================================================
-- SEAT LIMITS
--
-- See docs/06-platform-onboarding-and-users-plan.md, phase A.
--
-- How many people a clinic may have holding each role. Absent means unlimited,
-- so every clinic that exists today keeps working exactly as it does now and
-- nothing has to be backfilled.
--
-- The count these are checked against is of ACTIVE users. That is the whole
-- reason deactivate exists as a separate action from delete: a clinic on five
-- doctor seats that loses a doctor deactivates them and hires another. Deleting
-- is not an option — their name is on signed consultations and issued receipts,
-- and those have to keep resolving for as long as the records are retained.
-- =============================================================================

CREATE TABLE "tenant_seat_limit" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,

    /*
     * The role key from packages/db/src/permissions.ts — 'doctor', 'nurse',
     * 'front_desk', 'administrator'. A foreign key onto the tenant's own role
     * row rather than a free string: a limit on a role that does not exist is a
     * limit that silently never applies, which is the worst way for a
     * commercial control to fail.
     */
    "role_key"  VARCHAR(64) NOT NULL,

    "max_users" INTEGER NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_seat_limit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_seat_limit_tenant_id_role_key_key"
  ON "tenant_seat_limit"("tenant_id", "role_key");

ALTER TABLE "tenant_seat_limit"
  ADD CONSTRAINT "tenant_seat_limit_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_seat_limit"
  ADD CONSTRAINT "tenant_seat_limit_role_fkey"
  FOREIGN KEY ("tenant_id", "role_key") REFERENCES "role"("tenant_id", "key")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Zero is a meaningful limit — "this clinic may have no administrators of its
-- own" is a decision someone might make. Negative is not.
ALTER TABLE "tenant_seat_limit" ADD CONSTRAINT tenant_seat_limit_not_negative CHECK (
  max_users >= 0
);

-- =============================================================================
-- ROW-LEVEL SECURITY (ADR-005)
-- =============================================================================

ALTER TABLE "tenant_seat_limit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_seat_limit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_seat_limit"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

/*
 * The application may READ its own limits — the users screen shows "3 of 5
 * doctor seats used" — but it must not write them. A clinic that can raise its
 * own seat limit does not have a seat limit.
 *
 * Writes come from the platform tier (phase B), which connects as a different
 * role. Until that exists, limits are set by hand or by seed, which is honest
 * about where we are.
 */
GRANT SELECT ON "tenant_seat_limit" TO healthcloud_app;
REVOKE INSERT, UPDATE, DELETE ON "tenant_seat_limit" FROM healthcloud_app;
