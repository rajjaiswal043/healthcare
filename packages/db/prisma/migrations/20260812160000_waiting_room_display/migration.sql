-- =============================================================================
-- THE WAITING-ROOM SCREEN
--
-- See docs/05-token-queue-plan.md, phase C.
--
-- A television on a wall cannot hold a user session, and giving it a staff login
-- is how a clinic ends up with a permanent front-desk session on an unattended
-- screen in a public room. So a screen gets its own credential — narrow, revocable,
-- and good for exactly one thing: reading token numbers.
--
-- What the screen may show is a design constraint, not a preference: TOKENS ONLY,
-- never names. A screen in a waiting room is a disclosure to everybody in that
-- room, and "Kavita Sharma — Dr Nair, Dermatology" tells them who is being
-- treated for what. Under the DPDP Act that is processing beyond the purpose the
-- data was collected for. The read endpoint enforces it; this table is only what
-- the endpoint authenticates against.
-- =============================================================================

CREATE TABLE "display_device" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,

    "name"        VARCHAR(120) NOT NULL,
    -- Null means every location. A single-site clinic never has to think about it.
    "location_id" UUID,

    /*
     * Which doctors this screen shows. Empty means all of them at that location.
     *
     * A scalar array rather than a join table: it is read once per poll, written
     * once at pairing, and never queried BY practitioner. A join table would be
     * three more objects and an extra query to answer a question nobody asks.
     */
    "practitioner_ids" UUID[] NOT NULL DEFAULT '{}',

    /*
     * SHA-256 of `<tenantId>.<32 random bytes>`, exactly as session refresh
     * tokens are stored. The plaintext key is shown once at pairing and never
     * again — a database dump yields nothing usable, and a screen that loses its
     * key gets a new one rather than a recovered one.
     */
    "access_key_hash" VARCHAR(64) NOT NULL,

    -- So an administrator can tell a dead screen from an idle one.
    "last_seen_at" TIMESTAMPTZ(6),

    "is_active"          BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "revoked_at"         TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "display_device_pkey" PRIMARY KEY ("id")
);

-- The lookup on every poll. Unique because a hash collision would mean one
-- screen authenticating as another clinic's.
CREATE UNIQUE INDEX "display_device_access_key_hash_key" ON "display_device"("access_key_hash");
CREATE INDEX "display_device_tenant_id_is_active_idx" ON "display_device"("tenant_id", "is_active");

ALTER TABLE "display_device"
  ADD CONSTRAINT "display_device_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "display_device"
  ADD CONSTRAINT "display_device_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A revoked screen must say when. "It stopped working" is not an audit trail.
ALTER TABLE "display_device" ADD CONSTRAINT display_device_revocation_is_dated CHECK (
  is_active OR revoked_at IS NOT NULL
);

-- =============================================================================
-- ROW-LEVEL SECURITY (ADR-005)
--
-- Same migration as the CREATE TABLE, so no database state ever exists in which
-- a tenant-scoped table lacks isolation.
-- =============================================================================

ALTER TABLE "display_device" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "display_device" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "display_device"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "display_device" TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- No lookup function, deliberately.
--
-- The screen's key carries its tenant id as a prefix — `<tenantId>.<secret>` —
-- for the same reason the session refresh token does: every table is under FORCE
-- row-level security, so `display_device` cannot be read at all before tenant
-- context exists, and a screen has no session to derive that context from.
--
-- So the API parses the tenant from the key, sets context, and reads INSIDE the
-- policy. The prefix is not a secret and grants nothing on its own: the secret
-- half is 32 random bytes, and only the SHA-256 of the whole string is stored.
-- The alternative — a BYPASSRLS role that can read every clinic's devices —
-- would be a much larger hole than the one it closed.
-- -----------------------------------------------------------------------------
