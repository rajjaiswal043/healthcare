# ADR-003 — PostgreSQL 18 as the database

**Status:** Accepted (6 Aug 2026) — supersedes an unrecorded initial choice of PostgreSQL 17
**Deciders:** Narveer

## Context

The plan initially recommended PostgreSQL 17, and Narveer chose it, on the stated rationale that 17 was the safer bet: proven Prisma support, available on RDS, mature tooling. PostgreSQL 18 was described as carrying ecosystem-lag risk for features we didn't need.

On inspecting the machine before scaffolding, that rationale collapsed:

- **PostgreSQL 17 is not installed.** `C:\Program Files\PostgreSQL\17\` contains only an orphaned `data` directory with no `bin/` — almost certainly a `pg_upgrade` leftover. Choosing 17 meant a fresh install.
- **PostgreSQL 18.2 is installed and running** on port 5432. (PostgreSQL 13 also runs, on 5433, unrelated to this project.)

The "safer" option was therefore the one requiring new software, and the assumed-risky option was already running. That inverted the decision, so the ecosystem-lag concern was checked rather than assumed:

- **Amazon RDS**: PostgreSQL 18 went generally available in November 2025 (starting 18.1), and by February 2026 was shipping minor 18.3. The deployment path is proven, not preview.
- **Prisma**: works against PostgreSQL 18 — confirmed working on Prisma 7.2+. Their supported-databases documentation lags reality, which is a docs problem rather than a compatibility one.

## Decision

**PostgreSQL 18** — 18.2 locally on port 5432, RDS PostgreSQL 18 when we deploy.

Two consequences worth stating explicitly:

1. **UUIDv7 primary keys.** PostgreSQL 18 provides `uuidv7()` natively. Because our schema is overwhelmingly tenant-scoped and time-ordered — patients, encounters, appointments, audit events — time-sortable UUIDs give materially better B-tree index locality than random UUIDv4, and avoid the write amplification that random keys cause on large indexes. We get this for free by being on 18, and it would have been a real loss on 17.
2. **The port is pinned explicitly** in `.env`, never assumed, and the preflight check asserts the server's major version. With PG13 already on 5433 and an orphaned 17 directory present, silently connecting to the wrong server is a plausible failure — so it's made impossible rather than unlikely.

## Alternatives considered

**Install PostgreSQL 17 properly and run it on 5434.** Rejected: work and a port collision to manage, in exchange for an older database, on a rationale that no longer held.

**Use the PostgreSQL 13 already running on 5433.** Rejected: 13 is old, approaching end of life, and lacks capabilities we rely on. It's also evidently in use by something else on this machine, and this project has no business sharing it.

## Consequences

**Good**

- Zero setup — the database we build against is already running.
- UUIDv7, better index behaviour on exactly the access patterns this schema has.
- Current major version, so the supported-version runway is long — relevant for a product intended to run for years under regulatory scrutiny.

**Costs, accepted**

- Prisma's docs don't yet list 18 as supported. If we hit a Prisma-specific issue attributable to 18, the fallback is 17, and nothing in the schema depends on 18 beyond `uuidv7()` — which has a trivial application-side substitute. Small, contained risk.
- The orphaned `PostgreSQL\17\data` directory is left untouched pending confirmation from Narveer that it holds nothing needed. Not this project's to delete.
