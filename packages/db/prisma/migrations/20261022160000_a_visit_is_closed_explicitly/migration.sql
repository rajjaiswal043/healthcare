-- =============================================================================
-- A VISIT IS CLOSED EXPLICITLY
--
-- `FULFILLED` says the DOCTOR has finished. It does not say the visit is over:
-- the patient may still be waiting for a film to come back, for a bill to be
-- settled, or simply to be sent on their way. Those are different facts and the
-- board was showing them as one, so "Done" meant both "the clinician is
-- finished" and "this person has left" — and the second is the one the front
-- desk needs at four in the afternoon.
--
-- RECORDED RATHER THAN DERIVED, which was Narveer's call on 22 Oct 2026. It
-- could have been computed — fulfilled, nothing pending — and that would have
-- needed no column and no button. He chose the press, so the clinic has a
-- person and a time against every closed visit rather than an inference. The
-- cost is visits left open by somebody who forgot, which is what the "Ready to
-- close" queue on the board exists to make visible.
--
-- WHO, as well as when. A visit closed with money still owed is allowed —
-- deliberately; the desk is the one standing in front of the patient — so the
-- trail has to be able to answer who decided that.
-- =============================================================================

ALTER TABLE "appointment"
  ADD COLUMN "closed_at" TIMESTAMPTZ(6),
  ADD COLUMN "closed_by_user_id" UUID;

-- No foreign key, matching `cancelled_by_user_id` and `priority_set_by_user_id`
-- on this same table. Those columns record WHO DID SOMETHING at a moment in
-- time; the fact survives the account being removed, and a cascade or a
-- SET NULL would quietly rewrite history to say nobody did it.

-- -----------------------------------------------------------------------------
-- EVERYTHING BEFORE TODAY IS ALREADY OVER.
--
-- Without this, the day the feature ships every visit the clinic has ever
-- finished lands in "Ready to close" at once — a queue of hundreds that nobody
-- will work through and everybody will learn to ignore. Those patients went
-- home weeks ago.
--
-- `closed_by_user_id` is deliberately left NULL: nobody pressed anything, and
-- naming whoever happens to run the migration would be inventing a fact. A null
-- closer reads as "closed by the system when this was introduced", which is
-- exactly what happened.
--
-- The cut is the appointment's own start, before the start of today in UTC.
-- Today's finished visits are genuinely still open and must stay in the queue —
-- a clinic mid-afternoon on deployment day still has people in the building.
-- UTC rather than the clinic's timezone because this runs once, per database,
-- against rows whose exact boundary hour does not matter: the worst case is
-- that a visit finished in the small hours of this morning needs closing by
-- hand, which is a real visit somebody is still responsible for anyway.
-- -----------------------------------------------------------------------------
UPDATE "appointment"
   SET "closed_at" = COALESCE("updated_at", "start_at")
 WHERE "status" = 'FULFILLED'
   AND "closed_at" IS NULL
   AND "start_at" < date_trunc('day', now());

-- Answers "what is still open", which the board asks on every load.
CREATE INDEX "appointment_open_idx"
  ON "appointment" ("tenant_id", "closed_at")
  WHERE "closed_at" IS NULL;
