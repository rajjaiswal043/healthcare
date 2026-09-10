-- =============================================================================
-- A TEST THIS CLINIC DOES NOT DO
--
-- Phase 5 of the doctor-ordered diagnostics loop. Decision (b): when the doctor
-- picks "Other", they are saying the patient needs something this diagnostic
-- centre does not offer. That is not work for any department here, so it must
-- not become a DiagnosticOrder — it would sit on a worklist nobody can clear,
-- with a pay-first gate over a charge that will never exist.
--
-- It still has to be written down, for two people:
--
--   * the PATIENT, who takes it away on the printed slip and has it done
--     somewhere else, and
--   * the FINANCE DESK, so the person the patient speaks to next can say "that
--     one is not done here" before the patient has waited for it.
--
-- On `appointment` rather than `encounter`, and that placement is the decision:
--   * an encounter is immutable once signed, and this is administrative text
--     the desk may still need to correct afterwards;
--   * the finance role holds `appointment:read` and deliberately does NOT hold
--     `consultation:read`. On the encounter, the desk could not see it at all
--     without handing finance the clinical record — which is exactly the kind
--     of permission widening this project keeps refusing.
--
-- Nullable, and no backfill: an absent note means nothing was asked for, which
-- is true of every visit that has ever happened.
--
-- No RLS work: `appointment` already carries tenant_id and its policy.
-- =============================================================================

ALTER TABLE "appointment" ADD COLUMN "external_test_note" VARCHAR(1000);

COMMENT ON COLUMN "appointment"."external_test_note" IS
  'Tests the patient needs that this centre does not perform. Printed on the slip and shown to the finance desk; never an order, never a charge.';
