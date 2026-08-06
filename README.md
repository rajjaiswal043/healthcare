# HealthCloud

A multi-tenant healthcare CRM and clinic-management platform for Indian outpatient providers — ABDM-aware, DPDP-compliant, FHIR-aligned.

**Current phase:** Phase 1 — platform foundation. See [`docs/00-execution-plan.md`](docs/00-execution-plan.md).

---

## Getting started

Target: from a clean clone to a running stack in under 30 minutes.

### Prerequisites

Already present on the build machine; listed for a rebuild or a second machine.

|            | Version             | Notes                                                                        |
| ---------- | ------------------- | ---------------------------------------------------------------------------- |
| Node       | ≥ 22 (using 24.5.0) |                                                                              |
| pnpm       | 11.x                | `npm install -g pnpm` — ensure `%APPDATA%\npm` is on your PATH               |
| PostgreSQL | **18**              | Port 5432. Not 13, not 17 — see [ADR-003](docs/adr/ADR-003-postgresql-18.md) |
| Memurai    | any                 | Redis-compatible. Windows service, needs an elevated start                   |
| Git        | any                 |                                                                              |

### 1. Install dependencies

```bash
pnpm install      # from the REPO ROOT, not from an app directory
```

> **Use `pnpm`, never `npm`.** Anywhere you would type `npm run x`, type `pnpm x`.
>
> `npm install` inside `apps/api` or `apps/web` fails outright — they depend on
> `@healthcloud/db` via `"workspace:*"`, which npm does not understand
> (`EUNSUPPORTEDPROTOCOL`). Even if it worked it would drop the security
> overrides in `pnpm-workspace.yaml`, which npm does not read, quietly restoring
> three high-severity advisories.
>
> There is no per-app install step. One `pnpm install` at the root covers every
> workspace.
>
> If `npm` slips in by accident: `rm package-lock.json && pnpm install`.
>
> Why pnpm at all — see [ADR-001](docs/adr/README.md). Short version: it blocks
> dependency install scripts unless explicitly allowlisted, and it makes
> undeclared imports fail immediately instead of years later.

> If you haven't run `git init` yet, the husky hook install is skipped with a notice. Run `pnpm install` again after `git init` to activate the pre-push gate.

### 2. Bootstrap the database — once

Creates two roles and two databases. **Idempotent**: safe to re-run.

```bash
psql -U postgres -h localhost -p 5432 -f infra/local/bootstrap.sql
```

If `psql` isn't on your PATH:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -p 5432 -f infra/local/bootstrap.sql
```

**Why two roles.** `healthcloud_owner` owns tables and runs migrations; `healthcloud_app` is what the application connects as. PostgreSQL exempts a table's owner from its row-level security policies, so connecting as a non-owner is what makes tenant isolation real rather than decorative. Full reasoning in [ADR-005](docs/adr/ADR-005-tenancy-isolation.md).

### 3. Create your `.env`

```bash
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
```

Defaults match the bootstrap passwords. If you overrode those, update the URLs.

### 4. Start Memurai — once, elevated

```powershell
Start-Service Memurai
```

It's set to start automatically, so this is one-time. Not needed until queue work lands, but preflight will flag it until it's up.

### 5. Check the environment

```bash
pnpm preflight
```

This catches the failure modes that native local development introduces: wrong PostgreSQL server, an app role with `SUPERUSER` or `BYPASSRLS` (which would silently void tenant isolation), a test database pointed at dev data, missing env vars, unreachable services. Every failure prints its own fix.

### 6. Seed the demo clinic

```bash
pnpm --filter @healthcloud/db seed:demo
```

Creates two fictional clinics — Sunrise Clinic (240 patients) and Lotus Polyclinic (60) — with realistic Indian names, ages and consent records. Re-run any time; it resets cleanly.

### 7. Run

```bash
pnpm --filter @healthcloud/api dev     # http://localhost:3001
pnpm --filter @healthcloud/web dev     # http://localhost:3000
```

Then follow [docs/demos/phase-1.md](docs/demos/phase-1.md).

---

## Commands

| Command                                   | What it does                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `pnpm dev`                                | Preflight, then start everything                                   |
| `pnpm verify`                             | **The quality gate** — format, lint, typecheck, test, build, audit |
| `pnpm preflight`                          | Environment check on its own                                       |
| `pnpm build`                              | Build all apps and packages                                        |
| `pnpm test`                               | Run tests                                                          |
| `pnpm typecheck`                          | `tsc --noEmit`, strict, everywhere                                 |
| `pnpm format`                             | Apply Prettier                                                     |
| `pnpm --filter @healthcloud/db seed:demo` | Reset the demo clinics                                             |
| `pnpm --filter @healthcloud/db rls:check` | Prove every tenant table is protected                              |
| `pnpm --filter @healthcloud/db test`      | Cross-tenant isolation suite                                       |

`pnpm verify` runs automatically on `git push` via a husky hook. It's the whole CI pipeline, executed locally — see [ADR-016](docs/adr/ADR-016-local-quality-gates.md).

---

## Layout

```
apps/
  api/        NestJS + Fastify
  workers/    BullMQ processors
  web/        Next.js — (staff) and (portal) route groups
packages/
  contracts/  zod schemas + shared types — single source of truth
  api-client/ generated from OpenAPI
  db/         Prisma schema, migrations, RLS policies, seed
  fhir/       FHIR R4 mappers + terminology
  ui/         design system
  observability/
  config/     shared eslint / tsconfig / prettier presets
infra/local/  bootstrap.sql, preflight
docs/
  adr/        architecture decision records
  runbooks/   operational procedures
  demos/      per-phase demo walkthroughs
```

---

## Things worth knowing before you change anything

1. **Tenant isolation is enforced by PostgreSQL, not by application code.** Every tenant-scoped table needs `tenant_id` and an RLS policy. `pnpm verify` fails if one doesn't have both. Don't work around it — that check is the reason a missed `WHERE` clause can't become a data breach.
2. **The app never connects as the database owner.** If you find yourself reaching for `MIGRATION_DATABASE_URL` outside a migration, stop.
3. **`console.log` is a lint error.** Use the structured logger; it carries request, tenant and user correlation IDs, and it doesn't leak patient data to stdout.
4. **Domain tables follow FHIR R4 naming.** It reads verbose against a plain CRUD screen; it's what makes ABDM record exchange an integration later rather than a migration. See [ADR-013](docs/adr/ADR-013-fhir-alignment.md).
5. **Claude does not run `git` or deploy.** Both are Narveer's ([ADR-018](docs/adr/README.md)).

---

## Documentation

|                                                           |                                                        |
| --------------------------------------------------------- | ------------------------------------------------------ |
| [Execution plan](docs/00-execution-plan.md)               | Scope, phasing, decisions, exit criteria               |
| [ADRs](docs/adr/README.md)                                | Why things are the way they are                        |
| [ABDM/NHA runbook](docs/runbooks/abdm-nha-application.md) | Sandbox access — start early, it waits on someone else |
