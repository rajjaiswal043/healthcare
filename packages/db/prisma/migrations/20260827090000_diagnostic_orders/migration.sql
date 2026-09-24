-- =============================================================================
-- DIAGNOSTIC DEPARTMENTS AND ORDERS
--
-- Checkpoint 2 of docs/09-diagnostics-plan.md. A doctor raises "X-ray, left
-- knee, AP and lateral" from the consultation; it becomes work for the X-ray
-- department; the result is attached against it in checkpoint 3.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A department that does tests rather than consultations.
--
-- A flag on the existing table rather than a second table. An X-ray department
-- IS a department — it has a name, staff and a display order — and splitting it
-- would mean two places to look for "what departments does this clinic have"
-- and two ways to get that wrong.
--
-- What the flag changes: a diagnostic department has no appointment slots and
-- does not appear at the first step of booking. Nobody books an appointment with
-- radiology; a doctor sends them there mid-visit.
-- -----------------------------------------------------------------------------
ALTER TABLE "department"
  ADD COLUMN "is_diagnostic" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "department"."is_diagnostic" IS
  'X-ray, pathology. No appointment slots; absent from booking. See docs/09.';

-- -----------------------------------------------------------------------------
-- The order.
-- -----------------------------------------------------------------------------
CREATE TYPE "diagnostic_order_status" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

CREATE TABLE "diagnostic_order" (
  "id"        uuid PRIMARY KEY DEFAULT uuidv7(),
  "tenant_id" uuid NOT NULL,

  -- The VISIT that raised it, not the day. A patient sent for an X-ray and
  -- brought back is the same visit (docs/05), and the order belongs to it.
  "appointment_id" uuid NOT NULL,
  "patient_id"     uuid NOT NULL,
  "department_id"  uuid NOT NULL,
  "ordered_by_user_id" uuid NOT NULL,

  -- Free text on purpose. A coded catalogue of studies is its own project, and
  -- a clinic that cannot type what it wants will write it on paper instead —
  -- which is the outcome this feature exists to prevent.
  "description" varchar(300) NOT NULL,
  "status"      "diagnostic_order_status" NOT NULL DEFAULT 'PENDING',

  -- Filled when the result is attached, in checkpoint 3.
  "result_note"          varchar(2000),
  "completed_at"         timestamptz(6),
  "completed_by_user_id" uuid,

  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT "diagnostic_order_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "diagnostic_order_appointment_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "diagnostic_order_patient_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "diagnostic_order_department_fkey"
    FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "diagnostic_order_ordered_by_fkey"
    FOREIGN KEY ("ordered_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "diagnostic_order_completed_by_fkey"
    FOREIGN KEY ("completed_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,

  -- A completed order has to say who completed it and when. Two of the three
  -- filled in is a row nobody can explain later.
  CONSTRAINT "diagnostic_order_completion_is_attributed" CHECK (
    ("status" <> 'COMPLETED' AND "completed_at" IS NULL AND "completed_by_user_id" IS NULL)
    OR
    ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "completed_by_user_id" IS NOT NULL)
  )
);

-- The worklist query: pending orders for a department, oldest first, because a
-- queue that does not run oldest-first is not a queue.
CREATE INDEX "diagnostic_order_worklist_idx"
  ON "diagnostic_order" ("tenant_id", "department_id", "status", "created_at");

-- "What did I order for this patient" — the consultation's view.
CREATE INDEX "diagnostic_order_visit_idx"
  ON "diagnostic_order" ("tenant_id", "appointment_id");

ALTER TABLE "diagnostic_order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diagnostic_order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "diagnostic_order"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON "diagnostic_order" TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- No DELETE.
--
-- An order raised in error is CANCELLED, not removed. "Why was this patient sent
-- for an X-ray" is a question with an answer, and deleting the row deletes the
-- answer. Same reasoning as an invoice that is cancelled rather than dropped.
-- -----------------------------------------------------------------------------
REVOKE DELETE ON "diagnostic_order" FROM healthcloud_app;

-- -----------------------------------------------------------------------------
-- Link the document to the order it satisfies.
--
-- Nullable, because a clinic may want to attach a report that nobody ordered —
-- a letter a patient brought in, a scan done elsewhere. The order is how a
-- result gets to the doctor who asked for it, not the only way a file can exist.
-- -----------------------------------------------------------------------------
ALTER TABLE "clinical_document"
  ADD COLUMN "diagnostic_order_id" uuid;

ALTER TABLE "clinical_document" ADD CONSTRAINT "clinical_document_order_fkey"
  FOREIGN KEY ("diagnostic_order_id") REFERENCES "diagnostic_order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "clinical_document_order_idx"
  ON "clinical_document" ("tenant_id", "diagnostic_order_id");
