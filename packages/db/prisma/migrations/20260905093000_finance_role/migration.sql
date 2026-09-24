-- =============================================================================
-- THE FINANCE ROLE, FOR CLINICS THAT ALREADY EXIST
--
-- `finance` was added to SYSTEM_ROLES, so every clinic onboarded from now on
-- gets it. Clinics that already exist do not: their `role` rows were written
-- when they were created and nothing rewrites them. Without this, an
-- administrator at an existing clinic would open Roles and permissions, look for
-- Finance, and not find it — with nothing on screen to explain why.
--
-- AND AGAIN: THE set_config LOOP IS LOAD-BEARING.
--
-- `role` is under FORCE ROW LEVEL SECURITY and FORCE applies to the owner, which
-- is who a migration runs as. A plain INSERT here matches nothing, reports
-- success, and leaves every clinic without the role. That is the fourth time
-- this pattern has been needed; see docs/03-resume-here.md and the two
-- migrations of 26–27 Aug that record the same lesson.
--
-- The row counts are raised because "the migration ran" and "the migration did
-- something" are different claims, and only one of them is worth anything.
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

    -- The role. This permission list mirrors SYSTEM_ROLES in
    -- packages/db/src/permissions.ts — the two drifting apart is how the front
    -- desk once ended up with a permission new clinics did not have, and
    -- nothing noticed until a test asserted it. If you change one, change the
    -- other.
    --
    -- Note what is ABSENT and why: no appointment:write or appointment:cancel
    -- (this desk does not hold the diary), no diagnostic:order, no
    -- consultation:*, no vitals:write, no prescription:write, and none of
    -- payment:refund / invoice:waive / invoice:defer — the three ways money
    -- leaves without a service behind it stay with the administrator.
    INSERT INTO role (tenant_id, key, name, description, permissions, is_system, requires_mfa, updated_at)
    SELECT v_tenant.id,
           'finance',
           'Finance',
           'Meets the patient first. Registers, bills, discounts and takes payment.',
           ARRAY[
             'patient:read', 'patient:write', 'consent:read', 'consent:write',
             'appointment:read', 'visit:open',
             'invoice:read', 'invoice:write', 'payment:collect', 'promotion:apply',
             'report:revenue'
           ],
           true,
           false,
           now()
     WHERE NOT EXISTS (SELECT 1 FROM role WHERE key = 'finance');

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_roles := v_roles + v_changed;

    -- Opening today's visit, named separately from holding the diary. The front
    -- desk always COULD do this; it is granted here so that when the walk-in
    -- route starts asking for `visit:open`, no existing role loses a power it
    -- has today. The administrator holds every permission by definition.
    UPDATE role
       SET permissions = array_append(permissions, 'visit:open'),
           updated_at  = now()
     WHERE key IN ('front_desk', 'administrator')
       AND NOT ('visit:open' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_perms := v_perms + v_changed;

    -- Defining a discount. The administrator only — deliberately NOT finance,
    -- which applies promotions and must not be able to invent one.
    UPDATE role
       SET permissions = array_append(permissions, 'promotion:manage'),
           updated_at  = now()
     WHERE key = 'administrator'
       AND NOT ('promotion:manage' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_perms := v_perms + v_changed;

    -- Applying one. The administrator, because they hold everything; finance
    -- already has it from the INSERT above.
    UPDATE role
       SET permissions = array_append(permissions, 'promotion:apply'),
           updated_at  = now()
     WHERE key = 'administrator'
       AND NOT ('promotion:apply' = ANY (permissions));

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_perms := v_perms + v_changed;
  END LOOP;

  RAISE NOTICE 'Created % finance role(s) and widened % existing role(s).', v_roles, v_perms;
END $$;
