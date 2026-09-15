-- =============================================================================
-- THE REPORT WAS GIVEN TO THE PATIENT
--
-- FR-DIA-13. A doctor-ordered test ends when the result reaches the doctor,
-- and the system can see that happen — the film appears in the consultation.
-- A walk-in test ends when a person is handed a piece of paper at a counter,
-- which the system cannot see at all.
--
-- "A patient who paid and left without their film is a complaint waiting to
-- happen", and the only defence against that complaint is a record of who gave
-- it to whom and when. So it is recorded.
--
-- Three columns that move together, and the CHECK says so. A handover with no
-- time is not a record, a time with no staff member behind it cannot be
-- answered for, and "handed over" with nobody named is the exact claim the
-- complaint disputes — the relative who says they were never given it.
--
-- Nothing to backfill: no report has ever been handed over through this
-- system, because until now there was nowhere to say so.
-- =============================================================================

ALTER TABLE "diagnostic_order" ADD COLUMN "handed_over_at"         TIMESTAMPTZ(6);
ALTER TABLE "diagnostic_order" ADD COLUMN "handed_over_by_user_id" UUID;
ALTER TABLE "diagnostic_order" ADD COLUMN "handed_over_to"         VARCHAR(160);

ALTER TABLE "diagnostic_order" ADD CONSTRAINT "diagnostic_order_handover_fkey"
  FOREIGN KEY ("handed_over_by_user_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- All three, or none. Modelled on `diagnostic_order_completion_is_attributed`,
-- which holds the same shape for the completion columns.
ALTER TABLE "diagnostic_order" ADD CONSTRAINT "diagnostic_order_handover_is_complete" CHECK (
  (
    "handed_over_at" IS NULL
    AND "handed_over_by_user_id" IS NULL
    AND "handed_over_to" IS NULL
  )
  OR (
    "handed_over_at" IS NOT NULL
    AND "handed_over_by_user_id" IS NOT NULL
    AND "handed_over_to" IS NOT NULL
    AND length(btrim("handed_over_to")) > 0
  )
);

-- A report cannot be handed over before it exists. The service refuses this
-- too; the constraint is what holds when a future code path forgets.
ALTER TABLE "diagnostic_order" ADD CONSTRAINT "diagnostic_order_handover_needs_result" CHECK (
  "handed_over_at" IS NULL OR "status" = 'COMPLETED'
);

COMMENT ON COLUMN "diagnostic_order"."handed_over_to" IS
  'Who physically took the report — the patient, or the relative who collected it. Free text, because that is what the counter knows.';

-- No RLS work: `diagnostic_order` already carries tenant_id and its policy.
