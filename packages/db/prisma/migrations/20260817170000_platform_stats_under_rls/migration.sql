-- =============================================================================
-- Fix: platform_clinic_stats() counted zero of everything.
--
-- WHY IT FAILED
--
-- Same trap as the token backfill, and as auth_lookup_user before it. The
-- function was SECURITY DEFINER on the assumption that running as the table
-- owner would let it read `patient` and `app_user` across tenants. It does not:
-- both are declared FORCE ROW LEVEL SECURITY, and FORCE means the policies apply
-- to the OWNER as well. So it ran as owner with current_tenant_id() = NULL,
-- matched nothing, and reported every clinic as empty.
--
-- This is the isolation working exactly as designed. The fix is not to punch
-- through it.
--
-- THE FIX
--
-- Walk the tenants, establish context for each one in turn, and count INSIDE the
-- policy — the same shape as auth_lookup_user. No BYPASSRLS role, no NO FORCE,
-- no superuser. The function still cannot return anything but integers, and now
-- it reads them one tenant at a time, through the policy rather than around it.
--
-- set_config(..., is_local => true) scopes each setting to this transaction, so
-- nothing leaks onto a pooled connection afterwards.
-- =============================================================================

CREATE OR REPLACE FUNCTION platform_clinic_stats()
RETURNS TABLE (
  tenant_id     uuid,
  active_users  bigint,
  patient_count bigint,
  last_sign_in  timestamptz
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_tenant record;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    tenant_id := v_tenant.id;

    SELECT count(*) INTO active_users FROM app_user u WHERE u.is_active;
    SELECT count(*) INTO patient_count FROM patient;
    SELECT max(u.last_login_at) INTO last_sign_in FROM app_user u;

    RETURN NEXT;
  END LOOP;

  -- Leave no tenant context behind for whatever runs next on this connection.
  PERFORM set_config('app.tenant_id', '', true);
END;
$$;

COMMENT ON FUNCTION platform_clinic_stats() IS
  'Per-clinic counts for the platform console. Reads each tenant inside its own RLS context and returns integers only — never a patient, user or clinical row.';

GRANT EXECUTE ON FUNCTION platform_clinic_stats() TO healthcloud_app;
