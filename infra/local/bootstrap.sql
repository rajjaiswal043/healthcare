-- =============================================================================
-- HealthCloud — local database bootstrap
--
-- Run ONCE, as the postgres superuser, before the first `pnpm dev`:
--
--   psql -U postgres -h localhost -p 5432 -f infra/local/bootstrap.sql
--
-- To override the default dev passwords:
--   psql -U postgres -h localhost -p 5432 \
--        -v owner_password="'something'" -v app_password="'something-else'" \
--        -f infra/local/bootstrap.sql
--
-- This script is IDEMPOTENT. Running it twice is safe and does nothing the
-- second time.
--
-- WHY TWO ROLES — this is the crux of ADR-005, not incidental setup:
--
--   healthcloud_owner  owns the tables and runs migrations.
--   healthcloud_app    is what the application connects as.
--
-- PostgreSQL exempts a table's OWNER from its row-level security policies
-- unless FORCE ROW LEVEL SECURITY is set. Relying on FORCE alone leaves one
-- misconfigured table silently unprotected. Connecting as a non-owner role
-- means the policies apply by default, and FORCE becomes a second layer rather
-- than the only one. If the app connected as the owner, our tenant isolation
-- would be decorative.
--
-- healthcloud_app is deliberately NOT a superuser and owns nothing. Superusers
-- bypass RLS entirely, which would defeat the whole design.
-- =============================================================================

\set ON_ERROR_STOP on

-- Default dev passwords. Local only — production credentials come from the
-- secret store, never from this file.
--
-- Override like this (note: no nested quotes needed):
--   psql ... -v owner_password=s3cret -v app_password=other
\if :{?owner_password} \else \set owner_password healthcloud_owner_dev \endif
\if :{?app_password}   \else \set app_password   healthcloud_app_dev   \endif

-- -----------------------------------------------------------------------------
-- 1. Roles
--
-- These use \gexec rather than a DO block on purpose: psql does NOT substitute
-- :variables inside dollar-quoted strings, so `EXECUTE format(..., :owner_password)`
-- inside a DO $$ ... $$ block never sees the value and fails to parse. \gexec
-- builds the statement in a normal SELECT — where substitution does happen —
-- and then runs the resulting text. `:'var'` interpolates as a quoted literal.
--
-- Each SELECT returns zero rows when the role already exists, so \gexec runs
-- nothing. That is what makes this idempotent.
-- -----------------------------------------------------------------------------
SELECT format('CREATE ROLE healthcloud_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healthcloud_owner')\gexec

SELECT format('CREATE ROLE healthcloud_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healthcloud_app')\gexec

-- Belt and braces: if these roles somehow acquired elevated attributes, strip
-- them. A superuser or BYPASSRLS app role would silently disable tenant
-- isolation, and that failure would be invisible until it mattered.
ALTER ROLE healthcloud_app  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- The owner gets CREATEDB, and only the owner. Prisma Migrate creates a
-- transient "shadow database" to detect schema drift, which needs it. The app
-- role deliberately does not have it.
ALTER ROLE healthcloud_owner NOSUPERUSER NOCREATEROLE NOBYPASSRLS CREATEDB;

-- -----------------------------------------------------------------------------
-- 2. Databases  (CREATE DATABASE cannot run inside a DO block, hence \gexec)
-- -----------------------------------------------------------------------------
SELECT 'CREATE DATABASE healthcloud_dev OWNER healthcloud_owner ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'healthcloud_dev')\gexec

SELECT 'CREATE DATABASE healthcloud_test OWNER healthcloud_owner ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'healthcloud_test')\gexec

-- Shadow database for `prisma migrate diff` (the drift gate).
--
-- Prisma replays the migration history into this database to compare it against
-- schema.prisma, DROPPING AND RECREATING its schema each time. It must
-- therefore be a dedicated throwaway. Pointing it at healthcloud_dev would
-- destroy your development data on every `pnpm verify`.
SELECT 'CREATE DATABASE healthcloud_shadow OWNER healthcloud_owner ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'healthcloud_shadow')\gexec

-- -----------------------------------------------------------------------------
-- 3. Per-database privileges
-- -----------------------------------------------------------------------------

\connect healthcloud_dev

REVOKE ALL ON DATABASE healthcloud_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE healthcloud_dev TO healthcloud_app, healthcloud_owner;

ALTER SCHEMA public OWNER TO healthcloud_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO healthcloud_app;

-- The app can read and write rows, but cannot create, alter or drop anything.
-- Schema change is the migration role's job exclusively.
ALTER DEFAULT PRIVILEGES FOR ROLE healthcloud_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO healthcloud_app;
ALTER DEFAULT PRIVILEGES FOR ROLE healthcloud_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO healthcloud_app;

-- pg_stat_statements backs the N+1 and slow-query checks (checklist section 5).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

\connect healthcloud_test

REVOKE ALL ON DATABASE healthcloud_test FROM PUBLIC;
GRANT CONNECT ON DATABASE healthcloud_test TO healthcloud_app, healthcloud_owner;

ALTER SCHEMA public OWNER TO healthcloud_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO healthcloud_app;

ALTER DEFAULT PRIVILEGES FOR ROLE healthcloud_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO healthcloud_app;
ALTER DEFAULT PRIVILEGES FOR ROLE healthcloud_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO healthcloud_app;

\connect healthcloud_shadow

-- Only the owner ever touches the shadow database; the app has no business
-- there at all.
REVOKE ALL ON DATABASE healthcloud_shadow FROM PUBLIC;
GRANT CONNECT ON DATABASE healthcloud_shadow TO healthcloud_owner;
ALTER SCHEMA public OWNER TO healthcloud_owner;

\connect postgres

\echo ''
\echo '  HealthCloud bootstrap complete.'
\echo ''
\echo '  Roles:      healthcloud_owner (migrations), healthcloud_app (runtime, RLS applies)'
\echo '  Databases:  healthcloud_dev, healthcloud_test, healthcloud_shadow'
\echo ''
\echo '  Next: copy .env.example to .env, check the passwords match, then run'
\echo '        pnpm preflight'
\echo ''
