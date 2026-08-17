-- =============================================================================
-- THE PLATFORM TIER
--
-- See docs/06-platform-onboarding-and-users-plan.md, phase B.
--
-- doctorsdesk.in onboards a clinic. Everything here follows from one decision:
-- **platform staff are not users of any clinic.** `app_user` is tenant-scoped
-- and every policy in this database assumes a row there belongs to exactly one
-- clinic. Marking one of those rows as a super admin would mean weakening the
-- policies or carrying an exception through all of them forever.
--
-- So platform staff live in their own table, sign in at their own endpoint, and
-- hold their own kind of session. A clinic login cannot become a platform login
-- by editing a claim, because the two are looked up in different tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- platform_user
--
-- Not tenant-scoped, like `tenant` itself — see the allowlist in rls-check.mjs.
-- Email is unique across the whole platform, unlike app_user.email which is
-- unique per clinic.
-- -----------------------------------------------------------------------------
CREATE TABLE "platform_user" (
    "id"    UUID NOT NULL DEFAULT uuidv7(),
    "email" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,

    "password_hash" VARCHAR(512) NOT NULL,

    /*
     * MFA is mandatory here, with no role to make it conditional on and no
     * DEV_DISABLE_MFA escape. There is no version of an account that can
     * provision or suspend every clinic on the platform and should be reachable
     * with a password alone.
     */
    "mfa_secret"     VARCHAR(64),
    "mfa_enabled_at" TIMESTAMPTZ(6),

    "is_active"          BOOLEAN NOT NULL DEFAULT true,
    "last_login_at"      TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until"       TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_user_email_key" ON "platform_user"(lower("email"));

-- -----------------------------------------------------------------------------
-- platform_session
--
-- Separate from `session` so a clinic refresh token can never be presented as a
-- platform one, whatever a bug in either code path does. Same rotation and
-- reuse-detection shape as the clinic session.
-- -----------------------------------------------------------------------------
CREATE TABLE "platform_session" (
    "id"               UUID NOT NULL DEFAULT uuidv7(),
    "platform_user_id" UUID NOT NULL,

    "refresh_token_hash" VARCHAR(64) NOT NULL,
    "family_id"          UUID NOT NULL,

    "issued_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at"    TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(500),

    CONSTRAINT "platform_session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_session_refresh_token_hash_key"
  ON "platform_session"("refresh_token_hash");
CREATE INDEX "platform_session_platform_user_id_issued_at_idx"
  ON "platform_session"("platform_user_id", "issued_at");

ALTER TABLE "platform_session"
  ADD CONSTRAINT "platform_session_platform_user_id_fkey"
  FOREIGN KEY ("platform_user_id") REFERENCES "platform_user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_user" TO healthcloud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_session" TO healthcloud_app;

-- =============================================================================
-- WHAT A CLINIC RECORD NEEDS TO BE ONBOARDED
-- =============================================================================

ALTER TABLE "tenant"
  ADD COLUMN "contact_email"  VARCHAR(255),
  ADD COLUMN "contact_mobile" VARCHAR(20),
  ADD COLUMN "onboarded_by_platform_user_id" UUID,
  ADD COLUMN "suspended_at"     TIMESTAMPTZ(6),
  ADD COLUMN "suspended_reason" VARCHAR(300);

ALTER TABLE "tenant"
  ADD CONSTRAINT "tenant_onboarded_by_fkey"
  FOREIGN KEY ("onboarded_by_platform_user_id") REFERENCES "platform_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Suspending without saying why leaves the clinic — and us, in six months — with
-- no answer to "what happened here".
ALTER TABLE "tenant" ADD CONSTRAINT tenant_suspension_is_explained CHECK (
  status <> 'SUSPENDED'
  OR (suspended_at IS NOT NULL AND suspended_reason IS NOT NULL AND length(btrim(suspended_reason)) > 0)
);

-- The platform writes seat limits; the clinic may only read its own.
GRANT INSERT, UPDATE, DELETE ON "tenant_seat_limit" TO healthcloud_app;

-- =============================================================================
-- SUSPENSION MEANS READ-ONLY, NOT DARKNESS
--
-- Narveer's decision, 17 Aug 2026. A clinic behind on payment can still sign in,
-- read its patients, print and export — it simply cannot write.
--
-- The reasoning is not commercial softness. The clinic is the data fiduciary for
-- its patients' records and is legally obliged to retain and produce them. A
-- switch of ours that puts those records out of reach makes us the reason they
-- cannot comply. Read-only keeps the pressure — no new revenue moves through the
-- product — without holding patient data hostage.
--
-- So this function, which until now refused anything that was not ACTIVE, admits
-- SUSPENDED as well. ARCHIVED remains a full stop.
-- =============================================================================

CREATE OR REPLACE FUNCTION auth_lookup_user(p_tenant_slug varchar, p_email varchar)
RETURNS TABLE (
  user_id uuid,
  tenant_id uuid,
  password_hash varchar,
  is_active boolean,
  must_change_password boolean,
  mfa_secret varchar,
  mfa_enabled_at timestamptz,
  failed_login_count int,
  locked_until timestamptz,
  full_name varchar
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  SELECT t.id INTO v_tenant_id
    FROM tenant t
   WHERE t.slug = p_tenant_slug
     AND t.status IN ('ACTIVE', 'SUSPENDED');

  IF v_tenant_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.tenant_id', v_tenant_id::text, true);

  RETURN QUERY
  SELECT u.id, u.tenant_id, u.password_hash, u.is_active, u.must_change_password,
         u.mfa_secret, u.mfa_enabled_at, u.failed_login_count, u.locked_until,
         u.full_name
    FROM app_user u
   WHERE lower(u.email) = lower(p_email)
   LIMIT 1;
END;
$$;

COMMENT ON FUNCTION auth_lookup_user(varchar, varchar) IS
  'Credential lookup for login. Admits ACTIVE and SUSPENDED tenants — a suspended clinic is read-only, not locked out — and refuses ARCHIVED. Resolves the tenant from its slug, sets transaction-scoped context, then reads within RLS.';

-- -----------------------------------------------------------------------------
-- The hardening this design asks for, and why it is not here yet.
--
-- The plan calls for the platform API to connect as its own database role with
-- no grant at all on patient, appointment, encounter or invoice — so that a bug
-- in platform code cannot read a clinical record even in principle. That role
-- has to be created by a superuser (healthcloud_owner is NOCREATEROLE by
-- design), which a migration cannot do, so it belongs in bootstrap.sql and is
-- one psql command away.
--
-- What holds in the meantime is not nothing: every clinical table is under FORCE
-- row-level security and current_tenant_id() fails closed, so platform code —
-- which sets tenant context only inside the one provisioning function, and only
-- ever to a single named tenant — reads ZERO ROWS from any of them rather than
-- patient data. The database role would turn "returns nothing" into "permission
-- denied", which is better, and is the next thing to do here.
-- -----------------------------------------------------------------------------
