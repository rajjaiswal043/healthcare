-- =============================================================================
-- ALLERGIES
--
-- The one clinically urgent fact a patient record did not hold. Asked for on
-- 7 Oct 2026 as part of the Patient 360 view, where it is the first thing in
-- the highlights panel — a doctor about to prescribe needs it before anything
-- else on the screen.
--
-- TWO COLUMNS, AND THE SECOND ONE IS THE POINT.
--
-- A blank allergy field means one of two completely different things:
--
--   nobody has asked this patient yet          -> ask before prescribing
--   somebody asked and the answer was none     -> safe, on the record
--
-- A single nullable text column cannot tell those apart, and the failure is
-- one-directional: an unasked patient reads as "no allergies" and a doctor
-- prescribes on it. `allergies_reviewed_at` is what separates them. It is set
-- whenever a human saves the field, INCLUDING when they save it empty, because
-- "I asked, there are none" is a clinical finding and not an absence of data.
--
--   reviewed_at IS NULL                        -> "Not recorded" (prompt)
--   reviewed_at set, allergies NULL            -> "No known allergies"
--   allergies present                          -> show them, loudly
--
-- WHY FREE TEXT and not a coded allergen table. A coded list is the right
-- answer for interaction checking, which this system does not do and is not
-- close to doing. Until a prescription can be checked against an allergen, a
-- structured table buys a dropdown that is always missing the entry the patient
-- actually reacted to, and clinicians write "see notes". Free text is what gets
-- read by the person it is meant for. Revisit when prescribing gets a safety
-- check, which is the point a code becomes worth more than a sentence.
--
-- `patient` already carries FORCE ROW LEVEL SECURITY and its tenant policy, so
-- new columns on it inherit both. Nothing to add here, and nothing to grant:
-- bootstrap.sql's ALTER DEFAULT PRIVILEGES covers the table, not its columns.
-- =============================================================================

ALTER TABLE "patient"
  ADD COLUMN "allergies" VARCHAR(500),
  ADD COLUMN "allergies_reviewed_at" TIMESTAMPTZ(6);

COMMENT ON COLUMN "patient"."allergies" IS
  'Known allergies, free text, as told by the patient. NULL with allergies_reviewed_at set means "no known allergies"; NULL with it unset means nobody has asked.';

COMMENT ON COLUMN "patient"."allergies_reviewed_at" IS
  'When a human last confirmed this patient''s allergies, including confirming there are none. NULL means never asked.';

-- -----------------------------------------------------------------------------
-- Existing patients.
--
-- Every row keeps both columns NULL, which reads as "not recorded" — and that
-- is the honest answer. Nobody has asked these patients, and backfilling
-- reviewed_at to make the screen look tidy would convert "unknown" into "no
-- known allergies" for every patient already registered, which is precisely the
-- confusion the second column exists to prevent.
--
-- No UPDATE here on purpose, so no per-tenant set_config loop either. Noted
-- because a data migration on a FORCE RLS table that silently matches zero rows
-- has bitten this project four times, and the absence of one should look
-- deliberate rather than forgotten. See docs/03-resume-here.md.
-- -----------------------------------------------------------------------------
