-- =============================================================================
-- WHO MAY RAISE A WALK-IN TEST
--
-- `diagnostic:order:walkin` was added to SYSTEM_ROLES, so clinics onboarded
-- from now on get it. Clinics that already exist do not — their `role` rows
-- were written when they were created and nothing rewrites them. Without this
-- the finance desk would open the new screen and be refused by a guard, with
-- nothing to explain why.
--
-- Finance and the administrator, and deliberately NOT the front desk
-- (decision 1, 11 Sep 2026). The flow the clinics described has finance price
-- the test and the front desk request it, which is the same information typed
-- twice by two people with a patient in front of each — and the second entry
-- can silently disagree with the first. Paid for a chest X-ray, requested a
-- knee. Finance does both, and the front desk gains no new power.
--
-- Note it is NOT `diagnostic:order`. That one is clinical: the doctor in the
-- room deciding a patient needs a scan, on any consultation. Granting it here
-- would have let the finance desk order tests on anybody's visit.
--
-- AND AGAIN: THE set_config LOOP IS LOAD-BEARING. `role` is under FORCE ROW
-- LEVEL SECURITY, FORCE applies to the owner, and a migration runs as the
-- owner. A plain UPDATE matches nothing and reports success.
-- =============================================================================

DO $$
DECLARE
  v_tenant  record;
  v_changed integer;
  v_total   integer := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    UPDATE role
       SET permissions = array_append(permissions, 'diagnostic:order:walkin'),
           updated_at  = now()
     WHERE key IN ('finance', 'administrator')
       AND NOT ('diagnostic:order:walkin' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;

    IF v_changed > 0 THEN
      RAISE NOTICE 'tenant %: % role(s) may now raise a walk-in test', v_tenant.id, v_changed;
    END IF;
  END LOOP;

  RAISE NOTICE 'walk-in order permission: % role(s) in total', v_total;
END $$;
