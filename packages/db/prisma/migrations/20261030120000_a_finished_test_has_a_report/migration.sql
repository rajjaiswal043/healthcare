-- =============================================================================
-- A FINISHED TEST HAS A REPORT, OR SAYS WHY IT HAS NOT
--
-- `completeOrder` refused a result that was completely empty — no note and no
-- file — and accepted anything beyond that. So a test could be marked done
-- with a line of remarks and no report attached, which is what the department
-- was reported doing on 30 Oct 2026: a patient's X-ray reads COMPLETED and
-- there is no image behind it.
--
-- A note is not a report. It is the radiographer's remark ABOUT the report, and
-- a record that claims work was finished while holding nothing a clinician can
-- read is worse than one that admits the work is outstanding.
--
-- BUT NOT EVERY TEST PRODUCES A FILE. A strip test read off a card, a reading
-- taken verbally from another department, a measurement written on a slip —
-- these are real, and requiring an upload for them would leave the desk unable
-- to close a test it had genuinely done. Narveer's call, 30 Oct 2026: require a
-- file, OR require somebody to say why there is not one.
--
-- SAID, AND STORED. The reason goes in a column of its own rather than into
-- `result_note`, because the two answer different questions — one is the
-- clinical remark, the other is why this record is thin — and merging them
-- would make "which finished tests have no report, and why" unanswerable the
-- moment anybody needed to ask it.
--
-- Nullable, with no backfill. Every order already COMPLETED was completed under
-- the old rule, and inventing a reason for it would be writing a fact nobody
-- stated. Null here means "finished before this rule existed", which is the
-- truth.
-- =============================================================================

ALTER TABLE "diagnostic_order"
  ADD COLUMN "no_file_reason" VARCHAR(300);

-- A reason is only meaningful on a finished test, and only when it says
-- something. Blank-but-present is the shape that would let the rule be
-- satisfied without answering it.
ALTER TABLE "diagnostic_order"
  ADD CONSTRAINT diagnostic_order_no_file_reason_is_said CHECK (
    "no_file_reason" IS NULL
    OR (length(btrim("no_file_reason")) >= 3 AND "status" = 'COMPLETED')
  );
