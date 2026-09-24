-- CreateEnum
CREATE TYPE "encounter_status" AS ENUM ('IN_PROGRESS', 'SIGNED');

-- CreateEnum
CREATE TYPE "medication_form" AS ENUM ('TABLET', 'CAPSULE', 'SYRUP', 'INJECTION', 'DROPS', 'OINTMENT', 'INHALER', 'SACHET', 'OTHER');

-- CreateEnum
CREATE TYPE "medication_route" AS ENUM ('ORAL', 'TOPICAL', 'INTRAVENOUS', 'INTRAMUSCULAR', 'SUBCUTANEOUS', 'INHALED', 'OPHTHALMIC', 'OTIC', 'NASAL', 'RECTAL', 'OTHER');

-- CreateTable
CREATE TABLE "encounter" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "status" "encounter_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "chief_complaint" VARCHAR(500),
    "history_of_present_illness" TEXT,
    "examination_findings" TEXT,
    "advice" TEXT,
    "follow_up_date" DATE,
    "follow_up_note" VARCHAR(300),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signed_at" TIMESTAMPTZ(6),
    "signed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vitals_observation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_user_id" UUID,
    "height_cm" DECIMAL(4,1),
    "weight_kg" DECIMAL(5,2),
    "systolic_mm_hg" INTEGER,
    "diastolic_mm_hg" INTEGER,
    "pulse_bpm" INTEGER,
    "temperature_c" DECIMAL(3,1),
    "spo2_percent" INTEGER,
    "respiratory_rate" INTEGER,
    "notes" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vitals_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "code_system" VARCHAR(32) NOT NULL DEFAULT 'ICD-10',
    "code" VARCHAR(16),
    "display" VARCHAR(300) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "formulary_item" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "generic_name" VARCHAR(200),
    "strength" VARCHAR(60),
    "form" "medication_form",
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "formulary_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "formulary_item_id" UUID,
    "drug_name" VARCHAR(200) NOT NULL,
    "strength" VARCHAR(60),
    "form" "medication_form",
    "dose" VARCHAR(60) NOT NULL,
    "frequency" VARCHAR(60) NOT NULL,
    "route" "medication_route" NOT NULL DEFAULT 'ORAL',
    "duration_days" INTEGER,
    "quantity" INTEGER,
    "instructions" VARCHAR(300),
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_addendum" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "author_user_id" UUID NOT NULL,
    "author_label" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_addendum_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "encounter_appointment_id_key" ON "encounter"("appointment_id");

-- CreateIndex
CREATE INDEX "encounter_tenant_id_patient_id_started_at_idx" ON "encounter"("tenant_id", "patient_id", "started_at");

-- CreateIndex
CREATE INDEX "encounter_tenant_id_practitioner_id_started_at_idx" ON "encounter"("tenant_id", "practitioner_id", "started_at");

-- CreateIndex
CREATE INDEX "vitals_observation_tenant_id_encounter_id_idx" ON "vitals_observation"("tenant_id", "encounter_id");

-- CreateIndex
CREATE INDEX "vitals_observation_tenant_id_patient_id_recorded_at_idx" ON "vitals_observation"("tenant_id", "patient_id", "recorded_at");

-- CreateIndex
CREATE INDEX "diagnosis_tenant_id_encounter_id_idx" ON "diagnosis"("tenant_id", "encounter_id");

-- CreateIndex
CREATE INDEX "diagnosis_tenant_id_code_idx" ON "diagnosis"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "formulary_item_tenant_id_is_active_idx" ON "formulary_item"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "formulary_item_name_trgm_idx" ON "formulary_item" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "formulary_item_tenant_id_name_strength_key" ON "formulary_item"("tenant_id", "name", "strength");

-- CreateIndex
CREATE INDEX "prescription_tenant_id_encounter_id_display_order_idx" ON "prescription"("tenant_id", "encounter_id", "display_order");

-- CreateIndex
CREATE INDEX "encounter_addendum_tenant_id_encounter_id_created_at_idx" ON "encounter_addendum"("tenant_id", "encounter_id", "created_at");

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals_observation" ADD CONSTRAINT "vitals_observation_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_formulary_item_id_fkey" FOREIGN KEY ("formulary_item_id") REFERENCES "formulary_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_addendum" ADD CONSTRAINT "encounter_addendum_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- ROW-LEVEL SECURITY for the consultation tables (ADR-005)
--
-- Same migration as the CREATE TABLE above, so no database state ever exists in
-- which a table holding clinical notes lacks tenant isolation.
-- =============================================================================

ALTER TABLE "encounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "encounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "encounter"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "encounter" TO healthcloud_app;

ALTER TABLE "vitals_observation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vitals_observation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vitals_observation"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "vitals_observation" TO healthcloud_app;

ALTER TABLE "diagnosis" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diagnosis" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "diagnosis"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "diagnosis" TO healthcloud_app;

ALTER TABLE "formulary_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "formulary_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "formulary_item"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "formulary_item" TO healthcloud_app;

ALTER TABLE "prescription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prescription" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "prescription"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "prescription" TO healthcloud_app;

-- An addendum is a correction to a signed record: append-only, at the database
-- level rather than by convention. This is not belt-and-braces with the service
-- layer — it is the only guarantee that survives a bug in it.
--
-- NOTE THE REVOKE, and that it is doing the actual work. bootstrap.sql sets
-- ALTER DEFAULT PRIVILEGES granting SELECT/INSERT/UPDATE/DELETE on every table
-- this role creates, so a narrower GRANT here adds nothing and quietly reads as
-- a restriction that was never applied. The integration test asserts the
-- resulting privilege list precisely because that mistake is invisible.
ALTER TABLE "encounter_addendum" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "encounter_addendum" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "encounter_addendum"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON "encounter_addendum" TO healthcloud_app;
REVOKE UPDATE, DELETE ON "encounter_addendum" FROM healthcloud_app;

-- =============================================================================
-- INTEGRITY
-- =============================================================================

-- A signature is a timestamp AND an author, or neither. A signed encounter with
-- no author is unattributable; an author on an unsigned one is a lie. Enforced
-- here rather than only in the service, because this is the field a medico-legal
-- question turns on.
ALTER TABLE "encounter" ADD CONSTRAINT encounter_signature_complete
  CHECK ((signed_at IS NULL AND signed_by_user_id IS NULL)
      OR (signed_at IS NOT NULL AND signed_by_user_id IS NOT NULL));

-- Exactly one primary diagnosis per encounter. A partial unique index rather
-- than a trigger: "the main problem" is what every downstream report groups by,
-- and two of them silently double-counts.
CREATE UNIQUE INDEX diagnosis_one_primary_per_encounter
  ON "diagnosis" (encounter_id)
  WHERE is_primary;

-- Clinically plausible ranges. A weight of 700 kg is a typo, and a system that
-- stores one will eventually chart it. The bounds are wide on purpose — they
-- reject impossibilities, not unusual patients. The UI warns well inside these.
ALTER TABLE "vitals_observation" ADD CONSTRAINT vitals_plausible_ranges CHECK (
      (height_cm        IS NULL OR height_cm        BETWEEN 20   AND 275)
  AND (weight_kg        IS NULL OR weight_kg        BETWEEN 0.3  AND 500)
  AND (systolic_mm_hg   IS NULL OR systolic_mm_hg   BETWEEN 40   AND 300)
  AND (diastolic_mm_hg  IS NULL OR diastolic_mm_hg  BETWEEN 20   AND 200)
  AND (pulse_bpm        IS NULL OR pulse_bpm        BETWEEN 20   AND 300)
  AND (temperature_c    IS NULL OR temperature_c    BETWEEN 25   AND 45)
  AND (spo2_percent     IS NULL OR spo2_percent     BETWEEN 30   AND 100)
  AND (respiratory_rate IS NULL OR respiratory_rate BETWEEN 4    AND 90)
);

-- Systolic above diastolic. Transposed readings are a common data-entry slip and
-- produce a chart nobody notices is wrong.
ALTER TABLE "vitals_observation" ADD CONSTRAINT vitals_bp_ordered
  CHECK (systolic_mm_hg IS NULL OR diastolic_mm_hg IS NULL
      OR systolic_mm_hg > diastolic_mm_hg);

-- A prescription with no duration and no quantity tells the pharmacist nothing.
ALTER TABLE "prescription" ADD CONSTRAINT prescription_has_an_amount
  CHECK (duration_days IS NOT NULL OR quantity IS NOT NULL);

ALTER TABLE "prescription" ADD CONSTRAINT prescription_duration_sane
  CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365);
