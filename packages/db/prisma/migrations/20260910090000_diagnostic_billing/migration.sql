-- =============================================================================
-- A TEST IS A CHARGE
--
-- Phase 2 of the doctor-ordered diagnostics loop. Until now a diagnostic order
-- cost nothing: there was no path from an order to a bill, and no doctor-ordered
-- test had ever been billed. This migration lays the two links that make the
-- charge possible, and the flag that keeps every order raised before today out
-- of the gate that arrives in phase 3.
--
-- Three separate changes, and they are separate on purpose.
-- =============================================================================


-- =============================================================================
-- 1. WHICH VISIT A BILL BELONGS TO
--
-- `invoice.appointment_id` is UNIQUE, and it means something narrow: "this
-- invoice IS the consultation bill for that appointment". A test bill for the
-- same visit cannot borrow it — the constraint forbids a second row — which
-- would have left every test invoice orphaned from the visit that produced it:
-- invisible on the visit's billing screen, and permanently in the finance
-- report's "Not attributed to a doctor" bucket.
--
-- So the two meanings get two columns. `appointment_id` keeps saying "this is
-- the consultation bill" and stays unique. `visit_appointment_id` says the
-- weaker and more useful thing — "this bill came out of that visit" — and is
-- deliberately NOT unique, because one visit can produce a consultation bill
-- and one or more test bills.
--
-- Backfilled for existing invoices below, so every consumer can read the new
-- column alone rather than coalescing two.
-- =============================================================================

ALTER TABLE "invoice" ADD COLUMN "visit_appointment_id" UUID;

-- RESTRICT, matching `invoice.appointment_id`: a visit with money attached to it
-- is not something to remove without a person looking at the money first.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_visit_appointment_fkey"
  FOREIGN KEY ("visit_appointment_id") REFERENCES "appointment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "invoice_visit_appointment_idx"
  ON "invoice"("tenant_id", "visit_appointment_id");

COMMENT ON COLUMN "invoice"."visit_appointment_id" IS
  'The visit this bill came out of. Not unique: one visit may produce a consultation bill and separate test bills. Distinct from appointment_id, which means "this IS the consultation bill".';

-- Backfill.
--
-- Migrations run as the owner, and every tenant-scoped table here is FORCE ROW
-- LEVEL SECURITY, so a bare UPDATE would match zero rows and report success.
-- The loop sets app.tenant_id per tenant, which is the only way a data
-- migration touches anything in this schema. Counts are raised so the log says
-- what moved rather than leaving it to be discovered later.
DO $$
DECLARE
  v_tenant record;
  v_rows   bigint;
  v_total  bigint := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    UPDATE invoice
       SET visit_appointment_id = appointment_id
     WHERE appointment_id IS NOT NULL
       AND visit_appointment_id IS NULL;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;

    IF v_rows > 0 THEN
      RAISE NOTICE 'tenant %: % invoice(s) linked to their visit', v_tenant.id, v_rows;
    END IF;
  END LOOP;

  RAISE NOTICE 'visit_appointment_id backfill: % invoice(s) in total', v_total;
END $$;


-- =============================================================================
-- 2. WHICH CHARGE A TEST IS
--
-- The link the pay-first gate reads in phase 3. Keyed on the ORDER rather than
-- the appointment, deliberately: a walk-in test has no appointment, and the
-- same gate has to serve both flows.
--
-- ON DELETE RESTRICT, and this one matters. `removeLine` hard-deletes an
-- invoice line; SET NULL here would silently turn "this test was declined" into
-- "this test was never billed", which is the state the gate treats as suspect.
-- RESTRICT makes that deletion fail loudly instead, which is what forces the
-- decline path in phase 4 to be written properly.
-- =============================================================================

ALTER TABLE "diagnostic_order" ADD COLUMN "invoice_line_id" UUID;

ALTER TABLE "diagnostic_order" ADD CONSTRAINT "diagnostic_order_invoice_line_fkey"
  FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_line"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One line per order and one order per line. Two orders sharing a charge would
-- mean one test was performed twice and paid for once.
CREATE UNIQUE INDEX "diagnostic_order_invoice_line_key"
  ON "diagnostic_order"("invoice_line_id")
  WHERE "invoice_line_id" IS NOT NULL;

COMMENT ON COLUMN "diagnostic_order"."invoice_line_id" IS
  'The charge raised for this test. Null for a free-text order, and for every order predating this migration — see legacy_unbilled.';


-- =============================================================================
-- 3. THE GRANDFATHER FLAG
--
-- Every order that exists right now was raised when tests were not billed at
-- all. Phase 3 blocks result release on an unpaid test; without this flag that
-- gate would, on the morning it ships, make every historical pending order
-- impossible to complete — a clinic would arrive to find its worklist frozen.
--
-- The timestamp cutoff is expressed as a column default rather than an UPDATE:
-- adding the column with DEFAULT true stamps every existing row, and dropping
-- the default to false means everything raised from here on is billable. No
-- data migration, no tenant loop, and the cutoff is exactly "existed when this
-- migration ran".
-- =============================================================================

ALTER TABLE "diagnostic_order" ADD COLUMN "legacy_unbilled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "diagnostic_order" ALTER COLUMN "legacy_unbilled" SET DEFAULT false;

COMMENT ON COLUMN "diagnostic_order"."legacy_unbilled" IS
  'True for orders raised before diagnostics were billable. The pay-first gate skips them; nothing else reads it.';

-- No RLS work anywhere above: `invoice` and `diagnostic_order` both already
-- carry tenant_id and their policies. Adding columns to protected tables needs
-- no new policy, and `pnpm rls:check` re-verifies both either way.
