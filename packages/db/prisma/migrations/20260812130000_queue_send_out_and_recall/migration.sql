-- =============================================================================
-- SENT OUT, AND BACK AGAIN
--
-- See docs/05-token-queue-plan.md, phase B.
--
-- The case this exists for: the doctor sends a patient for an X-ray, and they
-- come back thirty minutes later. That is not a new arrival — it is the same
-- visit, resumed, carrying the same token, the same draft note and the same
-- bill. Modelling it as a second appointment would raise a second invoice, and
-- the clinic would spend its afternoon cancelling bills.
--
-- Phase A already added the columns that decide where they land on their
-- return. This migration adds the state they occupy while they are gone.
-- =============================================================================

-- AlterEnum
--
-- It could have been ARRIVED with a non-null sent_out_at. It is a status of its
-- own because three separate readers — the board, the doctor's list and the
-- day-end counts — all need to tell "waiting to be seen" from "waiting for a
-- report", and a state that exists only as the absence of a timestamp is the
-- kind the next query forgets.
ALTER TYPE "appointment_status" ADD VALUE 'AWAITING_TESTS' AFTER 'IN_PROGRESS';

-- AlterTable
ALTER TABLE "appointment"
  ADD COLUMN "sent_out_at"     TIMESTAMPTZ(6),
  ADD COLUMN "sent_out_reason" VARCHAR(200),
  ADD COLUMN "returned_at"     TIMESTAMPTZ(6);

COMMENT ON COLUMN "appointment"."sent_out_reason" IS
  'What they were sent for — "X-ray, left wrist". Read by the front desk, who otherwise do not know who they are waiting for.';

-- -----------------------------------------------------------------------------
-- Sending someone out without saying what for leaves the desk unable to answer
-- the only question the patient will ask when they come back.
-- -----------------------------------------------------------------------------
ALTER TABLE "appointment" ADD CONSTRAINT appointment_send_out_is_explained CHECK (
  (sent_out_at IS NULL AND sent_out_reason IS NULL)
  OR (sent_out_at IS NOT NULL AND sent_out_reason IS NOT NULL AND length(btrim(sent_out_reason)) > 0)
);

-- -----------------------------------------------------------------------------
-- You cannot come back from somewhere you were never sent.
--
-- This is the constraint that keeps "back from tests" from becoming the fast
-- lane for anyone who complains: the flag it grants is only reachable through a
-- send-out the doctor actually recorded. The service checks it too; this is what
-- holds when a future code path forgets to.
-- -----------------------------------------------------------------------------
ALTER TABLE "appointment" ADD CONSTRAINT appointment_return_needs_a_departure CHECK (
  returned_at IS NULL OR sent_out_at IS NOT NULL
);

-- No index for the "away for tests" panel: a partial index on the new enum
-- value cannot be created in the same transaction that adds it, and it would
-- earn nothing anyway — appointment_tenant_id_practitioner_id_queue_date_status_idx
-- already covers "this doctor, this day, this status", which is exactly the
-- lookup the panel makes.
