-- CreateEnum
CREATE TYPE "gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "blood_group" AS ENUM ('A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "consent_purpose" AS ENUM ('CARE_DELIVERY', 'COMMUNICATIONS', 'MARKETING', 'ABDM_LINKING', 'TELEHEALTH');

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "uhid_counter" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "uhid_padding" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "uhid_prefix" VARCHAR(8) NOT NULL DEFAULT 'P';

-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "uhid" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "given_name" VARCHAR(100),
    "family_name" VARCHAR(100),
    "gender" "gender" NOT NULL,
    "birth_date" DATE,
    "age_years" INTEGER,
    "mobile" VARCHAR(10) NOT NULL,
    "email" VARCHAR(255),
    "address_line" VARCHAR(500),
    "city" VARCHAR(120),
    "state" VARCHAR(120),
    "postal_code" VARCHAR(12),
    "blood_group" "blood_group" NOT NULL DEFAULT 'UNKNOWN',
    "emergency_contact_name" VARCHAR(200),
    "emergency_contact_mobile" VARCHAR(10),
    "abha_number" VARCHAR(17),
    "abha_address" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "purpose" "consent_purpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "notice_version" VARCHAR(32) NOT NULL,
    "notice_locale" VARCHAR(12) NOT NULL DEFAULT 'en-IN',
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(6),
    "captured_by_user_id" UUID,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_label" VARCHAR(200),
    "action" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(64) NOT NULL,
    "resource_id" VARCHAR(64),
    "patient_id" UUID,
    "changed_fields" TEXT[],
    "reason" VARCHAR(500),
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "correlation_id" VARCHAR(64),

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patient_tenant_id_mobile_idx" ON "patient"("tenant_id", "mobile");

-- CreateIndex
CREATE INDEX "patient_tenant_id_created_at_idx" ON "patient"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "patient_tenant_id_uhid_key" ON "patient"("tenant_id", "uhid");

-- CreateIndex
CREATE INDEX "consent_record_tenant_id_patient_id_purpose_idx" ON "consent_record"("tenant_id", "patient_id", "purpose");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_patient_id_occurred_at_idx" ON "audit_event"("tenant_id", "patient_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_occurred_at_idx" ON "audit_event"("tenant_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- ROW-LEVEL SECURITY for the new tenant-scoped tables (ADR-005)
--
-- Same migration as the CREATE TABLE, so no database state ever exists in which
-- a table holding patient data lacks isolation.
-- =============================================================================

ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "patient" TO healthcloud_app;

ALTER TABLE "consent_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_record" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "consent_record"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "consent_record" TO healthcloud_app;

-- Audit is append-only from the application's point of view: it may INSERT and
-- SELECT, but has no UPDATE or DELETE grant. An audit trail the application can
-- rewrite is not an audit trail. Corrections, if ever needed, are a deliberate
-- owner-role operation.
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_event"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON "audit_event" TO healthcloud_app;
GRANT USAGE, SELECT ON SEQUENCE "audit_event_id_seq" TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- Duplicate detection support (FR-P36-03)
--
-- pg_trgm gives us trigram similarity, which is what makes fuzzy name matching
-- work for Indian names where transliteration varies wildly — Sanjay/Sanjai,
-- Krishnan/Krishnaan. Exact matching would miss almost every real duplicate.
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN + trigram index makes `name % $1` similarity search index-backed rather
-- than a full scan of every patient in the tenant.
CREATE INDEX patient_name_trgm_idx ON "patient" USING gin (name gin_trgm_ops);

-- BRIN on occurred_at: audit rows are written in time order, so a BRIN index is
-- a tiny fraction of the size of a B-tree here while still making
-- "what happened in this window" fast.
CREATE INDEX audit_event_occurred_at_brin_idx ON "audit_event" USING brin (occurred_at);

-- -----------------------------------------------------------------------------
-- UHID allocation (FR-P36-01)
--
-- A function rather than application code, because the increment and the read
-- must be one atomic step. Doing it as SELECT-then-UPDATE in the service layer
-- would hand two simultaneous registrations the same UHID — rare in testing,
-- routine at a busy front desk on a Monday morning.
--
-- SECURITY DEFINER: the app role has no UPDATE grant on `tenant` (creating and
-- modifying tenants is a platform operation), but it must be able to advance
-- this one counter. The function is the narrow, auditable hole for exactly that
-- and nothing else.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION next_uhid(p_tenant_id uuid) RETURNS varchar
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_counter bigint;
  v_prefix  varchar;
  v_padding int;
BEGIN
  UPDATE "tenant"
     SET uhid_counter = uhid_counter + 1
   WHERE id = p_tenant_id
  RETURNING uhid_counter, uhid_prefix, uhid_padding
       INTO v_counter, v_prefix, v_padding;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tenant %', p_tenant_id;
  END IF;

  RETURN v_prefix || lpad(v_counter::text, v_padding, '0');
END;
$$;

COMMENT ON FUNCTION next_uhid(uuid) IS
  'Atomically allocates the next UHID for a tenant. SECURITY DEFINER so the app role can advance the counter without holding UPDATE on tenant.';

GRANT EXECUTE ON FUNCTION next_uhid(uuid) TO healthcloud_app;
