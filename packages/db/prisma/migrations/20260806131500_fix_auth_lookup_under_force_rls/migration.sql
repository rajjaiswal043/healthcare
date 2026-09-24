-- Fix: auth_lookup_user returned no rows.
--
-- WHY IT FAILED
--
-- The function was SECURITY DEFINER, on the assumption that running as the
-- table owner would let it read app_user before tenant context exists. It does
-- not. `app_user` is declared FORCE ROW LEVEL SECURITY, and FORCE means the
-- policies apply to the table's OWNER as well. So the function ran as owner,
-- hit the tenant_isolation policy with current_tenant_id() = NULL, and matched
-- zero rows — every login failed with "invalid credentials".
--
-- This is the RLS design working exactly as intended. The fix is not to punch a
-- hole through it.
--
-- THE FIX
--
-- The slug identifies the tenant, and `tenant` is not itself tenant-scoped. So
-- the function resolves the tenant first, ESTABLISHES tenant context with
-- set_config(..., is_local => true), and only then reads app_user — inside the
-- policy rather than around it.
--
-- No BYPASSRLS role, no NO FORCE, no superuser. The one function that must run
-- before a session exists still cannot see across tenants: it sets context to
-- exactly one tenant, derived from the slug the caller supplied, and any user it
-- returns is by construction inside that tenant.
--
-- is_local => true scopes the setting to the current transaction, so it cannot
-- leak into a later query on a pooled connection.

CREATE OR REPLACE FUNCTION auth_lookup_user(p_tenant_slug varchar, p_email varchar)
RETURNS TABLE (
  user_id uuid,
  tenant_id uuid,
  password_hash varchar,
  is_active boolean,
  must_change_password boolean,
  mfa_secret varchar,
  mfa_enabled_at timestamptz,
  failed_login_count int,
  locked_until timestamptz,
  full_name varchar
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  SELECT t.id INTO v_tenant_id
    FROM tenant t
   WHERE t.slug = p_tenant_slug
     AND t.status = 'ACTIVE';

  -- Unknown or suspended tenant: return nothing. The caller reports the same
  -- "invalid credentials" it would for a wrong password, so this does not
  -- reveal which clinics exist.
  IF v_tenant_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.tenant_id', v_tenant_id::text, true);

  RETURN QUERY
  SELECT u.id, u.tenant_id, u.password_hash, u.is_active, u.must_change_password,
         u.mfa_secret, u.mfa_enabled_at, u.failed_login_count, u.locked_until,
         u.full_name
    FROM app_user u
   WHERE lower(u.email) = lower(p_email)
   LIMIT 1;
END;
$$;

COMMENT ON FUNCTION auth_lookup_user(varchar, varchar) IS
  'Credential lookup for login. Resolves the tenant from its slug, sets transaction-scoped tenant context, then reads within RLS. Does not bypass row-level security.';

GRANT EXECUTE ON FUNCTION auth_lookup_user(varchar, varchar) TO healthcloud_app;
