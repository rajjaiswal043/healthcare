-- =============================================================================
-- THE FRONT DESK MAY APPLY A DISCOUNT
--
-- Decision of 22 Sep 2026: the front desk collects the consultation fee from
-- the queue, and gets `promotion:apply` — every promotion, CUSTOM included —
-- so the discount can be given where the money is taken. The approver rule is
-- unchanged: an approver must be named, and must be an active member of staff.
--
-- `SYSTEM_ROLES` in packages/db/src/permissions.ts gives it to every clinic
-- onboarded from now on. This gives it to the clinics that already exist.
--
-- ONLY AN UNCUSTOMISED FRONT DESK. Roles are per clinic and an administrator
-- with `role:manage` can edit this one. There is no "customised" flag, so the
-- test is the permissions themselves: a front_desk role is changed only when
-- it holds EXACTLY the fourteen permissions it ships with today — no more, no
-- fewer, in any order. A clinic that has edited its front desk made a choice
-- about what that desk may do, and this does not overrule it; its administrator
-- can add the permission, or press "reset", which now includes it. Those
-- clinics are counted in the NOTICE below so they can be followed up.
--
-- WHAT IT CHANGES. One element appended to `role.permissions`, on rows with
-- key = 'front_desk' AND is_system. No other column, role or table.
--
-- IDEMPOTENT. After the append the row holds fifteen permissions, so it no
-- longer matches the fourteen, and a second run touches nothing.
--
-- THE set_config LOOP IS LOAD-BEARING, as in 20260905120000: `role` is under
-- FORCE row level security, which applies to the owner a migration runs as.
-- Without the loop the UPDATE matches zero rows and reports success.
--
-- SESSIONS. Permissions travel in the signed access token, so a front-desk user
-- already signed in gains this when their token is next refreshed, not at once.
-- =============================================================================

DO $$
DECLARE
  v_tenant     record;
  v_changed    integer;
  v_total      integer := 0;
  v_customised integer := 0;
  v_default    text[] := ARRAY[
    'patient:read', 'patient:write',
    'consent:read', 'consent:write',
    'appointment:read', 'appointment:write', 'appointment:cancel',
    'visit:open', 'queue:prioritise',
    'invoice:read', 'invoice:write', 'payment:collect',
    'document:read', 'diagnostic:read'
  ];
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    UPDATE role
       SET permissions = array_append(permissions, 'promotion:apply'),
           updated_at  = now()
     WHERE key = 'front_desk'
       AND is_system
       AND permissions @> v_default
       AND permissions <@ v_default;

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;

    -- Counted, not changed: a front desk this clinic has edited, still without
    -- the permission.
    SELECT v_customised + count(*)
      INTO v_customised
      FROM role
     WHERE key = 'front_desk'
       AND NOT ('promotion:apply' = ANY (permissions))
       AND NOT (permissions @> v_default AND permissions <@ v_default);
  END LOOP;

  RAISE NOTICE 'Gave promotion:apply to % front_desk role(s); left % customised one(s) as they were.',
    v_total, v_customised;
END $$;
