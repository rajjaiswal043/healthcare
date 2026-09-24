-- =============================================================================
-- TOKENS AT BOOKING — and a queue that no longer sorts by them
--
-- See docs/05-token-queue-plan.md, phase A.
--
-- Until now `token_number` did two jobs: it identified the visit AND it ordered
-- the queue. That worked only because the token was issued at check-in, which
-- made token order and arrival order the same thing by construction.
--
-- Narveer asked for the token at BOOKING, so the two come apart: someone who
-- books next Tuesday's first slot holds token 1 and may arrive at noon. From
-- here:
--
--   token_number  — identity. Allocated at booking, printed on the slip, called
--                   out, shown on the waiting-room display. Never changes.
--   ready_at      — position. Stamped when the patient actually becomes ready to
--                   be seen (check-in, and later a return from investigations).
--
-- Ordering is (flagged first, by when they were flagged) then ready_at, then
-- token as a deterministic tie-break. The flag columns are added here rather
-- than in phase B so the queue change is one migration against live appointment
-- data instead of two.
-- =============================================================================

-- CreateEnum
--
-- Why a code and not free text: the reason a patient jumps the queue is read by
-- someone deciding whether the jump was legitimate. Free text produces "urgent",
-- "urgent!!", "dr said" and nothing countable. The set is small on purpose —
-- if a clinic needs a sixth, that is a conversation, not a typing decision.
CREATE TYPE "queue_priority_reason" AS ENUM (
  'BACK_FROM_TESTS',
  'EMERGENCY',
  'FRAIL_OR_DISTRESSED',
  'DOCTOR_REQUESTED',
  'CLINIC_ERROR'
);

-- AlterTable
ALTER TABLE "appointment"
  ADD COLUMN "ready_at"                TIMESTAMPTZ(6),
  ADD COLUMN "priority_reason_code"    "queue_priority_reason",
  ADD COLUMN "priority_note"           VARCHAR(200),
  ADD COLUMN "priority_set_at"         TIMESTAMPTZ(6),
  ADD COLUMN "priority_set_by_user_id" UUID;

COMMENT ON COLUMN "appointment"."token_number" IS
  'Identity, not position. Allocated at booking or walk-in registration; unique per practitioner per queue_date.';

COMMENT ON COLUMN "appointment"."ready_at" IS
  'When the patient became ready to be seen. Stamped at check-in and re-stamped on return from investigations. The queue sorts on this, not on the token.';

COMMENT ON COLUMN "appointment"."priority_set_at" IS
  'When this visit was flagged to be seen next. Orders flagged patients among themselves: first flagged, first served.';

-- -----------------------------------------------------------------------------
-- A flag is a decision somebody made, so it carries who and when.
--
-- All-or-nothing rather than three independently nullable columns: a priority
-- with no author is exactly the row nobody can account for later, and the whole
-- point of recording the jump is that it can be accounted for. The note is
-- optional — the code is what is countable.
-- -----------------------------------------------------------------------------
ALTER TABLE "appointment" ADD CONSTRAINT appointment_priority_is_attributed CHECK (
  (priority_reason_code IS NULL
   AND priority_set_at IS NULL
   AND priority_set_by_user_id IS NULL
   AND priority_note IS NULL)
  OR
  (priority_reason_code IS NOT NULL
   AND priority_set_at IS NOT NULL
   AND priority_set_by_user_id IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- A token belongs to a clinic day.
--
-- Uniqueness is (tenant, practitioner, queue_date, token_number), and NULL is
-- distinct from everything in a unique index — so a token with no queue_date
-- would be unconstrained and could be handed out twice. Cheap constraint,
-- expensive omission.
-- -----------------------------------------------------------------------------
ALTER TABLE "appointment" ADD CONSTRAINT appointment_token_has_queue_date CHECK (
  token_number IS NULL OR queue_date IS NOT NULL
);

-- CreateIndex
CREATE INDEX "appointment_queue_order_idx"
  ON "appointment"("tenant_id", "practitioner_id", "queue_date", "priority_set_at", "ready_at");

-- =============================================================================
-- BACKFILL
--
-- Every appointment already booked was created under the old rule and has no
-- token. Leaving them NULL would mean a clinic's existing diary is invisible on
-- the new board, and the front desk would find out one patient at a time.
--
-- Two things make this fiddly, and both are the reason it is a loop rather than
-- one statement:
--
--   1. `appointment` is under FORCE row-level security, which applies to the
--      table owner too. A cross-tenant UPDATE here would match zero rows and
--      report success — silently doing nothing. So each tenant's rows are
--      updated inside that tenant's context, exactly as the seeds do it.
--   2. The clinic day is local. `(start_at AT TIME ZONE tenant.timezone)::date`
--      is the day the token belongs to; using the UTC date would put every
--      evening appointment in Kolkata on tomorrow's board.
--
-- Numbering continues from any token already issued for that doctor and day, so
-- a half-finished clinic day survives the migration.
-- =============================================================================

DO $$
DECLARE
  v_tenant record;
BEGIN
  FOR v_tenant IN SELECT id, timezone FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    -- Anyone already in a queue became ready when they checked in.
    UPDATE appointment
       SET ready_at = checked_in_at
     WHERE checked_in_at IS NOT NULL
       AND ready_at IS NULL;

    -- Tokens for visits booked under the old rule.
    WITH target AS (
      SELECT id,
             practitioner_id,
             start_at,
             (start_at AT TIME ZONE v_tenant.timezone)::date AS qdate
        FROM appointment
       WHERE token_number IS NULL
         AND status = 'BOOKED'
    ),
    existing AS (
      SELECT practitioner_id, queue_date, max(token_number) AS max_token
        FROM appointment
       WHERE token_number IS NOT NULL
       GROUP BY practitioner_id, queue_date
    ),
    numbered AS (
      SELECT tg.id,
             tg.qdate,
             COALESCE(e.max_token, 0)
               + row_number() OVER (PARTITION BY tg.practitioner_id, tg.qdate
                                        ORDER BY tg.start_at, tg.id) AS token
        FROM target tg
        LEFT JOIN existing e
          ON e.practitioner_id = tg.practitioner_id
         AND e.queue_date      = tg.qdate
    )
    UPDATE appointment a
       SET token_number = n.token,
           queue_date   = n.qdate
      FROM numbered n
     WHERE a.id = n.id;

    -- The counter has to know what was just handed out, or the next live
    -- booking is issued a token that already exists and the INSERT fails on the
    -- unique index.
    INSERT INTO queue_counter (tenant_id, practitioner_id, queue_date, last_token)
    SELECT v_tenant.id, practitioner_id, queue_date, max(token_number)
      FROM appointment
     WHERE token_number IS NOT NULL
       AND queue_date IS NOT NULL
     GROUP BY practitioner_id, queue_date
    ON CONFLICT (tenant_id, practitioner_id, queue_date)
      DO UPDATE SET last_token = GREATEST(queue_counter.last_token, EXCLUDED.last_token);
  END LOOP;
END $$;
