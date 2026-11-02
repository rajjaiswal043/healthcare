-- =============================================================================
-- A CHARGE CAN BE FORGIVEN, IN PART, AND THE REASON IS KEPT
--
-- Narveer, 2 Nov 2026: "my relative came for an X-ray, front desk took the
-- money, I want to give him these services for free". Two or three a day.
--
-- Until now the only waiver was all-or-nothing (`invoice.status = 'WAIVED'`),
-- and it refused any bill that had been paid — so the money had to be refunded
-- first, which flipped the bill back to UNPAID and left the patient apparently
-- owing what he had just been handed back.
--
-- WHY A TABLE AND NOT A THIRD `payment_direction`:
--
-- A payment is one TENDER against an invoice. A waiver is not a tender; no
-- money moves. Beyond that, three places in the finance report compute
-- `direction = 'IN' ? amount : -amount`, so a third direction would be read as
-- money handed back and every waiver would quietly reduce reported collections.
-- Twenty-one sites read `direction`. A separate table cannot be swept into that
-- arithmetic by accident.
-- =============================================================================

CREATE TABLE "invoice_write_off" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "waived_by_user_id" UUID NOT NULL,
    "waived_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "voided_at" TIMESTAMPTZ(6),
    "voided_by_user_id" UUID,
    "void_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "invoice_write_off_pkey" PRIMARY KEY ("id")
);

-- RESTRICT: a bill cannot be deleted out from under the record of what was
-- given away on it.
ALTER TABLE "invoice_write_off"
  ADD CONSTRAINT "invoice_write_off_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "invoice_write_off_invoice_idx"
  ON "invoice_write_off" ("tenant_id", "invoice_id");

-- Forgiving nothing is not a decision anybody needs recorded, and a negative
-- waiver is a charge by another name.
ALTER TABLE "invoice_write_off"
  ADD CONSTRAINT invoice_write_off_is_a_real_amount CHECK ("amount_paise" > 0);

-- The description is the whole point of the table. A blank one would leave a
-- figure in the year-end total that nobody can account for.
ALTER TABLE "invoice_write_off"
  ADD CONSTRAINT invoice_write_off_is_explained CHECK (length(btrim("reason")) > 0);

-- A void says WHO undid it and WHY, or it is not a void. All three columns
-- travel together, exactly as `diagnostic_order_completion_is_attributed` does
-- for a completed test.
ALTER TABLE "invoice_write_off"
  ADD CONSTRAINT invoice_write_off_void_is_attributed CHECK (
    ("voided_at" IS NULL AND "voided_by_user_id" IS NULL AND "void_reason" IS NULL)
    OR (
      "voided_at" IS NOT NULL
      AND "voided_by_user_id" IS NOT NULL
      AND "void_reason" IS NOT NULL
      AND length(btrim("void_reason")) > 0
    )
  );

-- =============================================================================
-- ROW LEVEL SECURITY — ADR-005
--
-- FORCE so it applies to the table owner too, and both USING and WITH CHECK so
-- the table cannot be written across tenants even where it cannot be read
-- across. `rls:check` fails the build without all four.
-- =============================================================================

ALTER TABLE "invoice_write_off" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_write_off" FORCE ROW LEVEL SECURITY;

CREATE POLICY invoice_write_off_tenant_isolation ON "invoice_write_off"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "invoice_write_off" TO healthcloud_app;

COMMENT ON TABLE "invoice_write_off" IS
  'A charge forgiven in whole or in part, with who did it and why. Append-only except for the void columns; never deleted.';
