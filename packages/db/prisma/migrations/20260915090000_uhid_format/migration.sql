-- =============================================================================
-- PATIENT ID FORMAT — MAKE THE ALLOCATOR SAFE TO CONFIGURE
--
-- Phase P1 of the Patient ID Format requirement. The requirement is mostly a
-- screen: ask the clinic what its patient numbers should look like. But the
-- moment prefix and width become things a person CHOOSES, two faults in the
-- allocator stop being theoretical, and they have to be closed before any
-- screen lets somebody reach them.
--
-- What is deliberately NOT touched: the atomic UPDATE ... RETURNING that hands
-- out numbers, every UHID already issued, and the counter, which is never
-- reset by anything here.
-- =============================================================================


-- =============================================================================
-- 1. A NUMBER LONGER THAN THE WIDTH IS WRITTEN IN FULL, NOT CUT DOWN
--
-- `lpad(text, n, fill)` does two jobs: it pads a short string AND truncates a
-- long one to n characters, keeping the left. So at width 4:
--
--     patient  1,000 -> lpad('1000',  4, '0') -> '1000'   DRVIV-1000
--     patient 10,000 -> lpad('10000', 4, '0') -> '1000'   DRVIV-1000   <- same
--
-- Registration writes the patient in the same transaction that advanced the
-- counter, and (tenant_id, uhid) is unique. So the clash rolls back — counter
-- included — and the NEXT registration computes the same number and clashes
-- again. The clinic cannot register anybody from that point on.
--
-- Every clinic today is at width 5, so this was waiting at patient 1,00,000.
-- A clinic choosing width 4 — the requirement's own example, DRVIV-0001 —
-- would hit it at 10,000.
--
-- Only the final expression changes. The UPDATE ... RETURNING that makes
-- allocation atomic is copied exactly.
-- =============================================================================

CREATE OR REPLACE FUNCTION next_uhid(p_tenant_id uuid) RETURNS varchar
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_counter bigint;
  v_prefix  varchar;
  v_padding int;
  v_digits  text;
BEGIN
  UPDATE "tenant"
     SET uhid_counter = uhid_counter + 1
   WHERE id = p_tenant_id
  RETURNING uhid_counter, uhid_prefix, uhid_padding
       INTO v_counter, v_prefix, v_padding;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tenant %', p_tenant_id;
  END IF;

  -- Pad when short. Never cut when long: DRVIV-9999 is followed by
  -- DRVIV-10000, which is longer and unique, rather than by DRVIV-1000 again.
  v_digits := v_counter::text;
  IF length(v_digits) < v_padding THEN
    v_digits := lpad(v_digits, v_padding, '0');
  END IF;

  RETURN v_prefix || v_digits;
END;
$$;

-- CREATE OR REPLACE keeps the existing grant; restated so this file reads whole.
GRANT EXECUTE ON FUNCTION next_uhid(uuid) TO healthcloud_app;


-- =============================================================================
-- 2. WHAT A FORMAT MAY BE
--
-- The prefix rule (decision D6):
--
--   * A-Z, 0-9, '-' and '/' only. No space. No '%' or '_', which patient search
--     would read as wildcards — it matches `uhid ILIKE '%…%'`.
--   * Starts with a letter.
--   * NEVER ends with a digit. This is the rule that closes the second fault.
--     With a digit-ending prefix, a later format change can re-create an ID
--     that already exists even though the counter only ever goes up:
--
--         before:  DRV1 + width 2, patient   5  ->  DRV1 + 05   = DRV105
--         after:   DRV  + width 3, patient 105  ->  DRV  + 105  = DRV105
--
--     Given (1) above — digits are never truncated — a prefix that cannot end
--     in a digit makes that impossible, not merely unlikely: the number part of
--     every new ID is strictly larger than the number part of every old one.
--
-- Width 3 to 8 (decision D7). After (1), a small width is no longer dangerous,
-- it just grows; the range exists to keep the format sensible and inside the
-- 32-character UHID column with an 8-character prefix.
--
-- Every clinic that exists passes: SNC, LTS, XEE and RAM, all at width 5.
-- =============================================================================

ALTER TABLE "tenant" ADD CONSTRAINT "tenant_uhid_prefix_format" CHECK (
  "uhid_prefix" ~ '^[A-Z]([A-Z0-9/-]*[A-Z/-])?$'
);

ALTER TABLE "tenant" ADD CONSTRAINT "tenant_uhid_padding_range" CHECK (
  "uhid_padding" BETWEEN 3 AND 8
);

-- One default, not two. The column said 6 and `platform_create_tenant` said 5,
-- so the "default" depended on which path created the clinic. Every live
-- clinic is at 5, and so is the seed data.
ALTER TABLE "tenant" ALTER COLUMN "uhid_padding" SET DEFAULT 5;


-- =============================================================================
-- 3. ONBOARDING TAKES THE WIDTH INSTEAD OF HARDCODING IT
--
-- DROP, not CREATE OR REPLACE. Adding a parameter changes the signature, and
-- Postgres would keep the old seven-argument function alongside the new one as
-- an overload — two functions, and a caller with the old argument list would
-- silently get the hardcoded width. Dropped so there is exactly one.
-- =============================================================================

DROP FUNCTION platform_create_tenant(varchar, varchar, varchar, varchar, varchar, varchar, uuid);

CREATE FUNCTION platform_create_tenant(
  p_slug            varchar,
  p_name            varchar,
  p_timezone        varchar,
  p_uhid_prefix     varchar,
  p_uhid_padding    int,
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
       VALUES (p_slug, p_name, p_name, p_timezone, upper(p_uhid_prefix), p_uhid_padding,
               p_contact_email, p_contact_mobile, p_onboarded_by, now())
    RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION platform_create_tenant(varchar, varchar, varchar, varchar, int, varchar, varchar, uuid) IS
  'Creates a clinic, with the patient ID format it was onboarded with. The only way the application role can write a tenant row.';

GRANT EXECUTE ON FUNCTION platform_create_tenant(varchar, varchar, varchar, varchar, int, varchar, varchar, uuid) TO healthcloud_app;


-- =============================================================================
-- 4. CHANGING THE FORMAT LATER — PREFIX AND WIDTH, NEVER THE COUNTER
--
-- For FR-UID-03: the clinic got it wrong at onboarding and asks a fortnight in.
-- Existing patients keep the IDs printed on their cards; this only changes what
-- the NEXT registration is given.
--
-- The counter is absent from the SET list on purpose, and must stay absent.
-- Resetting it would issue a second patient whose number differs from an
-- existing one only by prefix — the one thing this ID exists to prevent.
--
-- Returns what the clinic now has, including how many IDs have been issued, so
-- the caller can record and show the result without a second read.
--
-- Output columns are named differently from the table's on purpose: identical
-- names are ambiguous inside PL/pgSQL.
-- =============================================================================

CREATE FUNCTION platform_set_uhid_format(
  p_tenant_id    uuid,
  p_uhid_prefix  varchar,
  p_uhid_padding int
) RETURNS TABLE (prefix varchar, padding int, issued bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    WITH changed AS (
      UPDATE tenant t
         SET uhid_prefix  = upper(p_uhid_prefix),
             uhid_padding = p_uhid_padding,
             updated_at   = now()
       WHERE t.id = p_tenant_id
      RETURNING t.uhid_prefix, t.uhid_padding, t.uhid_counter
    )
    SELECT changed.uhid_prefix, changed.uhid_padding, changed.uhid_counter FROM changed;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tenant %', p_tenant_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION platform_set_uhid_format(uuid, varchar, int) IS
  'Changes the prefix and width for FUTURE registrations. Never touches the counter or any issued UHID.';

GRANT EXECUTE ON FUNCTION platform_set_uhid_format(uuid, varchar, int) TO healthcloud_app;

-- No RLS work: `tenant` is on the RLS allowlist — it defines tenants rather
-- than belonging to one — and no new table is created.
