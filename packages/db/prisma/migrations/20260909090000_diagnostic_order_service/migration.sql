-- =============================================================================
-- A DIAGNOSTIC ORDER CAN NAME A PRICED TEST
--
-- Phase 1 of the doctor-ordered diagnostics loop. Until now every order was
-- free text and nothing else: `description` said "X-ray left knee" and no row
-- anywhere knew what that costs or whether the clinic even offers it. That is
-- why no doctor-ordered test has ever been billed.
--
-- This column is the join that makes billing possible in phase 2. It does NOT
-- make the order billed — `invoice_line_id` arrives with that phase.
--
-- Nullable on purpose, for two separate reasons:
--   * every order that already exists predates the catalogue, and
--   * a test the clinic does not offer never gets a service (decision (b) —
--     "Other" leaves the order flow entirely and becomes a line on the slip).
--
-- ON DELETE SET NULL, matching `invoice_line.service_id`, and for the same
-- reason: `description` is a snapshot of what was ordered, so an order still
-- reads correctly in ten years after the service behind it is gone. The link is
-- an aid to reporting, never the source of truth for what was ordered.
--
-- No RLS work: `diagnostic_order` already carries tenant_id and its policy from
-- 20260827090000_diagnostic_orders — adding a column to a protected table needs no new policy, and
-- `pnpm rls:check` re-verifies the table either way.
-- =============================================================================

-- AlterTable
ALTER TABLE "diagnostic_order" ADD COLUMN "service_id" UUID;

-- AddForeignKey
ALTER TABLE "diagnostic_order" ADD CONSTRAINT "diagnostic_order_service_fkey"
  FOREIGN KEY ("service_id") REFERENCES "service"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
--
-- "how many times was this test ordered, and what did it earn" is the first
-- question the department revenue report asks (FR-DIA-15).
CREATE INDEX "diagnostic_order_service_idx" ON "diagnostic_order"("tenant_id", "service_id");

COMMENT ON COLUMN "diagnostic_order"."service_id" IS
  'The priced catalogue test this order names, when it names one. Null for free-text and pre-catalogue orders; description remains the record of what was ordered.';
