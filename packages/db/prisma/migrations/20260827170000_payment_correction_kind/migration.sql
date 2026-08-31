-- =============================================================================
-- WHY THE MONEY CAME BACK
--
-- FR-BIL-11 to FR-BIL-13. A compensating entry already exists — `payment` rows
-- with direction REFUND, which is how a mistake is corrected in a table that
-- REVOKEs UPDATE and DELETE. What was missing is which KIND of correction it is.
--
-- Two things wear the same shape and are not the same event:
--
--   PATIENT_REFUND     money physically went back to the patient
--   RECORDED_IN_ERROR  the entry was never real — wrong amount, wrong patient,
--                      wrong invoice — and no money moved either way
--
-- The accounting is identical: both reduce what the invoice has been paid, and
-- both are entries rather than edits. The difference is what an owner counting
-- the drawer at closing needs to know. ₹500 that LEFT the drawer and ₹500 that
-- was never in it net to the same figure and are completely different problems.
-- Narveer chose to distinguish them on 27 Aug 2026.
-- =============================================================================

CREATE TYPE "payment_correction_kind" AS ENUM ('PATIENT_REFUND', 'RECORDED_IN_ERROR');

ALTER TABLE "payment"
  ADD COLUMN "correction_kind" "payment_correction_kind";

-- Set exactly when the row IS a correction, and never otherwise. A money-in row
-- carrying a correction kind is a row nobody can interpret, and a refund without
-- one is the ambiguity this migration exists to remove.
ALTER TABLE "payment"
  ADD CONSTRAINT "payment_correction_kind_matches_direction" CHECK (
    ("direction" = 'REFUND' AND "correction_kind" IS NOT NULL)
    OR
    ("direction" <> 'REFUND' AND "correction_kind" IS NULL)
  );

COMMENT ON COLUMN "payment"."correction_kind" IS
  'Why a REFUND row exists: money returned to the patient, or an entry that was never real. Null on money-in.';

-- -----------------------------------------------------------------------------
-- Existing refunds.
--
-- Everything already in the table predates the distinction, and the honest
-- reading of a refund recorded before today is that money was returned — that is
-- what the action was called and what whoever pressed it believed they were
-- doing. Guessing "recorded in error" for any of them would be inventing a fact
-- about somebody's cash drawer.
--
-- Written under a per-tenant loop: `payment` carries FORCE ROW LEVEL SECURITY,
-- and FORCE applies to the migration's own role. A plain UPDATE here matches
-- zero rows, reports success, and leaves every clinic failing the CHECK above on
-- their next refund. See docs/03-resume-here.md.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant  record;
  v_changed integer;
  v_total   integer := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    UPDATE payment
       SET correction_kind = 'PATIENT_REFUND'
     WHERE direction = 'REFUND'
       AND correction_kind IS NULL;

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;
  END LOOP;

  RAISE NOTICE 'Labelled % existing refund(s) as PATIENT_REFUND.', v_total;
END $$;
