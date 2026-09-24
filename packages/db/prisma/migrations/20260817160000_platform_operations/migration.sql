-- =============================================================================
-- WHAT THE PLATFORM MAY DO, AS FOUR NAMED OPERATIONS
--
-- The platform tier needs to write rows the application role deliberately
-- cannot touch — create a clinic, change its status, set its seat limits — and
-- to count across every tenant at once, which row-level security exists to
-- prevent.
--
-- The obvious fix is to grant healthcloud_app INSERT and UPDATE on `tenant` and
-- widen the RLS story until the counts work. That would hand the CLINIC-facing
-- application those same powers, because it is the same role: a bug in a
-- consultation screen would be able to create a tenant.
--
-- So the platform's power is expressed as four SECURITY DEFINER functions
-- instead. Each does exactly one thing, takes exactly the arguments it needs,
-- and is the only way to do it. Same pattern as auth_lookup_user, next_uhid and
-- next_queue_token — all of which exist because a narrow function is a smaller
-- hole than a broad grant.
--
-- The one that matters most is platform_clinic_stats(). It returns COUNTS. Not
-- a row shape that happens to omit names today and might not tomorrow —
-- integers, by construction. A platform admin can know a clinic has 240
-- patients. There is no query here that could tell them who any of them are.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Create a clinic.
--
-- Returns the new id so the caller can populate the tenant's own tables through
-- ordinary RLS afterwards — roles, seat limits, a location, the first
-- administrator. Only the `tenant` row itself needs elevated rights.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_create_tenant(
  p_slug            varchar,
  p_name            varchar,
  p_timezone        varchar,
  p_uhid_prefix     varchar,
  p_contact_email   varchar,
  p_contact_mobile  varchar,
  p_onboarded_by    uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO tenant (slug, name, legal_name, timezone, uhid_prefix, uhid_padding,
                      contact_email, contact_mobile, onboarded_by_platform_user_id, updated_at)
       VALUES (p_slug, p_name, p_name, p_timezone, upper(p_uhid_prefix), 5,
               p_contact_email, p_contact_mobile, p_onboarded_by, now())
    RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION platform_create_tenant(varchar, varchar, varchar, varchar, varchar, varchar, uuid) IS
  'Creates a clinic. The only way the application role can write a tenant row.';

-- -----------------------------------------------------------------------------
-- Suspend a clinic, or bring it back.
--
-- Suspension is read-only, not lockout: auth_lookup_user admits SUSPENDED, and
-- the API refuses mutating requests. This function only moves the flag.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_set_tenant_status(
  p_tenant_id uuid,
  p_status    varchar,
  p_reason    varchar
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED') THEN
    RAISE EXCEPTION 'unknown tenant status: %', p_status;
  END IF;

  UPDATE tenant
     SET status           = p_status::tenant_status,
         suspended_at     = CASE WHEN p_status = 'SUSPENDED' THEN now() ELSE NULL END,
         suspended_reason = CASE WHEN p_status = 'SUSPENDED' THEN p_reason ELSE NULL END,
         updated_at       = now()
   WHERE id = p_tenant_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Set a seat limit.
--
-- The clinic keeps SELECT on tenant_seat_limit and nothing else — a clinic that
-- can raise its own seat limit does not have a seat limit — so this is how the
-- number gets there.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_set_seat_limit(
  p_tenant_id uuid,
  p_role_key  varchar,
  p_max_users int
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  INSERT INTO tenant_seat_limit (tenant_id, role_key, max_users, updated_at)
       VALUES (p_tenant_id, p_role_key, p_max_users, now())
  ON CONFLICT (tenant_id, role_key)
    DO UPDATE SET max_users = EXCLUDED.max_users, updated_at = now();
END;
$$;

-- -----------------------------------------------------------------------------
-- Counts, across every clinic.
--
-- The only function here that reads tenant-scoped tables, and it returns nothing
-- but integers and one timestamp. A platform admin may know that a clinic has
-- 240 patients and that somebody signed in this morning; there is no shape of
-- result here that could tell them a name.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_clinic_stats()
RETURNS TABLE (
  tenant_id      uuid,
  active_users   bigint,
  patient_count  bigint,
  last_sign_in   timestamptz
)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT t.id,
         (SELECT count(*) FROM app_user u WHERE u.tenant_id = t.id AND u.is_active),
         (SELECT count(*) FROM patient p  WHERE p.tenant_id = t.id),
         (SELECT max(u.last_login_at) FROM app_user u WHERE u.tenant_id = t.id)
    FROM tenant t;
$$;

COMMENT ON FUNCTION platform_clinic_stats() IS
  'Per-clinic counts for the platform console. Returns integers only — never a patient, user or clinical row.';

GRANT EXECUTE ON FUNCTION platform_create_tenant(varchar, varchar, varchar, varchar, varchar, varchar, uuid) TO healthcloud_app;
GRANT EXECUTE ON FUNCTION platform_set_tenant_status(uuid, varchar, varchar) TO healthcloud_app;
GRANT EXECUTE ON FUNCTION platform_set_seat_limit(uuid, varchar, int) TO healthcloud_app;
GRANT EXECUTE ON FUNCTION platform_clinic_stats() TO healthcloud_app;

-- And take back the broad grant the previous migration added: seat limits are
-- written through the function above, not by whoever holds the app connection.
REVOKE INSERT, UPDATE, DELETE ON "tenant_seat_limit" FROM healthcloud_app;
