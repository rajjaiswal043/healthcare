-- =============================================================================
-- RECEIPTS — FR-RCP-01, -02, -03
--
-- A RECEIPT IS FOR A PAYMENT, NOT FOR A BILL. One invoice can produce several
-- receipts: ₹500 now and ₹600 on the way out is one invoice and two pieces of
-- paper, each showing what was paid at that moment and what remained. A receipt
-- that restates the whole bill every time is one a patient can use to claim they
-- paid twice.
--
-- WHY THE FIGURES ARE STORED RATHER THAN DERIVED
--
-- The plan was to derive "balance at the time of this payment" from the invoice,
-- on the reasoning that the total freezes once any payment exists. That is
-- ALMOST true and the gap is real:
--
--   BillingService.loadEditable refuses an edit when paid MINUS refunded is
--   greater than zero. Refund a payment in full and that difference is zero
--   again, so lines become editable and the invoice total can move AFTER a
--   receipt was issued against it. A reprint would then show a balance that was
--   never true on the day.
--
-- So the money block is frozen into the receipt row when the money is taken.
-- That is also what a receipt IS — a record of what a document said, not a
-- recalculation of it.
-- =============================================================================

-- CreateTable
--
-- Its own sequence, not the invoice number (decision, 6 Sep 2026). One invoice
-- can produce several receipts, so they cannot share a number without a suffix
-- — and a receipt with a suffix invites somebody to invent one.
--
-- A SEPARATE TABLE from invoice_counter, not a column on it: that table's
-- tenant_id is UNIQUE, so it holds exactly one counter per clinic.
CREATE TABLE "receipt_counter" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "prefix" VARCHAR(8) NOT NULL DEFAULT 'R',
    "last_number" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_counter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_counter_tenant_id_key" ON "receipt_counter"("tenant_id");

-- CreateTable
CREATE TABLE "receipt" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "number" VARCHAR(32) NOT NULL,

    -- The money block, in the order it prints, frozen at the moment the money
    -- was taken. Never recomputed. See the note above.
    "total_charged_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "tax_paise" INTEGER NOT NULL DEFAULT 0,
    "payable_paise" INTEGER NOT NULL,
    "paid_now_paise" INTEGER NOT NULL,
    "balance_paise" INTEGER NOT NULL,

    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- One receipt per money-in payment. A refund is not a receipt: nothing was
-- received, and printing one would put a document in a patient's hand saying
-- they paid when they were paid.
CREATE UNIQUE INDEX "receipt_payment_id_key" ON "receipt"("payment_id");
CREATE UNIQUE INDEX "receipt_tenant_id_number_key" ON "receipt"("tenant_id", "number");
CREATE INDEX "receipt_invoice_idx" ON "receipt"("tenant_id", "invoice_id", "issued_at");

-- CreateTable
--
-- THE PRINT LOG IS NOT OPTIONAL. It is the only thing that can answer "has this
-- been printed before", which is what makes a reprint markable as DUPLICATE.
-- Two identical unmarked receipts for one payment is how cash goes missing, and
-- the person exposed by it is the finance desk who cannot prove which was the
-- original.
CREATE TABLE "receipt_print" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "printed_by_user_id" UUID NOT NULL,
    "printed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_print_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "receipt_print_receipt_idx" ON "receipt_print"("tenant_id", "receipt_id", "printed_at");

-- AddForeignKey
ALTER TABLE "receipt_counter" ADD CONSTRAINT "receipt_counter_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receipt" ADD CONSTRAINT "receipt_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_payment_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_invoice_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receipt_print" ADD CONSTRAINT "receipt_print_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt_print" ADD CONSTRAINT "receipt_print_receipt_fkey"
  FOREIGN KEY ("receipt_id") REFERENCES "receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt_print" ADD CONSTRAINT "receipt_print_user_fkey"
  FOREIGN KEY ("printed_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- ROW-LEVEL SECURITY (ADR-005)
-- =============================================================================

ALTER TABLE "receipt_counter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipt_counter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "receipt_counter"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON "receipt_counter" TO healthcloud_app;

ALTER TABLE "receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "receipt"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- Append-only, like `payment` and for the same reason: this is a document the
-- patient is holding a copy of. A row that can be edited afterwards makes the
-- paper and the record disagree with nothing to say which is right.
GRANT SELECT, INSERT ON "receipt" TO healthcloud_app;
REVOKE UPDATE, DELETE ON "receipt" FROM healthcloud_app;

ALTER TABLE "receipt_print" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipt_print" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "receipt_print"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- Append-only. "How does a second copy exist" is a question the log answers, and
-- only if nothing can quietly remove an entry from it.
GRANT SELECT, INSERT ON "receipt_print" TO healthcloud_app;
REVOKE UPDATE, DELETE ON "receipt_print" FROM healthcloud_app;

-- =============================================================================
-- INTEGRITY
-- =============================================================================

ALTER TABLE "receipt" ADD CONSTRAINT receipt_amounts_non_negative CHECK (
      total_charged_paise >= 0 AND discount_paise >= 0 AND tax_paise >= 0
  AND payable_paise >= 0 AND balance_paise >= 0
);

-- A receipt for nothing is not a receipt.
ALTER TABLE "receipt" ADD CONSTRAINT receipt_paid_positive CHECK (paid_now_paise > 0);

-- The payable figure must equal its own arithmetic, exactly as invoice_line does.
ALTER TABLE "receipt" ADD CONSTRAINT receipt_payable_is_consistent CHECK (
  payable_paise = total_charged_paise - discount_paise + tax_paise
);

-- =============================================================================
-- SERIAL RECEIPT NUMBERS
--
-- The same atomic pattern as next_invoice_number() and next_queue_token():
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING is atomic, SELECT max + 1 is
-- not — and two desks taking money at once would be handed the same number,
-- which for a financial document is not a cosmetic problem.
--
-- Runs under the CALLER's tenant context, like next_invoice_number: it is not
-- SECURITY DEFINER, so the policy on receipt_counter applies to it normally and
-- there is no context to set internally.
-- =============================================================================

CREATE OR REPLACE FUNCTION next_receipt_number(p_tenant_id uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_prefix text;
  v_number bigint;
BEGIN
  INSERT INTO receipt_counter (tenant_id, last_number)
       VALUES (p_tenant_id, 1)
  ON CONFLICT (tenant_id)
    DO UPDATE SET last_number = receipt_counter.last_number + 1
    RETURNING prefix, last_number INTO v_prefix, v_number;

  RETURN v_prefix || '-' || lpad(v_number::text, 6, '0');
END; $$;

COMMENT ON FUNCTION next_receipt_number(uuid) IS
  'Atomically allocates the next receipt number for a clinic. Runs under the caller tenant context.';

GRANT EXECUTE ON FUNCTION next_receipt_number(uuid) TO healthcloud_app;

-- =============================================================================
-- BACKFILL
--
-- Every money-in payment taken before today has no receipt, so nothing could be
-- printed for it. Walk them in order and reconstruct the money block from the
-- running total — correct for all existing rows, because none of them can have
-- gone through the refund-then-edit path that made deriving unsafe in general.
--
-- THE set_config LOOP IS LOAD-BEARING. Every table here is under FORCE row-level
-- security, which applies to the owner a migration runs as. Without the loop
-- this inserts nothing and reports success.
-- =============================================================================

DO $$
DECLARE
  v_tenant  record;
  v_payment record;
  v_running integer;
  v_invoice uuid;
  v_total   integer := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    v_invoice := NULL;

    FOR v_payment IN
      SELECT p.id, p.invoice_id, p.amount_paise, p.collected_at,
             i.subtotal_paise, i.discount_paise, i.tax_paise, i.total_paise
        FROM payment p
        JOIN invoice i ON i.id = p.invoice_id
       WHERE p.direction = 'IN'
         AND NOT EXISTS (SELECT 1 FROM receipt r WHERE r.payment_id = p.id)
       ORDER BY p.invoice_id, p.collected_at
    LOOP
      -- Reset the running total whenever the invoice changes.
      IF v_invoice IS DISTINCT FROM v_payment.invoice_id THEN
        v_invoice := v_payment.invoice_id;
        v_running := 0;
      END IF;

      v_running := v_running + v_payment.amount_paise;

      INSERT INTO receipt (
        tenant_id, payment_id, invoice_id, number,
        total_charged_paise, discount_paise, tax_paise, payable_paise,
        paid_now_paise, balance_paise, issued_at
      ) VALUES (
        v_tenant.id, v_payment.id, v_payment.invoice_id,
        next_receipt_number(v_tenant.id),
        v_payment.subtotal_paise, v_payment.discount_paise, v_payment.tax_paise,
        v_payment.total_paise,
        v_payment.amount_paise,
        GREATEST(v_payment.total_paise - v_running, 0),
        v_payment.collected_at
      );

      v_total := v_total + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Backfilled % receipt(s) for payments taken before this migration.', v_total;
END $$;
