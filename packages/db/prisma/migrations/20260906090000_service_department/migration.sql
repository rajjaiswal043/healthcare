-- =============================================================================
-- A SERVICE CAN BELONG TO A DEPARTMENT
--
-- FR-PRC-01: the price list shows which department performs each thing, so an
-- administrator pricing forty items can read them in the groups the clinic
-- actually works in.
--
-- Nullable, deliberately. An X-ray belongs to radiology; a consultation belongs
-- to whichever doctor gave it, and a dressing may belong to nobody. A NOT NULL
-- column would make the administrator invent a department for those, and an
-- invented department is worse than an absent one — it becomes a fact in every
-- report afterwards.
--
-- No RLS work here: `service` already carries tenant_id and its policy from
-- 20260807193636_billing. Adding a column to a protected table does not need a
-- new policy, and `pnpm rls:check` re-verifies the table either way.
-- =============================================================================

-- AlterTable
ALTER TABLE "service" ADD COLUMN "department_id" UUID;

-- AddForeignKey
--
-- RESTRICT rather than SET NULL: a department with services priced against it
-- should not be removable without somebody looking at those prices first. It
-- matches how `practitioner.department_id` already behaves.
ALTER TABLE "service" ADD CONSTRAINT "service_department_fkey"
  FOREIGN KEY ("department_id") REFERENCES "department"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "service_department_idx" ON "service"("tenant_id", "department_id");

COMMENT ON COLUMN "service"."department_id" IS
  'Which department performs this, where that applies. Null for anything department-less.';
