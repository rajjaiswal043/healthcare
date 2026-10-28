-- =============================================================================
-- A DOCUMENT CAN BE TAKEN BACK
--
-- There was no way to remove a clinical document at all: upload, list, fetch,
-- and nothing else. So a report attached to the wrong patient stayed on that
-- patient's record for ever, showing to every clinician who opened it.
--
-- Reported from the clinic on 28 Oct 2026 as two items — "uploaded PDF accepts
-- mismatched patient details" and "no delete option for a mismatched report".
-- They are one problem. Nothing can read a PDF and tell whose it is; a person
-- picking the wrong file is a human error, and what the software owes is a way
-- to take it back.
--
-- REMOVED, NOT DELETED. The row stays and carries who removed it, when, and
-- why. This is clinical data about a real patient: "a report that was never
-- this patient's sat on their record between 11:04 and 11:09" is itself a fact
-- somebody may have to answer for, and a DELETE destroys the only evidence it
-- ever happened. The same shape as a corrected vitals reading and a reversed
-- payment, for the same reason.
--
-- The object stays in S3 too. Nothing reads it once the row is marked, and
-- deleting the bytes while keeping the row would leave a record pointing at
-- nothing — which reads like data loss rather than a correction.
-- =============================================================================

ALTER TABLE "clinical_document"
  ADD COLUMN "removed_at" TIMESTAMPTZ(6),
  ADD COLUMN "removed_by_user_id" UUID,
  ADD COLUMN "removal_reason" VARCHAR(300);

-- All three, or none. Modelled on `diagnostic_order_completion_is_attributed`,
-- which holds the same shape for the completion columns: a removal with nobody
-- attached to it is not a record of anything.
ALTER TABLE "clinical_document" ADD CONSTRAINT "clinical_document_removal_is_attributed" CHECK (
  (
    "removed_at" IS NULL
    AND "removed_by_user_id" IS NULL
    AND "removal_reason" IS NULL
  )
  OR
  (
    "removed_at" IS NOT NULL
    AND "removed_by_user_id" IS NOT NULL
    AND "removal_reason" IS NOT NULL
  )
);

-- RESTRICT like every other actor column on this table: the fact survives the
-- account being switched off, and a SET NULL would quietly rewrite history to
-- say nobody removed it.
ALTER TABLE "clinical_document"
  ADD CONSTRAINT "clinical_document_remover_fkey"
  FOREIGN KEY ("removed_by_user_id") REFERENCES "app_user" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every list of a patient's documents now asks for the live ones. The existing
-- patient index still serves the ordering; this one answers the filter.
CREATE INDEX "clinical_document_live_idx"
  ON "clinical_document" ("tenant_id", "patient_id", "created_at" DESC)
  WHERE "removed_at" IS NULL;

-- No backfill, and nothing to backfill: every document that exists today is
-- live, which is what three NULLs mean.
