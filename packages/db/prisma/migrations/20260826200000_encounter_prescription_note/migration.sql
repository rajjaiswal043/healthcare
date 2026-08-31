-- =============================================================================
-- A NOTE ON THE PRESCRIPTION
--
-- FR-CON-11, from the orthopaedic clinic demo on 26 Aug 2026. The consultation
-- already has `advice` — "Rest, diet, warning signs" — which prints on the
-- prescription. This is a SECOND printed block for the things that are not
-- advice to the patient: physiotherapy instructions, precautions, a line to the
-- pharmacy, a referral note.
--
-- Two fields rather than one because they are addressed to different readers.
-- Merging them would have been cheaper today and wrong by the second week: a
-- doctor who writes "no squatting for 6 weeks" and "rest and ice" in one box
-- cannot later have either of them treated differently.
--
-- Part of the signed record, so it inherits the immutability in FR-CON-09
-- without needing anything here: `loadDraft` refuses to load a signed encounter
-- for update, and a correction is an addendum.
-- =============================================================================

ALTER TABLE "encounter" ADD COLUMN "prescription_note" text;

-- Bounded in the database as well as in the DTO. 1000 characters is about a
-- dozen printed lines — a paragraph or a short list, and short enough that the
-- prescription stays on one sheet, which is what clinics actually care about.
-- The CHECK is here so the limit survives a future caller that skips validation.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_prescription_note_is_bounded" CHECK (
    "prescription_note" IS NULL OR length("prescription_note") <= 1000
  );

COMMENT ON COLUMN "encounter"."prescription_note" IS
  'FR-CON-11. Prints on the prescription under its own heading, below Advice. Patient-facing.';
