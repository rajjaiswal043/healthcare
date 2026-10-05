-- =============================================================================
-- PATIENT JOURNEY — waiting from home, recovery check-ins, follow-ups
--
-- See docs/10-patient-journey-plan.md. Three tables and four columns:
--
--   patient_link       a no-login link a patient opens from their phone
--   outbound_message   every message sent, failed, or skipped for consent
--   recovery_checkin   "how is your pain today?", scheduled at signing
--
--   appointment.arrival_intent / arrival_intent_at / leave_now_sent_at
--   encounter.check_in_interval_days
--
-- And two permissions, `followup:read` and `followup:manage`, given to the
-- roles that work the follow-up board.
-- =============================================================================

-- CreateEnum
CREATE TYPE "arrival_intent" AS ENUM ('ON_THE_WAY', 'RUNNING_LATE');

-- CreateEnum
CREATE TYPE "patient_link_purpose" AS ENUM ('VISIT', 'RECOVERY');

-- CreateEnum
CREATE TYPE "message_kind" AS ENUM ('TOKEN_ISSUED', 'LEAVE_NOW', 'CHECKIN_REQUEST', 'REVIEW_REMINDER', 'PRESCRIPTION');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('SENT', 'FAILED', 'SKIPPED_NO_CONSENT');

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "arrival_intent" "arrival_intent",
ADD COLUMN     "arrival_intent_at" TIMESTAMPTZ(6),
ADD COLUMN     "leave_now_sent_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "encounter" ADD COLUMN     "check_in_interval_days" INTEGER;

-- CreateTable
CREATE TABLE "patient_link" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "purpose" "patient_link_purpose" NOT NULL,
    "appointment_id" UUID,
    "encounter_id" UUID,
    "key_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_message" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "appointment_id" UUID,
    "encounter_id" UUID,
    "kind" "message_kind" NOT NULL,
    "channel" VARCHAR(16) NOT NULL DEFAULT 'whatsapp',
    "status" "message_status" NOT NULL,
    "to_mobile" VARCHAR(10) NOT NULL,
    "body" TEXT NOT NULL,
    "provider_ref" VARCHAR(120),
    "error" VARCHAR(300),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_checkin" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "answered_at" TIMESTAMPTZ(6),
    "pain_score" SMALLINT,
    "exercises_done" BOOLEAN,
    "note" VARCHAR(300),
    "flagged_at" TIMESTAMPTZ(6),
    "flag_reason" VARCHAR(120),
    "flag_cleared_at" TIMESTAMPTZ(6),
    "flag_cleared_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recovery_checkin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patient_link_key_hash_key" ON "patient_link"("key_hash");

-- CreateIndex
CREATE INDEX "patient_link_tenant_id_patient_id_created_at_idx" ON "patient_link"("tenant_id", "patient_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_message_tenant_id_patient_id_created_at_idx" ON "outbound_message"("tenant_id", "patient_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_message_tenant_id_encounter_id_kind_idx" ON "outbound_message"("tenant_id", "encounter_id", "kind");

-- CreateIndex
CREATE INDEX "recovery_checkin_tenant_id_patient_id_due_on_idx" ON "recovery_checkin"("tenant_id", "patient_id", "due_on");

-- CreateIndex
CREATE INDEX "recovery_checkin_tenant_id_due_on_sent_at_idx" ON "recovery_checkin"("tenant_id", "due_on", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_checkin_tenant_id_encounter_id_due_on_key" ON "recovery_checkin"("tenant_id", "encounter_id", "due_on");

-- AddForeignKey
ALTER TABLE "patient_link" ADD CONSTRAINT "patient_link_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_link" ADD CONSTRAINT "patient_link_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_link" ADD CONSTRAINT "patient_link_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_checkin" ADD CONSTRAINT "recovery_checkin_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_checkin" ADD CONSTRAINT "recovery_checkin_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- INTEGRITY
-- =============================================================================

-- A link points at exactly the thing its purpose names. A VISIT link with an
-- encounter, or a RECOVERY link with neither, is a link nobody can say what it
-- opens.
ALTER TABLE "patient_link" ADD CONSTRAINT "patient_link_target" CHECK (
  (purpose = 'VISIT'    AND appointment_id IS NOT NULL AND encounter_id IS NULL) OR
  (purpose = 'RECOVERY' AND encounter_id IS NOT NULL AND appointment_id IS NULL)
);

ALTER TABLE "encounter" ADD CONSTRAINT "encounter_check_in_interval_range" CHECK (
  check_in_interval_days IS NULL OR check_in_interval_days BETWEEN 1 AND 30
);

ALTER TABLE "recovery_checkin" ADD CONSTRAINT "recovery_checkin_pain_range" CHECK (
  pain_score IS NULL OR pain_score BETWEEN 0 AND 10
);

-- An answer is a pain score and the moment it was given, together. A score
-- with no time cannot be charted; a time with no score is not an answer.
ALTER TABLE "recovery_checkin" ADD CONSTRAINT "recovery_checkin_answer_complete" CHECK (
  (answered_at IS NULL) = (pain_score IS NULL)
);

-- A cleared flag was a flag, and somebody cleared it.
ALTER TABLE "recovery_checkin" ADD CONSTRAINT "recovery_checkin_flag_cleared_attributed" CHECK (
  flag_cleared_at IS NULL OR (flagged_at IS NOT NULL AND flag_cleared_by_user_id IS NOT NULL)
);

-- =============================================================================
-- ROW-LEVEL SECURITY (ADR-005)
-- =============================================================================

ALTER TABLE "patient_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_link"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- UPDATE for last_seen_at and revocation. Never DELETE: "which links did this
-- patient hold, and when did they stop working" is a question with an answer.
GRANT SELECT, INSERT, UPDATE ON "patient_link" TO healthcloud_app;
REVOKE DELETE ON "patient_link" FROM healthcloud_app;

ALTER TABLE "outbound_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbound_message" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outbound_message"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- Append-only. A message log that can be edited cannot settle "did the clinic
-- tell them", which is the only question it is ever asked.
GRANT SELECT, INSERT ON "outbound_message" TO healthcloud_app;
REVOKE UPDATE, DELETE ON "outbound_message" FROM healthcloud_app;

ALTER TABLE "recovery_checkin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_checkin" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recovery_checkin"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- UPDATE to record sending, the answer and the flag. Never DELETE: a patient's
-- own report of how they were is part of their record.
GRANT SELECT, INSERT, UPDATE ON "recovery_checkin" TO healthcloud_app;
REVOKE DELETE ON "recovery_checkin" FROM healthcloud_app;

-- =============================================================================
-- PERMISSIONS FOR EXISTING CLINICS
--
-- `SYSTEM_ROLES` gives these to every clinic onboarded from now on; this gives
-- them to the clinics that already exist. Appended only where absent, so it is
-- idempotent. A new permission cannot have been customised away, so there is
-- no "untouched role" test here, the same reasoning as 20260911120000.
--
-- THE set_config LOOP IS LOAD-BEARING: `role` is under FORCE row level
-- security, which applies to the owner a migration runs as.
-- =============================================================================

DO $$
DECLARE
  v_tenant  record;
  v_changed integer;
  v_total   integer := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    UPDATE role
       SET permissions = array_append(permissions, 'followup:read'),
           updated_at  = now()
     WHERE key IN ('front_desk', 'doctor', 'nurse', 'owner', 'administrator')
       AND NOT ('followup:read' = ANY (permissions));
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;

    UPDATE role
       SET permissions = array_append(permissions, 'followup:manage'),
           updated_at  = now()
     WHERE key IN ('front_desk', 'doctor', 'administrator')
       AND NOT ('followup:manage' = ANY (permissions));
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;
  END LOOP;

  RAISE NOTICE 'follow-up permissions: % grant(s) across all clinics', v_total;
END $$;
