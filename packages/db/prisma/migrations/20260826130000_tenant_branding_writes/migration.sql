-- =============================================================================
-- WRITING A LOGO, AND A GRANT THAT HAD DRIFTED
--
-- Two things, and the second is the reason the first is written this way.
--
-- `healthcloud_app` may only SELECT from `tenant`. That is set in
-- 20260806084252_init_tenancy — "GRANT SELECT ON tenant", explicitly, with no
-- INSERT, UPDATE or DELETE — and it is why the platform tier expresses its
-- powers as SECURITY DEFINER functions rather than as table grants: writing a
-- tenant row is not something the clinic-facing application should be able to
-- do by accident.
--
-- The branding work was first written as a plain `UPDATE tenant SET logo_...`,
-- and it worked, because the DEVELOPMENT database had somehow acquired INSERT,
-- UPDATE and DELETE on this table that no migration grants. The integration
-- suite, running against a database built only from migrations, refused it with
-- 42501. Development was more permissive than production would have been, and
-- the only thing that caught it was a test database rebuilt from scratch.
--
-- So this migration does both: it adds the two functions the API now calls, and
-- it REVOKEs the privileges that were never granted — a no-op on a correct
-- database, and a repair on a drifted one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Set a clinic's logo.
--
-- Takes the tenant id, which the API resolves from the caller's session and
-- never from a request body. This function cannot be pointed at another clinic
-- by anything in an HTTP request; the only way to reach it is to already know
-- which tenant you are.
--
-- The CHECK constraints on the table still apply — PNG only, at most 512KB, all
-- three columns or none — so this function cannot be used to write a logo the
-- ordinary path would have refused.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_set_logo(
  p_tenant_id uuid,
  p_bytes     bytea,
  p_mime_type varchar
) RETURNS timestamptz
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  UPDATE tenant
     SET logo_bytes      = p_bytes,
         logo_mime_type  = p_mime_type,
         logo_updated_at = v_now,
         updated_at      = v_now
   WHERE id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such tenant: %', p_tenant_id USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_now;
END;
$$;

COMMENT ON FUNCTION tenant_set_logo(uuid, bytea, varchar) IS
  'Sets a clinic logo. The only way the application role can write to tenant.logo_bytes.';

-- -----------------------------------------------------------------------------
-- Remove a clinic's logo, returning it to the bundled default.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_clear_logo(p_tenant_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  UPDATE tenant
     SET logo_bytes      = NULL,
         logo_mime_type  = NULL,
         logo_updated_at = NULL,
         updated_at      = now()
   WHERE id = p_tenant_id;
END;
$$;

COMMENT ON FUNCTION tenant_clear_logo(uuid) IS
  'Clears a clinic logo. Paired with tenant_set_logo; same reason for existing.';

GRANT EXECUTE ON FUNCTION tenant_set_logo(uuid, bytea, varchar) TO healthcloud_app;
GRANT EXECUTE ON FUNCTION tenant_clear_logo(uuid) TO healthcloud_app;

-- -----------------------------------------------------------------------------
-- The repair.
--
-- Nothing in this repository ever granted these. A database built from
-- migrations alone does not have them and this line changes nothing; a database
-- that picked them up some other way is brought back in line. Written as an
-- explicit REVOKE rather than left alone because "dev allows a write that
-- production refuses" is the most expensive shape of drift there is — it turns
-- a permission error into something you only meet after deploying.
-- -----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON "tenant" FROM healthcloud_app;
