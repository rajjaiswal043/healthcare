-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "mobile" VARCHAR(10),
    "password_hash" VARCHAR(512) NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" VARCHAR(64),
    "mfa_enabled_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "permissions" TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "requires_mfa" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(64) NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" VARCHAR(120),
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_user_tenant_id_is_active_idx" ON "app_user"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_tenant_id_email_key" ON "app_user"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_key_key" ON "role"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "user_role_tenant_id_user_id_idx" ON "user_role"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_user_id_role_id_key" ON "user_role"("user_id", "role_id");

-- CreateIndex
CREATE INDEX "session_tenant_id_user_id_revoked_at_idx" ON "session"("tenant_id", "user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "session_family_id_idx" ON "session"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_refresh_token_hash_key" ON "session"("refresh_token_hash");

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- ROW-LEVEL SECURITY for identity tables (ADR-005)
--
-- Users, roles and sessions are tenant-scoped like everything else. A session
-- table without RLS would be a particularly bad omission: it would let one
-- tenant enumerate another's active sessions and users.
-- =============================================================================

ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app_user" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "app_user"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "app_user" TO healthcloud_app;

ALTER TABLE "role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "role"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "role" TO healthcloud_app;

ALTER TABLE "user_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_role" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_role"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_role" TO healthcloud_app;

ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "session"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "session" TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- Login lookup.
--
-- Authentication happens BEFORE tenant context exists — resolving which user
-- and tenant you are is the thing that establishes it. So this one function is
-- SECURITY DEFINER: a single, narrow, auditable path that reads exactly the
-- credential fields needed to verify a login, for one email in one tenant.
--
-- It deliberately returns nothing else. No patient data, no other users, no
-- listing. The alternative — granting the app role a way to read app_user
-- outside tenant context — would be a much wider hole.
-- -----------------------------------------------------------------------------
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
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.is_active, u.must_change_password,
         u.mfa_secret, u.mfa_enabled_at, u.failed_login_count, u.locked_until,
         u.full_name
    FROM app_user u
    JOIN tenant t ON t.id = u.tenant_id
   WHERE t.slug = p_tenant_slug
     AND t.status = 'ACTIVE'
     AND lower(u.email) = lower(p_email)
   LIMIT 1
$$;

COMMENT ON FUNCTION auth_lookup_user(varchar, varchar) IS
  'Credential lookup for login, before tenant context exists. SECURITY DEFINER, deliberately narrow: one user, credential fields only.';

GRANT EXECUTE ON FUNCTION auth_lookup_user(varchar, varchar) TO healthcloud_app;
