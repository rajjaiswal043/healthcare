-- =============================================================================
-- A TEST NOBODY PRESCRIBED
--
-- FR-DIA-10. Every diagnostic order in this schema exists because a doctor
-- asked for it during a consultation: the order hangs off an appointment, and
-- the column says NOT NULL. The clinics want the other case — somebody walks in
-- off the street wanting a chest X-ray, pays, has it done, and takes the report
-- away. No consultation, no prescription, no doctor anywhere in it.
--
-- Two columns change meaning here, and they are NOT the same column:
--
--   `ordered_by_user_id` stays NOT NULL. It is the STAFF USER who keyed the
--   order in — the finance person at the desk for a walk-in, the doctor in the
--   room otherwise. There is always one, and losing that would gut the audit
--   trail for the sake of a requirement that never asked for it.
--
--   `referral_source` is the new, CLINICAL question: who decided this test was
--   needed. Our own doctor, a doctor at another hospital, or the patient.
--   Stored rather than inferred from a null appointment, because inferring it
--   works right up until a fourth case appears, and FR-DIA-15 needs to report
--   on the distinction rather than deduce it.
-- =============================================================================

CREATE TYPE "diagnostic_referral_source" AS ENUM ('INTERNAL', 'EXTERNAL_DOCTOR', 'SELF');

-- DEFAULT 'INTERNAL' stamps every row that already exists: all of them came out
-- of a consultation, which is exactly what INTERNAL means. No data migration,
-- and the CHECK below therefore passes on historical rows without a backfill.
ALTER TABLE "diagnostic_order"
  ADD COLUMN "referral_source" "diagnostic_referral_source" NOT NULL DEFAULT 'INTERNAL';

-- Free text, on purpose (FR-DIA-14). A managed list of external referrers is
-- the obvious next step and should not be built until somebody asks for it.
ALTER TABLE "diagnostic_order" ADD COLUMN "referrer_name"   VARCHAR(160);
ALTER TABLE "diagnostic_order" ADD COLUMN "referrer_clinic" VARCHAR(160);
ALTER TABLE "diagnostic_order" ADD COLUMN "referrer_phone"  VARCHAR(32);

ALTER TABLE "diagnostic_order" ALTER COLUMN "appointment_id" DROP NOT NULL;


-- =============================================================================
-- THE GUARANTEE THAT REPLACES THE NOT NULL
--
-- Dropping NOT NULL loses a real invariant: until now an order could not exist
-- without a visit, and nothing had to check. Rather than let that become "any
-- order may or may not have a visit, good luck", the invariant moves here and
-- gets stronger — it now says which KIND of order has one.
--
-- Biconditional, deliberately. `INTERNAL → appointment` alone would still admit
-- a SELF-referred order attached to a consultation, which contradicts itself:
-- the patient cannot have walked in off the street into a visit our own doctor
-- is conducting. Either both are true or neither is.
-- =============================================================================

ALTER TABLE "diagnostic_order" ADD CONSTRAINT "diagnostic_order_referral_matches_visit" CHECK (
  ("appointment_id" IS NOT NULL) = ("referral_source" = 'INTERNAL')
);

-- An outside doctor with no name is not a referral, it is a blank on a form —
-- and FR-DIA-14 wants that name printed on the report and counted in a report
-- of who sends the most work.
ALTER TABLE "diagnostic_order" ADD CONSTRAINT "diagnostic_order_external_referrer_named" CHECK (
  "referral_source" <> 'EXTERNAL_DOCTOR'
  OR ("referrer_name" IS NOT NULL AND length(btrim("referrer_name")) > 0)
);

-- FR-DIA-15 reports revenue by referral source, and the worklist filters by
-- department and status — neither wants a sequential scan once a busy centre
-- has a year of orders.
CREATE INDEX "diagnostic_order_referral_idx"
  ON "diagnostic_order"("tenant_id", "referral_source", "created_at");

-- A walk-in order has no visit to scope the duplicate guard to, so it is scoped
-- to the patient and the day instead. This is the index that lookup reads.
CREATE INDEX "diagnostic_order_patient_day_idx"
  ON "diagnostic_order"("tenant_id", "patient_id", "created_at");

COMMENT ON COLUMN "diagnostic_order"."referral_source" IS
  'Who decided the test was needed: our own doctor, an outside doctor, or the patient. Distinct from ordered_by_user_id, which is the staff member who keyed it in.';
COMMENT ON COLUMN "diagnostic_order"."appointment_id" IS
  'The consultation this came out of. Null for a walk-in — see the referral_source CHECK.';

-- No RLS work: `diagnostic_order` already carries tenant_id and its policy.
