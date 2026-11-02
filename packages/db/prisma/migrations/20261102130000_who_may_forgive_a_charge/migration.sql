-- =============================================================================
-- THE DOCTOR, THE FRONT DESK AND FINANCE MAY FORGIVE A CHARGE
--
-- Narveer's call, 2 Nov 2026: "as an admin or doctor I saw him and said why
-- you paid bro, let me refund you — I want to give him these services free."
-- Two or three a day, and only the administrator could do it.
--
-- `SYSTEM_ROLES` in packages/db/src/permissions.ts gives `invoice:waive` to
-- every clinic onboarded from now on. THIS GIVES IT TO THE CLINICS THAT
-- ALREADY EXIST — without it the live clinic's staff would never see the
-- feature, because roles are rows, not code.
--
-- ONLY AN UNCUSTOMISED ROLE, exactly as 20260922110000 did. There is no
-- "customised" flag, so the test is the permission set itself: a role is
-- changed only when it holds EXACTLY what it ships with today, minus the one
-- being added. A clinic that has edited a role made a choice about what those
-- people may do, and this does not overrule it. Those are counted in the
-- NOTICE so they can be followed up.
--
-- UNCAPPED, DELIBERATELY. The clinic gives services away while the person who
-- would authorise it is in a room with a patient, so a ceiling means the money
-- is taken anyway and sorted out later. What makes it safe is visibility
-- rather than prevention: every waiver names who, how much and why, cannot be
-- deleted, and appears as its own figure in the finance report.
--
-- IDEMPOTENT. After the append a role no longer matches the set it is tested
-- against, so a second run touches nothing.
--
-- THE set_config LOOP IS LOAD-BEARING, as in 20260905120000 and
-- 20260922110000: `role` is under FORCE row level security, which applies to
-- the owner a migration runs as. Without the loop the UPDATE matches zero rows
-- and reports success.
--
-- SESSIONS. Permissions travel in the signed access token, so anyone already
-- signed in gains this when their token is next refreshed, not at once.
-- =============================================================================

DO $$
DECLARE
  v_tenant     record;
  v_changed    integer;
  v_total      integer := 0;
  v_customised integer := 0;

  -- The front desk as it ships TODAY, less the permission being added.
  v_front_desk text[] := ARRAY[
    'patient:read', 'patient:write',
    'consent:read', 'consent:write',
    'appointment:read', 'appointment:write', 'appointment:cancel',
    'visit:open', 'queue:prioritise',
    'invoice:read', 'invoice:write', 'payment:collect',
    'promotion:apply',
    'document:read', 'diagnostic:read'
  ];

  -- The doctor, likewise. Note this grants NO other money power: a doctor
  -- still cannot take a payment or issue a refund on their own.
  v_doctor text[] := ARRAY[
    'patient:read', 'patient:write',
    'consent:read',
    'appointment:read', 'appointment:write',
    'queue:prioritise',
    'consultation:read', 'consultation:write',
    'vitals:write', 'prescription:write',
    'document:read', 'diagnostic:order', 'diagnostic:read'
  ];

  -- Finance, which already owns the numbers and answers for where the day's
  -- money went.
  v_finance text[] := ARRAY[
    'patient:read', 'patient:write',
    'appointment:read',
    'visit:open',
    'invoice:read', 'invoice:write', 'payment:collect',
    'promotion:apply',
    'diagnostic:order:walkin',
    'report:revenue'
  ];
BEGIN
  FOR v_tenant IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', v_tenant.id::text, true);

    UPDATE role
       SET permissions = array_append(permissions, 'invoice:waive'),
           updated_at  = now()
     WHERE is_system
       AND NOT ('invoice:waive' = ANY (permissions))
       AND (
         (key = 'front_desk' AND permissions @> v_front_desk AND permissions <@ v_front_desk)
         OR (key = 'doctor' AND permissions @> v_doctor AND permissions <@ v_doctor)
         OR (key = 'finance' AND permissions @> v_finance AND permissions <@ v_finance)
       );

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed;

    -- Counted, not changed: a role this clinic has edited, still without the
    -- permission. Its administrator can add it, or press "reset".
    SELECT v_customised + count(*)
      INTO v_customised
      FROM role
     WHERE key IN ('front_desk', 'doctor', 'finance')
       AND NOT ('invoice:waive' = ANY (permissions))
       AND NOT (
         (key = 'front_desk' AND permissions @> v_front_desk AND permissions <@ v_front_desk)
         OR (key = 'doctor' AND permissions @> v_doctor AND permissions <@ v_doctor)
         OR (key = 'finance' AND permissions @> v_finance AND permissions <@ v_finance)
       );
  END LOOP;

  RAISE NOTICE 'Gave invoice:waive to % role(s); left % customised one(s) as they were.',
    v_total, v_customised;
END $$;
