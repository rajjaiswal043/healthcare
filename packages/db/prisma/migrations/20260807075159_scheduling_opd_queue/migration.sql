-- CreateEnum
CREATE TYPE "visit_type" AS ENUM ('NEW', 'FOLLOW_UP', 'PROCEDURE');

-- CreateEnum
CREATE TYPE "schedule_exception_type" AS ENUM ('LEAVE', 'BLOCK', 'EXTRA');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('BOOKED', 'ARRIVED', 'IN_PROGRESS', 'FULFILLED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "appointment_source" AS ENUM ('FRONT_DESK', 'WALK_IN', 'PORTAL');

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata';

-- CreateTable
CREATE TABLE "department" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practitioner" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "prefix" VARCHAR(16),
    "registration_number" VARCHAR(64),
    "hpr_id" VARCHAR(64),
    "qualification" VARCHAR(200),
    "specialty" VARCHAR(120),
    "department_id" UUID,
    "user_id" UUID,
    "overbook_per_session" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "practitioner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practitioner_schedule" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,
    "slot_minutes" INTEGER NOT NULL DEFAULT 15,
    "capacity_per_slot" INTEGER NOT NULL DEFAULT 1,
    "visit_types" "visit_type"[],
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "practitioner_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_exception" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "location_id" UUID,
    "type" "schedule_exception_type" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "start_time" VARCHAR(5),
    "end_time" VARCHAR(5),
    "reason" VARCHAR(300),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedule_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "department_id" UUID,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'BOOKED',
    "visit_type" "visit_type" NOT NULL DEFAULT 'NEW',
    "source" "appointment_source" NOT NULL DEFAULT 'FRONT_DESK',
    "reason_for_visit" VARCHAR(300),
    "token_number" INTEGER,
    "queue_date" DATE,
    "checked_in_at" TIMESTAMPTZ(6),
    "called_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(300),
    "cancelled_by_user_id" UUID,
    "no_show_at" TIMESTAMPTZ(6),
    "booked_by_user_id" UUID,
    "reminder_sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_counter" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "queue_date" DATE NOT NULL,
    "last_token" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "queue_counter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "department_tenant_id_is_active_display_order_idx" ON "department"("tenant_id", "is_active", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "department_tenant_id_name_key" ON "department"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "practitioner_user_id_key" ON "practitioner"("user_id");

-- CreateIndex
CREATE INDEX "practitioner_tenant_id_is_active_idx" ON "practitioner"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "practitioner_tenant_id_department_id_idx" ON "practitioner"("tenant_id", "department_id");

-- CreateIndex
CREATE INDEX "practitioner_schedule_tenant_id_practitioner_id_day_of_week_idx" ON "practitioner_schedule"("tenant_id", "practitioner_id", "day_of_week");

-- CreateIndex
CREATE INDEX "practitioner_schedule_tenant_id_location_id_day_of_week_idx" ON "practitioner_schedule"("tenant_id", "location_id", "day_of_week");

-- CreateIndex
CREATE INDEX "schedule_exception_tenant_id_practitioner_id_start_date_end_idx" ON "schedule_exception"("tenant_id", "practitioner_id", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "appointment_tenant_id_practitioner_id_start_at_idx" ON "appointment"("tenant_id", "practitioner_id", "start_at");

-- CreateIndex
CREATE INDEX "appointment_tenant_id_start_at_idx" ON "appointment"("tenant_id", "start_at");

-- CreateIndex
CREATE INDEX "appointment_tenant_id_patient_id_start_at_idx" ON "appointment"("tenant_id", "patient_id", "start_at");

-- CreateIndex
CREATE INDEX "appointment_tenant_id_practitioner_id_queue_date_status_idx" ON "appointment"("tenant_id", "practitioner_id", "queue_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_tenant_id_practitioner_id_queue_date_token_numb_key" ON "appointment"("tenant_id", "practitioner_id", "queue_date", "token_number");

-- CreateIndex
CREATE UNIQUE INDEX "queue_counter_tenant_id_practitioner_id_queue_date_key" ON "queue_counter"("tenant_id", "practitioner_id", "queue_date");

-- AddForeignKey
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner_schedule" ADD CONSTRAINT "practitioner_schedule_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- ROW-LEVEL SECURITY for the scheduling tables (ADR-005)
--
-- Same migration as the CREATE TABLE above, so no database state ever exists in
-- which a tenant-scoped table lacks isolation.
-- =============================================================================

ALTER TABLE "department" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "department" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "department"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "department" TO healthcloud_app;

ALTER TABLE "practitioner" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "practitioner" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "practitioner"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "practitioner" TO healthcloud_app;

ALTER TABLE "practitioner_schedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "practitioner_schedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "practitioner_schedule"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "practitioner_schedule" TO healthcloud_app;

ALTER TABLE "schedule_exception" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "schedule_exception" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "schedule_exception"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "schedule_exception" TO healthcloud_app;

ALTER TABLE "appointment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "appointment" TO healthcloud_app;

ALTER TABLE "queue_counter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "queue_counter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "queue_counter"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "queue_counter" TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- Token allocation (FR-APT-05, FR-APT-07)
--
-- Tokens restart each day and are unique per doctor. The naive implementation â€”
-- SELECT max(token_number) + 1 â€” races: two receptionists checking patients in
-- at 9am read the same maximum and both get token 7. Rare when testing, routine
-- on a Monday morning.
--
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING performs the read and the
-- increment as one atomic statement, with the row lock held by Postgres. Same
-- approach as next_uhid().
--
-- Runs inside the caller's tenant context (no SECURITY DEFINER needed): the app
-- role already holds INSERT and UPDATE on queue_counter, and RLS scopes it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION next_queue_token(
  p_tenant_id      uuid,
  p_practitioner_id uuid,
  p_queue_date     date
) RETURNS int
  LANGUAGE plpgsql
AS $$
DECLARE
  v_token int;
BEGIN
  INSERT INTO queue_counter (tenant_id, practitioner_id, queue_date, last_token)
       VALUES (p_tenant_id, p_practitioner_id, p_queue_date, 1)
  ON CONFLICT (tenant_id, practitioner_id, queue_date)
    DO UPDATE SET last_token = queue_counter.last_token + 1
    RETURNING last_token INTO v_token;

  RETURN v_token;
END;
$$;

COMMENT ON FUNCTION next_queue_token(uuid, uuid, date) IS
  'Atomically allocates the next OPD token for a doctor on a date. Runs under RLS in the caller tenant context.';

GRANT EXECUTE ON FUNCTION next_queue_token(uuid, uuid, date) TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- Double-booking guard.
--
-- The service layer checks capacity before inserting, but "check then insert" is
-- not atomic: two receptionists booking the last 10:15 slot both pass the check.
-- This constraint makes the second INSERT fail rather than quietly overbooking.
--
-- Scoped to live appointments only â€” a cancelled or no-show booking must not
-- hold a slot hostage.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX appointment_no_double_booking_idx
  ON "appointment" (tenant_id, practitioner_id, start_at, patient_id)
  WHERE status NOT IN ('CANCELLED', 'NO_SHOW');

