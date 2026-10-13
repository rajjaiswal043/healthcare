-- =============================================================================
-- THE PLATFORM CAN UNLOCK A CLINIC THAT HAS LOCKED ITSELF OUT
--
-- The gap, found on 13 Oct 2026: a clinic administrator forgets their password
-- and is the only account at that clinic holding `user:manage`. Nobody can
-- help them. There is no self-service reset — nothing in this system sends
-- email — and the platform console has no user management at all. The only
-- route was somebody editing `app_user.password_hash` by hand.
--
-- A fifth named operation, in the shape the other four already take: one
-- function that does exactly one thing, takes exactly the arguments it needs,
-- and is the only way to do it. See 20260817160000_platform_operations for why
-- the platform's powers are functions rather than grants — the application role
-- is the SAME role the clinic-facing app uses, so a broad grant here would hand
-- a consultation screen the ability to reset passwords.
--
-- ADMINISTRATORS ONLY, and that is enforced here rather than in the API.
--
--   Narveer's decision, 13 Oct 2026. The lockout this exists for is "the only
--   administrator cannot get in"; every other user at a clinic already has
--   somebody who can reset them. Widening it would let a platform operator take
--   over a named DOCTOR's account — and that doctor's name is what prints on a
--   signed prescription. The check lives in the function because a rule the API
--   enforces is a rule one new endpoint can forget.
--
-- WHAT IT DOES NOT DO. It does not return the password, choose it, or hash it.
-- The caller generates and hashes, exactly as the clinic's own reset does, so
-- there is one implementation of what a temporary password is and one place
-- that decides how it is hashed. This function writes a hash it is handed.
--
-- FORCE RLS APPLIES TO THIS FUNCTION'S OWNER. `app_user` carries it, so a read
-- or write here without `app.tenant_id` set matches zero rows, reports success,
-- and resets nobody. The `set_config` below is not defensive — without it this
-- function silently does nothing. Fifth time this has come up; see
-- docs/03-resume-here.md.
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
  -- Inside the policy, or everything below matches nothing at all.
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  -- Holds `user:manage` through at least one of its roles, and is still active.
  -- A switched-off account is not a lockout to solve; it is an account somebody
  -- deliberately closed, and handing out a working password for it would be a
  -- way to reopen one quietly.
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
         -- A forgotten password is usually several wrong attempts, so the
         -- account is often locked as well. Leaving the counter would hand
         -- somebody a password that does not work yet.
         failed_login_count   = 0,
         locked_until         = NULL,
         updated_at           = now()
   WHERE id = p_user_id AND tenant_id = p_tenant_id;

  -- Every session that account holds. Since sessions stopped expiring on
  -- 7 Oct 2026 this is the ONLY thing that ends one, so a reset that skipped it
  -- would leave whoever was already signed in there for a year.
  UPDATE session
     SET revoked_at     = now(),
         revoked_reason = 'platform_password_reset'
   WHERE user_id = p_user_id
     AND tenant_id = p_tenant_id
     AND revoked_at IS NULL;

  RETURN QUERY
    SELECT u.id, u.email, u.full_name
      FROM app_user u
     WHERE u.id = p_user_id AND u.tenant_id = p_tenant_id;
END;
$$;

COMMENT ON FUNCTION platform_reset_clinic_password(uuid, uuid, varchar) IS
  'Sets a new password hash for a clinic account that holds user:manage, forces a change at next sign-in and revokes its sessions. Refuses any other account. The caller generates and hashes the password.';

GRANT EXECUTE ON FUNCTION platform_reset_clinic_password(uuid, uuid, varchar) TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- Who the platform may reset, so the console can offer a list rather than ask
-- for a uuid.
--
-- Names and emails of ADMINISTRATORS ONLY — the same set the function above will
-- act on, by the same condition, so the console cannot show a row the reset
-- would then refuse. Note what this is not: a way to list a clinic's staff.
-- `platform_clinic_stats` returns integers precisely so the platform cannot
-- enumerate people, and this does not widen that to doctors, nurses or patients.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_clinic_administrators(p_tenant_id uuid)
RETURNS TABLE (
  user_id   uuid,
  email     varchar,
  full_name varchar
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  RETURN QUERY
    SELECT DISTINCT u.id, u.email, u.full_name
      FROM app_user u
      JOIN user_role ur ON ur.user_id = u.id
      JOIN role r       ON r.id = ur.role_id
     WHERE u.tenant_id = p_tenant_id
       AND u.is_active
       AND 'user:manage' = ANY (r.permissions)
     ORDER BY u.full_name;
END;
$$;

COMMENT ON FUNCTION platform_clinic_administrators(uuid) IS
  'The accounts at one clinic that hold user:manage, for the platform''s password-reset screen. Administrators only — never the clinic''s full staff list.';

GRANT EXECUTE ON FUNCTION platform_clinic_administrators(uuid) TO healthcloud_app;
