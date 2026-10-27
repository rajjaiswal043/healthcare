-- =============================================================================
-- A VITALS READING CAN BE CORRECTED
--
-- Vitals were strictly append-only, and the panel said so: "each save is a new
-- observation, not an edit of the last". That is the right instinct for an
-- observation and the wrong answer for a typo. A nurse who enters a diastolic
-- of 180 instead of 80 — well inside the accepted 20–200, so nothing refuses
-- it — had a wrong reading on that visit for ever. Recording a fresh set
-- changed what the screen showed, because only the newest is displayed, but the
-- wrong number stayed in the record, in the "N sets recorded" count, and in any
-- chart of this patient over time. Reported by the testing team, 27 Oct 2026.
--
-- A SUPERSEDING ROW, NOT AN EDIT, which is the same shape as a payment
-- correction in this system: nothing is overwritten, the original stays
-- readable, and a second row says what the value should have been and who said
-- so. An UPDATE in place would have been three lines of code and would have
-- destroyed the evidence that the first reading was ever taken — which is
-- exactly what somebody asks about when a chart looks wrong.
-- =============================================================================

ALTER TABLE "vitals_observation"
  ADD COLUMN "corrects_id" UUID;

-- -----------------------------------------------------------------------------
-- ONE CORRECTION PER READING.
--
-- A correction can itself be corrected — the chain is as long as the mistakes —
-- but two rows must never both claim to replace the same reading, because then
-- "what does this observation actually say" has two answers and the screen
-- picks one arbitrarily.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "vitals_observation_corrects_id_key"
  ON "vitals_observation" ("corrects_id");

-- CASCADE, unlike the who-did-what columns elsewhere in this schema. Those
-- record a person and survive the account going away; this records a row, and a
-- correction of a reading that no longer exists is not a fact about anything.
-- In practice nothing deletes a vitals row except the encounter cascading, and
-- then both go together.
ALTER TABLE "vitals_observation"
  ADD CONSTRAINT "vitals_observation_corrects_id_fkey"
  FOREIGN KEY ("corrects_id") REFERENCES "vitals_observation" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- No backfill, and nothing to backfill: every reading that exists today is an
-- original, which is what a NULL here means.
