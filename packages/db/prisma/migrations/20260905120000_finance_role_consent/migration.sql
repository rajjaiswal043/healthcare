-- =============================================================================
-- FINANCE LOSES THE CONSENT PERMISSIONS
--
-- `finance` shipped with `consent:read` and `consent:write` on the reasoning
-- that registering a patient captures DPDP consent. It does — but inside the
-- registration transaction, behind `patient:write`. No endpoint in this API
-- checks either consent permission, so holding them gave the finance desk
-- nothing at all today, while pre-granting it whatever a standalone
-- consent-management endpoint might check tomorrow. That grant would then have
-- happened with nobody reviewing it, at the moment somebody else wrote an
-- unrelated route.
--
-- 20260905093000 only INSERTS the role (WHERE NOT EXISTS), so clinics that
-- already have it keep the eleven permissions it was created with. This strips
-- the two, and is idempotent: array_remove on an array that does not contain the
-- element is a no-op, and the WHERE clause means such a row is not touched at
-- all.
--
-- AND ONCE MORE: THE set_config LOOP IS LOAD-BEARING. `role` is under FORCE row
-- level security, which applies to the owner a migration runs as. Without the
-- loop this UPDATE matches zero rows and reports success.
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
       SET permissions = array_remove(array_remove(permissions, 'consent:read'), 'consent:write'),
           updated_at  = now()
     WHERE key = 'finance'
       AND ('consent:read' = ANY (permissions) OR 'consent:write' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;
  END LOOP;

  RAISE NOTICE 'Stripped the consent permissions from % finance role(s).', v_total;
END $$;
