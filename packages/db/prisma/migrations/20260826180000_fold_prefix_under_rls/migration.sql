-- =============================================================================
-- THE FOLD, AGAIN — THIS TIME INSIDE THE POLICY
--
-- 20260826170000_fold_practitioner_prefix was supposed to move "Dr" out of
-- `practitioner.prefix` and into `full_name`. It ran, it reported success, and
-- it changed nothing: `practitioner` carries FORCE ROW LEVEL SECURITY, **and
-- FORCE RLS applies to the table's OWNER as well** — which is who a migration
-- runs as. With no `app.tenant_id` set, the UPDATE matched zero rows in every
-- tenant and said so by saying nothing.
--
-- This is the fourth time this exact trap has been sprung in this codebase:
-- auth_lookup_user, the token backfill, platform_clinic_stats, and now this.
-- The shape of the fix is always identical — walk the tenants, set the context,
-- write inside the policy — and it is recorded in docs/03-resume-here.md under
-- "A SECURITY DEFINER function still gets row-level security applied to it".
--
-- The rule to take from it: **a migration that touches a tenant table and does
-- not mention `set_config` is almost certainly a no-op.** If it appears to
-- succeed, check the row count before believing it.
-- =============================================================================

DO $$
DECLARE
  v_tenant  record;
  v_folded  integer;
  v_total   integer := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    -- Only where the name does not already begin with the honorific, so a row
    -- entered as "Dr. Vivek Swarnkar" WITH prefix='Dr' ends up with one rather
    -- than two. The trailing full stop is stripped for the comparison, since
    -- "Dr" and "Dr." are the same honorific typed by two different people.
    UPDATE practitioner
       SET full_name = btrim(prefix) || ' ' || full_name
     WHERE prefix IS NOT NULL
       AND btrim(prefix) <> ''
       AND lower(full_name) NOT LIKE lower(rtrim(btrim(prefix), '.')) || '%';

    GET DIAGNOSTICS v_folded = ROW_COUNT;
    v_total := v_total + v_folded;

    UPDATE practitioner SET prefix = NULL WHERE prefix IS NOT NULL;
  END LOOP;

  -- Said out loud, because the previous attempt's silence is the whole reason
  -- this file exists.
  RAISE NOTICE 'Folded the honorific into % practitioner name(s).', v_total;
END $$;
