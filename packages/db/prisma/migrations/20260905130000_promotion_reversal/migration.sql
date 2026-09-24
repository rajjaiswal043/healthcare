-- =============================================================================
-- UNDOING A PROMOTION BEFORE PAYMENT
--
-- A reversal is a NEW ROW, never an edit and never a delete — the same shape as
-- a refund against a payment, and for the same reason: this table answers "who
-- gave money away, and on whose instruction", and a row that can be changed
-- answers nothing. `promotion_application` keeps SELECT and INSERT only.
--
-- WHY THE "ONE ACTIVE PROMOTION" RULE IS NOT A PARTIAL INDEX ON invoice_id
--
-- The obvious shape — UNIQUE (invoice_id) WHERE reversal_kind IS NULL — cannot
-- work alongside append-only. Reversing inserts a compensating row, which
-- leaves the ORIGINAL apply row still carrying reversal_kind IS NULL and still
-- occupying the index slot. Applying a second promotion afterwards then fails
-- with a duplicate key on a bill that has no active discount at all. Freeing
-- that slot would need an UPDATE of the original row, which is the thing this
-- design exists to prevent. (Verified against a scratch table before choosing
-- what follows.)
--
-- So the "at most one active" invariant moves to where a single value can hold
-- it: `invoice.active_promotion_application_id`. One nullable column is one
-- promotion by construction — stronger than a unique index, because two is not
-- expressible. The invoice table is already the denormalised face of its lines
-- (`discount_paise` lives there for the same reason) and already grants UPDATE.
--
-- What DOES stay a partial unique index is the rule it can express honestly:
-- an application may be reversed at most once.
-- =============================================================================

-- CreateEnum
--
-- Two kinds, mirroring payment_correction_kind, because the difference matters
-- to whoever reads the day's discounts: one says the discount should never have
-- been given, the other says it was given properly and then called back.
CREATE TYPE "promotion_reversal_kind" AS ENUM ('APPLIED_IN_ERROR', 'AUTHORISATION_WITHDRAWN');

-- AlterTable
ALTER TABLE "promotion_application"
  ADD COLUMN "reversal_kind" "promotion_reversal_kind",
  ADD COLUMN "reverses_application_id" UUID;

-- A row is either an application or a reversal of one. Half-filled is neither.
ALTER TABLE "promotion_application" ADD CONSTRAINT promotion_application_reversal_is_complete CHECK (
  ("reversal_kind" IS NULL) = ("reverses_application_id" IS NULL)
);

ALTER TABLE "promotion_application" ADD CONSTRAINT "promotion_application_reverses_fkey"
  FOREIGN KEY ("reverses_application_id") REFERENCES "promotion_application"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The old rule: at most one application row per invoice, ever. That is now
-- wrong — an invoice may accumulate a history of applied-then-reversed
-- discounts, and only the CURRENT one is constrained.
DROP INDEX "promotion_application_invoice_key";

-- Reversing the same application twice would double-count the money coming
-- back. Partial, because ordinary application rows all carry NULL here and are
-- not competing for anything.
CREATE UNIQUE INDEX "promotion_application_reverses_key"
  ON "promotion_application" ("reverses_application_id")
  WHERE "reverses_application_id" IS NOT NULL;

-- Reporting reads the history per invoice, so it needs an ordinary index where
-- it used to get one free from the unique constraint.
CREATE INDEX "promotion_application_invoice_idx"
  ON "promotion_application" ("tenant_id", "invoice_id", "applied_at");

-- AlterTable
--
-- The one active discount, or none. Nullable and single: "two promotions on one
-- bill" is not a state this schema can hold.
ALTER TABLE "invoice" ADD COLUMN "active_promotion_application_id" UUID;

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_active_promotion_fkey"
  FOREIGN KEY ("active_promotion_application_id") REFERENCES "promotion_application"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- BACKFILL
--
-- Every application written before this migration is by definition the active
-- one on its invoice — there was no way to reverse anything. Point each invoice
-- at it.
--
-- THE set_config LOOP IS LOAD-BEARING, as ever: `invoice` and
-- `promotion_application` are both under FORCE row level security, which
-- applies to the owner this migration runs as. Without the loop the UPDATE
-- matches zero rows and reports success, and the invoices silently forget they
-- were discounted.
-- =============================================================================

DO $$
DECLARE
  v_tenant  record;
  v_changed integer;
  v_total   integer := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    UPDATE invoice i
       SET active_promotion_application_id = pa.id
      FROM promotion_application pa
     WHERE pa.invoice_id = i.id
       AND pa.reversal_kind IS NULL
       AND i.active_promotion_application_id IS NULL;

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;
  END LOOP;

  RAISE NOTICE 'Pointed % invoice(s) at their active promotion.', v_total;
END $$;

-- Grants are deliberately NOT widened. promotion_application stays SELECT and
-- INSERT: a reversal is an insert, and there is still no way for the
-- application to edit or remove what it already wrote.
COMMENT ON COLUMN "promotion_application"."reversal_kind" IS
  'Set on a compensating row that reverses an earlier application. NULL on an application itself.';
COMMENT ON COLUMN "invoice"."active_promotion_application_id" IS
  'The one discount currently on this bill, or NULL. Reversed applications stay in promotion_application as history.';
