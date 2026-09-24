-- CreateEnum
CREATE TYPE "service_category" AS ENUM ('CONSULTATION', 'PROCEDURE', 'DIAGNOSTIC', 'CONSUMABLE', 'OTHER');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'WAIVED', 'DEFERRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "payment_mode" AS ENUM ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_direction" AS ENUM ('IN', 'REFUND');

-- AlterTable
ALTER TABLE "practitioner" ADD COLUMN     "consultation_fee_paise" INTEGER,
ADD COLUMN     "follow_up_fee_paise" INTEGER;

-- CreateTable
CREATE TABLE "service" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category" "service_category" NOT NULL DEFAULT 'CONSULTATION',
    "price_paise" INTEGER NOT NULL,
    "tax_rate_basis_points" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "patient_id" UUID NOT NULL,
    "appointment_id" UUID,
    "status" "invoice_status" NOT NULL DEFAULT 'UNPAID',
    "subtotal_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "tax_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL,
    "reason" VARCHAR(300),
    "authorised_by_user_id" UUID,
    "issued_by_user_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "service_id" UUID,
    "description" VARCHAR(200) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "tax_rate_basis_points" INTEGER NOT NULL DEFAULT 0,
    "tax_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "direction" "payment_direction" NOT NULL DEFAULT 'IN',
    "mode" "payment_mode" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reference" VARCHAR(120),
    "collected_by_user_id" UUID NOT NULL,
    "collected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_counter" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "prefix" VARCHAR(8) NOT NULL DEFAULT 'INV',
    "last_number" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_counter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_tenant_id_is_active_category_idx" ON "service"("tenant_id", "is_active", "category");

-- CreateIndex
CREATE UNIQUE INDEX "service_tenant_id_code_key" ON "service"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_appointment_id_key" ON "invoice"("appointment_id");

-- CreateIndex
CREATE INDEX "invoice_tenant_id_patient_id_issued_at_idx" ON "invoice"("tenant_id", "patient_id", "issued_at");

-- CreateIndex
CREATE INDEX "invoice_tenant_id_status_idx" ON "invoice"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "invoice_tenant_id_issued_at_idx" ON "invoice"("tenant_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_tenant_id_number_key" ON "invoice"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "invoice_line_tenant_id_invoice_id_idx" ON "invoice_line"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payment_tenant_id_invoice_id_idx" ON "payment"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payment_tenant_id_collected_at_idx" ON "payment"("tenant_id", "collected_at");

-- CreateIndex
CREATE INDEX "payment_tenant_id_collected_by_user_id_collected_at_idx" ON "payment"("tenant_id", "collected_by_user_id", "collected_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_counter_tenant_id_key" ON "invoice_counter"("tenant_id");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- ROW-LEVEL SECURITY for the billing tables (ADR-005)
--
-- Same migration as the CREATE TABLE above, so no database state ever exists in
-- which a table holding a clinic's revenue lacks tenant isolation.
-- =============================================================================

ALTER TABLE "service" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "service"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "service" TO healthcloud_app;

ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- No DELETE. An invoice is voided by setting status = CANCELLED, never removed:
-- a deleted invoice is indistinguishable from one that never existed, and "we
-- cancelled it" is a claim the clinic has to be able to prove. The REVOKE is
-- what actually enforces this — bootstrap.sql's ALTER DEFAULT PRIVILEGES grants
-- all four on every new table, so a narrower GRANT alone would be decorative.
GRANT SELECT, INSERT, UPDATE ON "invoice" TO healthcloud_app;
REVOKE DELETE ON "invoice" FROM healthcloud_app;

ALTER TABLE "invoice_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_line"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- Lines ARE deletable: an unpaid invoice can still be edited at the desk before
-- money changes hands, and the service refuses once a payment exists.
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_line" TO healthcloud_app;

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- Append-only, like the clinical addendum and for the same reason: a payment
-- record that can be edited or removed cannot reconcile a cash drawer. A
-- mistaken payment is corrected by a REFUND row, which is the truth of what
-- happened. This REVOKE is the only thing standing between a bug in the service
-- layer and money quietly disappearing from the ledger.
GRANT SELECT, INSERT ON "payment" TO healthcloud_app;
REVOKE UPDATE, DELETE ON "payment" FROM healthcloud_app;

ALTER TABLE "invoice_counter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_counter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_counter"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON "invoice_counter" TO healthcloud_app;

-- =============================================================================
-- INTEGRITY
-- =============================================================================

-- Money is never negative anywhere. A refund is a direction, not a sign — see
-- the note on payment.amount_paise.
ALTER TABLE "invoice" ADD CONSTRAINT invoice_amounts_non_negative CHECK (
      subtotal_paise >= 0 AND discount_paise >= 0 AND tax_paise >= 0 AND total_paise >= 0
);

ALTER TABLE "invoice_line" ADD CONSTRAINT invoice_line_amounts_non_negative CHECK (
      quantity > 0 AND unit_price_paise >= 0 AND discount_paise >= 0 AND tax_paise >= 0
  AND total_paise >= 0
);

-- The line total must equal its own arithmetic. Stored so an invoice can be
-- displayed without recomputation, and constrained so the stored value cannot
-- drift from the numbers it claims to summarise.
ALTER TABLE "invoice_line" ADD CONSTRAINT invoice_line_total_is_consistent CHECK (
  total_paise = (quantity * unit_price_paise) - discount_paise + tax_paise
);

-- A discount cannot exceed what is being discounted.
ALTER TABLE "invoice_line" ADD CONSTRAINT invoice_line_discount_within_bounds CHECK (
  discount_paise <= quantity * unit_price_paise
);

-- Zero-rupee payments are not a tender, they are a mistake.
ALTER TABLE "payment" ADD CONSTRAINT payment_amount_positive CHECK (amount_paise > 0);

-- A refund without a reason is unexplainable money leaving the clinic.
ALTER TABLE "payment" ADD CONSTRAINT payment_refund_has_reason CHECK (
  direction <> 'REFUND' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
);

-- Waiving, deferring and cancelling all need a reason and an authoriser. The
-- service enforces this too; the constraint is what holds when a future code
-- path sets the status and forgets the rest.
ALTER TABLE "invoice" ADD CONSTRAINT invoice_exception_is_explained CHECK (
  status NOT IN ('WAIVED', 'DEFERRED', 'CANCELLED')
  OR (reason IS NOT NULL AND length(btrim(reason)) > 0 AND authorised_by_user_id IS NOT NULL)
);

-- =============================================================================
-- SERIAL RECEIPT NUMBERS
--
-- Same atomic pattern as next_queue_token() and the UHID counter: INSERT ... ON
-- CONFLICT DO UPDATE ... RETURNING is atomic, SELECT max + 1 is not — and two
-- receptionists billing at once would be handed the same receipt number, which
-- for a financial document is not a cosmetic problem.
-- =============================================================================

CREATE OR REPLACE FUNCTION next_invoice_number(p_tenant_id uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_prefix text;
  v_number bigint;
BEGIN
  INSERT INTO invoice_counter (tenant_id, last_number)
       VALUES (p_tenant_id, 1)
  ON CONFLICT (tenant_id)
    DO UPDATE SET last_number = invoice_counter.last_number + 1
    RETURNING prefix, last_number INTO v_prefix, v_number;

  RETURN v_prefix || '-' || lpad(v_number::text, 6, '0');
END; $$;
