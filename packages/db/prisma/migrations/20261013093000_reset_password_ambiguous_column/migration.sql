-- =============================================================================
-- `user_id` MEANT TWO THINGS IN ONE FUNCTION
--
-- `platform_reset_clinic_password` declares `user_id` as an OUT column in its
-- RETURNS TABLE, and then writes `UPDATE session ... WHERE user_id = p_user_id`.
-- Inside plpgsql the OUT name is in scope, so that reference is ambiguous and
-- Postgres refuses the whole statement:
--
--   42702: column reference "user_id" is ambiguous
--
-- It failed on the first real call rather than at creation time, because plpgsql
-- resolves names when the statement runs. The refusal paths — not an
-- administrator, switched off — passed throughout, since they return before
-- reaching the UPDATE. Only the path that actually resets anybody was broken,
-- which is the one shape of bug a test that asserts a refusal cannot catch.
--
-- Fixed by qualifying the column with its table. The OUT names stay as they
-- are: the service and the console read them, and renaming them to dodge a
-- scoping rule would push the oddity outward into TypeScript.
--
-- Replaced rather than edited in place. 20261013090000 is applied; changing it
-- would make every database that already has it disagree with the file.
-- =============================================================================

CREATE OR REPLACE FUNCTION platform_reset_clinic_password(
  p_tenant_id     uuid,
  p_user_id       uuid,
  p_password_hash varchar
) RETURNS TABLE (
  user_id   uuid,
  email     varchar,
  full_name varchar
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
BEGIN
  -- Inside the policy, or everything below matches nothing at all. `app_user`
  -- carries FORCE RLS, which applies to this function's owner too.
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  SELECT EXISTS (
           SELECT 1
             FROM app_user u
             JOIN user_role ur ON ur.user_id = u.id
             JOIN role r       ON r.id = ur.role_id
            WHERE u.id = p_user_id
              AND u.tenant_id = p_tenant_id
              AND u.is_active
              AND 'user:manage' = ANY (r.permissions)
         )
    INTO v_is_admin;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'NOT_A_CLINIC_ADMINISTRATOR'
      USING HINT = 'The platform may only reset an active account that can manage users.';
  END IF;

  UPDATE app_user
     SET password_hash        = p_password_hash,
         must_change_password = true,
         failed_login_count   = 0,
         locked_until         = NULL,
         updated_at           = now()
   WHERE app_user.id = p_user_id AND app_user.tenant_id = p_tenant_id;

  -- Table-qualified: bare `user_id` here is the OUT column above, not this one.
  UPDATE session
     SET revoked_at     = now(),
         revoked_reason = 'platform_password_reset'
   WHERE session.user_id = p_user_id
     AND session.tenant_id = p_tenant_id
     AND session.revoked_at IS NULL;

  RETURN QUERY
    SELECT u.id, u.email, u.full_name
      FROM app_user u
     WHERE u.id = p_user_id AND u.tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION platform_reset_clinic_password(uuid, uuid, varchar) TO healthcloud_app;
