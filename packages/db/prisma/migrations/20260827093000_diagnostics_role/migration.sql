-- =============================================================================
-- THE DIAGNOSTICS ROLE, FOR CLINICS THAT ALREADY EXIST
--
-- `diagnostics` was added to SYSTEM_ROLES, so every clinic onboarded from now on
-- gets it. Clinics that already exist do not: their `role` rows were written
-- when they were created and nothing rewrites them. Without this, the Ortho
-- Clinic administrator would open Staff, look for the Diagnostics role, and not
-- find it — with nothing on screen to explain why.
--
-- AND AGAIN: THE set_config LOOP IS LOAD-BEARING.
--
-- `role` is under FORCE ROW LEVEL SECURITY and FORCE applies to the owner, which
-- is who a migration runs as. A plain INSERT here matches nothing, reports
-- success, and leaves every clinic without the role. That is the third time this
-- pattern has been needed in two days; see docs/03-resume-here.md.
--
-- The row count is raised because "the migration ran" and "the migration did
-- something" are different claims.
-- =============================================================================

DO $$
DECLARE
  v_tenant  record;
  v_changed integer;
  v_roles   integer := 0;
  v_perms   integer := 0;
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    -- The role. Permission list mirrors SYSTEM_ROLES in
    -- packages/db/src/permissions.ts — the two drifting apart is how the front
    -- desk ended up with a permission new clinics did not have, one migration
    -- ago. If you change one, change the other.
    INSERT INTO role (tenant_id, key, name, description, permissions, is_system, requires_mfa, updated_at)
    SELECT v_tenant.id,
           'diagnostics',
           'Diagnostics',
           'X-ray and pathology. Works the test list and attaches results.',
           ARRAY[
             'patient:read', 'consent:read', 'appointment:read', 'consultation:read',
             'diagnostic:read', 'diagnostic:result', 'document:read', 'document:write'
           ],
           true,
           false,
           now()
     WHERE NOT EXISTS (SELECT 1 FROM role WHERE key = 'diagnostics');

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_roles := v_roles + v_changed;

    -- Reading the test list: everyone clinical, plus the front desk who fields
    -- "are my results back yet".
    UPDATE role
       SET permissions = array_append(permissions, 'diagnostic:read'),
           updated_at  = now()
     WHERE key IN ('doctor', 'nurse', 'front_desk', 'owner', 'administrator')
       AND NOT ('diagnostic:read' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_perms := v_perms + v_changed;

    -- Raising one. The doctor, and the administrator who holds everything.
    UPDATE role
       SET permissions = array_append(permissions, 'diagnostic:order'),
           updated_at  = now()
     WHERE key IN ('doctor', 'administrator')
       AND NOT ('diagnostic:order' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_perms := v_perms + v_changed;

    -- Attaching a result. The administrator, because they hold every permission;
    -- the diagnostics role already has it from the INSERT above. Deliberately
    -- NOT the doctor: a department does not result its own order.
    UPDATE role
       SET permissions = array_append(permissions, 'diagnostic:result'),
           updated_at  = now()
     WHERE key = 'administrator'
       AND NOT ('diagnostic:result' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_perms := v_perms + v_changed;
  END LOOP;

  RAISE NOTICE 'Created % diagnostics role(s) and widened % existing role(s).', v_roles, v_perms;
END $$;
