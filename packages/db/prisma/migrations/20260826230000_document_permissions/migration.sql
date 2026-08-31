-- =============================================================================
-- GIVING EXISTING CLINICS THE NEW PERMISSIONS
--
-- `document:read` and `document:write` were added to SYSTEM_ROLES, which means
-- every clinic onboarded from now on gets them. Clinics that already exist do
-- NOT: their `role` rows were written when they were created and nothing
-- rewrites them. Without this migration, the doctor at Ortho Clinic could not
-- open an X-ray and nobody would be able to say why — the permission exists in
-- the code and not in their database.
--
-- NOTE THE set_config LOOP, AND THAT IT IS LOAD-BEARING.
--
-- `role` is under FORCE ROW LEVEL SECURITY, and FORCE applies to the table's
-- owner — which is who a migration runs as. A plain `UPDATE role SET ...` here
-- would match zero rows in every tenant, report success, and leave every clinic
-- exactly as it was. That is not hypothetical: it happened on 26 Aug 2026 to a
-- practitioner-name migration in this same repository, and the migration was
-- green while the data was untouched.
--
-- The row count is raised at the end for the same reason. "The migration ran"
-- and "the migration did something" are different claims, and only one of them
-- is worth anything.
-- =============================================================================

DO $$
DECLARE
  v_tenant  record;
  v_changed integer;
  v_total   integer := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    -- Reading an X-ray during a consultation. Everyone clinical, plus the front
    -- desk, who field "are my results back yet".
    UPDATE role
       SET permissions = array_append(permissions, 'document:read'),
           updated_at  = now()
     WHERE key IN ('doctor', 'nurse', 'front_desk', 'owner')
       AND NOT ('document:read' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;

    -- Attaching one. Administrators only for now; the `diagnostics` role that
    -- will actually do this day to day arrives in checkpoint 2 of docs/09.
    UPDATE role
       SET permissions = array_append(permissions, 'document:write'),
           updated_at  = now()
     WHERE key IN ('administrator')
       AND NOT ('document:write' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;

    -- The administrator role is seeded with ALL_PERMISSIONS, so it needs the
    -- read as well. Kept as its own statement rather than folded above because
    -- the two lists answer different questions and will diverge.
    UPDATE role
       SET permissions = array_append(permissions, 'document:read'),
           updated_at  = now()
     WHERE key = 'administrator'
       AND NOT ('document:read' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;
  END LOOP;

  RAISE NOTICE 'Granted document permissions to % existing role row(s).', v_total;
END $$;
