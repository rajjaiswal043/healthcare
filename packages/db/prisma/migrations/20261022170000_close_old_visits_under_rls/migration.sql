-- =============================================================================
-- CLOSE THE VISITS THE LAST MIGRATION MEANT TO CLOSE
--
-- `20261022160000_a_visit_is_closed_explicitly` added `closed_at` and tried to
-- backfill every visit from before today in one statement. It matched ZERO ROWS
-- and reported success, so a clinic with weeks of finished visits woke up with
-- all of them in the "Ready to close" queue — the exact failure the backfill
-- was written to prevent.
--
-- WHY IT DID NOTHING. `appointment` is under FORCE row-level security, which
-- applies to the table OWNER as well — and a migration runs as the owner. With
-- no `app.tenant_id` set, the policy matches nothing, the UPDATE touches
-- nothing, and PostgreSQL says it worked. This is written down in
-- `20260812061500_queue_tokens_at_booking`, which hit the same wall and solved
-- it the same way; the rule is that any data migration over a tenant table is a
-- loop with the tenant's context set inside it, exactly as the seeds do.
--
-- A SEPARATE MIGRATION rather than a correction to that one, because that one
-- has already run in dev and may have run elsewhere. An applied migration is
-- history; this is the next thing that happened.
--
-- IDEMPOTENT. `closed_at IS NULL` means visits closed by hand between the two
-- migrations keep the person who closed them, and running this twice changes
-- nothing the second time.
-- =============================================================================

DO $$
DECLARE
  v_tenant record;
BEGIN
  FOR v_tenant IN SELECT id, timezone FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    /*
     * THE CLINIC'S OWN YESTERDAY, not the server's.
     *
     * `(start_at AT TIME ZONE timezone)::date` is the day the visit belongs
     * to. Comparing against a UTC midnight would close this morning's finished
     * visits in Kolkata — people who may still be in the building — and leave
     * last night's open.
     *
     * `closed_by_user_id` is deliberately left NULL: nobody pressed anything.
     * A null closer against a non-null time reads as "closed when this was
     * introduced", which is exactly what happened; naming whoever ran the
     * migration would be inventing a fact.
     */
    UPDATE appointment
       SET closed_at = COALESCE(completed_at, updated_at, start_at)
     WHERE status = 'FULFILLED'
       AND closed_at IS NULL
       AND (start_at AT TIME ZONE v_tenant.timezone)::date
           < (now() AT TIME ZONE v_tenant.timezone)::date;
  END LOOP;
END $$;
