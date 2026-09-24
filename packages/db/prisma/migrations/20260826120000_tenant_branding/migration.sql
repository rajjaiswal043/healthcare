-- =============================================================================
-- A CLINIC'S OWN LOGO
--
-- White-label branding: every clinic sees its own name and mark, never ours.
-- Plan and reasoning in docs/07-white-label-branding-plan.md.
--
-- The bytes live here rather than in an object store. One row per tenant, half
-- a megabyte at most, written almost never, read from HTTP cache almost always
-- — against which a bucket costs an IAM role, a set of credentials and a second
-- thing a backup can be inconsistent with. The API keeps a `BrandingStore`
-- interface over this so the day patient documents force a real object store,
-- moving logos is a new adapter rather than a change at every call site.
--
-- `tenant` carries no row-level security: it IS the tenancy root, the thing
-- every policy resolves against, so it cannot be filtered by itself. That makes
-- every column added here a column the database is not protecting, which is
-- worth restating each time this table grows. What protects the logo is that
-- the write path resolves the tenant from the caller's session, and the read
-- path takes a slug and returns three columns.
-- =============================================================================

ALTER TABLE "tenant"
  ADD COLUMN "logo_bytes"      bytea,
  ADD COLUMN "logo_mime_type"  varchar(64),
  ADD COLUMN "logo_updated_at" timestamptz(6);

-- All three, or none of them. A MIME type with no bytes renders as a broken
-- image on a clinic's login page — the first screen they ever see — and a
-- constraint is a cheaper place to find that than a support call.
ALTER TABLE "tenant"
  ADD CONSTRAINT "tenant_logo_is_all_or_nothing" CHECK (
    ("logo_bytes" IS NULL AND "logo_mime_type" IS NULL AND "logo_updated_at" IS NULL)
    OR
    ("logo_bytes" IS NOT NULL AND "logo_mime_type" IS NOT NULL AND "logo_updated_at" IS NOT NULL)
  );

-- Only PNG. Not a preference — it is the whole SVG defence.
--
-- Every upload is re-encoded server-side before it reaches this column, and
-- this constraint is what makes that non-optional rather than a step somebody
-- can refactor away. An SVG is a document: it can carry <script>, and this file
-- is served from our own origin to a page nobody has authenticated on. Storing
-- only raster bytes ends that class of bug instead of trying to sanitise it.
ALTER TABLE "tenant"
  ADD CONSTRAINT "tenant_logo_is_png" CHECK (
    "logo_mime_type" IS NULL OR "logo_mime_type" = 'image/png'
  );

-- Half a megabyte, enforced where it cannot be bypassed. The API refuses larger
-- uploads before decoding them; this is the backstop that keeps section 4's
-- "logos in the database is cheap" argument true no matter what calls it.
ALTER TABLE "tenant"
  ADD CONSTRAINT "tenant_logo_size_is_bounded" CHECK (
    "logo_bytes" IS NULL OR octet_length("logo_bytes") <= 524288
  );

COMMENT ON COLUMN "tenant"."logo_bytes" IS
  'PNG bytes, <=512KB, re-encoded by the API. Served publicly by slug — never treat as private.';
