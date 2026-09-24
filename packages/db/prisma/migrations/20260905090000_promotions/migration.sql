-- =============================================================================
-- PROMOTIONS — the clinic's discounts, defined in advance and applied at billing
--
-- FR-PRO-01 and FR-PRO-02, from the clinic demos of 3 Sep 2026. Two tables:
--
--   promotion              what the administrator defined
--   promotion_application  what the finance desk actually did with one
--
-- Both are created WITH their row-level security in this same migration, so no
-- database state ever exists in which a table describing a clinic's money lacks
-- tenant isolation (ADR-005).
--
-- All money is integer paise. There is no float in this file and there should
-- never be one. A PERCENTAGE promotion introduces the first division into the
-- billing path — the service layer rounds it the way the tax calculation
-- already does, with integer arithmetic and Math.round, never a float
-- percentage. The CHECK below constrains the stored value; the rounding rule
-- lives with the code that applies it.
-- =============================================================================

-- CreateEnum
CREATE TYPE "promotion_type" AS ENUM ('PERCENTAGE', 'FLAT');

-- CreateTable
CREATE TABLE "promotion" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "type" "promotion_type" NOT NULL,
    "value" INTEGER NOT NULL,
    "max_discount_paise" INTEGER,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_application" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "discount_paise" INTEGER NOT NULL,
    "applied_by_user_id" UUID NOT NULL,
    "authorised_by_user_id" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promotion_tenant_code_key" ON "promotion"("tenant_id", "code");
CREATE INDEX "promotion_pickable_idx" ON "promotion"("tenant_id", "is_active", "valid_from");

-- One promotion per invoice in v1. Discounts are invoice-level (decision 5) and
-- do not stack. Relaxing this later is dropping an index; discovering two
-- half-applied promotions on one bill is not.
CREATE UNIQUE INDEX "promotion_application_invoice_key" ON "promotion_application"("invoice_id");
CREATE INDEX "promotion_application_reporting_idx" ON "promotion_application"("tenant_id", "applied_at");

-- AddForeignKey
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_created_by_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "promotion_application" ADD CONSTRAINT "promotion_application_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_application" ADD CONSTRAINT "promotion_application_promotion_fkey"
  FOREIGN KEY ("promotion_id") REFERENCES "promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_application" ADD CONSTRAINT "promotion_application_invoice_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_application" ADD CONSTRAINT "promotion_application_applied_by_fkey"
  FOREIGN KEY ("applied_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- NOT NULL, and a real key. Decision 3, 3 Sep 2026: naming the approver is the
-- control, and a free-text name would be a control in appearance only.
ALTER TABLE "promotion_application" ADD CONSTRAINT "promotion_application_authorised_by_fkey"
  FOREIGN KEY ("authorised_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- ROW-LEVEL SECURITY (ADR-005)
-- =============================================================================

ALTER TABLE "promotion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "promotion"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- No DELETE. "A promotion that has ever been used cannot be deleted or edited,
-- only switched off" (FR-PRO-01) — an invoice from March has to keep explaining
-- itself in September. `is_active` is how it stops working. The REVOKE is what
-- makes that true: bootstrap.sql's ALTER DEFAULT PRIVILEGES grants all four on
-- every new table, so a narrower GRANT alone would be decorative.
GRANT SELECT, INSERT, UPDATE ON "promotion" TO healthcloud_app;
REVOKE DELETE ON "promotion" FROM healthcloud_app;

ALTER TABLE "promotion_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_application" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "promotion_application"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- Append-only, exactly like `payment`. This is the row that answers "who gave
-- this money away, and on whose instruction"; one that can be edited or removed
-- answers nothing. FR-PRO-02: "Applying one is recorded permanently."
GRANT SELECT, INSERT ON "promotion_application" TO healthcloud_app;
REVOKE UPDATE, DELETE ON "promotion_application" FROM healthcloud_app;

-- =============================================================================
-- INTEGRITY
--
-- Every rule below is one FR-PRO-01 states in words. They are constraints
-- rather than service-layer checks because a discount is money leaving the
-- clinic, and the service layer is one bug away from being wrong about it.
-- =============================================================================

-- A percentage is 1–100. 100 is allowed on purpose: the "don't charge this
-- patient" case is the reason the feature exists. A flat amount is in paise and
-- capped at one crore, matching MAX_PAISE in the billing DTOs — a typo of a few
-- extra zeroes is refused at the door rather than corrected in the ledger.
ALTER TABLE "promotion" ADD CONSTRAINT promotion_value_within_bounds CHECK (
  ("type" = 'PERCENTAGE' AND "value" BETWEEN 1 AND 100)
  OR
  ("type" = 'FLAT' AND "value" BETWEEN 1 AND 100000000)
);

-- An uncapped promotion is NULL, not zero. A cap of zero would silently make
-- every discount nothing, which is worse than refusing it.
ALTER TABLE "promotion" ADD CONSTRAINT promotion_cap_positive CHECK (
  "max_discount_paise" IS NULL OR "max_discount_paise" BETWEEN 1 AND 100000000
);

-- A camp offer stops working when the camp ends, and cannot end before it began.
ALTER TABLE "promotion" ADD CONSTRAINT promotion_dates_ordered CHECK (
  "valid_to" IS NULL OR "valid_from" <= "valid_to"
);

-- The clinic does not owe money because a promo was too big. A flat discount
-- larger than the bill reduces it to zero and never below — the upper half of
-- that rule is enforced against the invoice at apply time; this is the lower
-- half, and it holds whatever the service layer computes.
ALTER TABLE "promotion_application" ADD CONSTRAINT promotion_application_discount_non_negative CHECK (
  "discount_paise" >= 0 AND "discount_paise" <= 100000000
);

COMMENT ON TABLE "promotion" IS
  'Discounts an administrator defined in advance. Switched off, never deleted (FR-PRO-01).';
COMMENT ON TABLE "promotion_application" IS
  'A promotion applied to an invoice. Append-only; authorised_by is mandatory (FR-PRO-02).';
