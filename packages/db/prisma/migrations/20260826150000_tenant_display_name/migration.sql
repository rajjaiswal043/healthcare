-- =============================================================================
-- A CLINIC RENAMING ITSELF
--
-- White-labelling gave `tenant.name` a job it never had: it is now written
-- across the console chrome, the browser tab and the printed prescription. A
-- clinic that registered as "Sunrise Clinic" and trades as "Sunrise
-- Multispeciality Hospital" should be able to fix that without emailing us.
--
-- Same route as the logo, and for the same reason: `healthcloud_app` holds
-- SELECT on `tenant` and nothing else, so the write is a named function rather
-- than a grant. See 20260826130000_tenant_branding_writes.
--
-- `legal_name` is deliberately NOT touched here. It is what the clinic is
-- registered as, it appears on documents that have to match a registration, and
-- it is not a display preference — changing it is a platform-side operation
-- with a paper trail, not a settings toggle.
-- =============================================================================

CREATE OR REPLACE FUNCTION tenant_set_display_name(
  p_tenant_id uuid,
  p_name      varchar
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  IF length(btrim(p_name)) < 2 THEN
    RAISE EXCEPTION 'A clinic name must be at least two characters'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE tenant
     SET name       = btrim(p_name),
         updated_at = now()
   WHERE id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such tenant: %', p_tenant_id USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

COMMENT ON FUNCTION tenant_set_display_name(uuid, varchar) IS
  'Renames a clinic for display. Does not touch legal_name, which is a registration fact.';

GRANT EXECUTE ON FUNCTION tenant_set_display_name(uuid, varchar) TO healthcloud_app;
