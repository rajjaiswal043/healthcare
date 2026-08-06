# ADR-017 — Native local services, no Docker in development

**Status:** Accepted (6 Aug 2026)
**Deciders:** Narveer
**Related:** ADR-003 (PostgreSQL 18), ADR-006 (Redis/BullMQ), ADR-014 (storage drivers)

## Context

The checklists recommend a `docker-compose` one-command local stack bringing up API, database and Redis together — good advice, and the usual way to keep local and production environments identical.

Narveer requested native local services and no Docker for development. Docker is installed on the machine but is not to be used for the local workflow. Whether production uses containers is deferred to Phase 2.

The concern this raises is real and worth naming: containers are how most teams prevent **environment drift** — the class of bug where something works on the developer's machine and fails in production because a version, locale, or filesystem behaviour differs. Dropping containers locally means that risk has to be managed another way, on Windows, against a Linux deployment target.

## Decision

**All local dependencies run as native Windows services, and every external dependency sits behind a driver interface so that local and production differ by configuration rather than by code path.**

| Concern        | Local                                         | Production                   |
| -------------- | --------------------------------------------- | ---------------------------- |
| Database       | PostgreSQL 18.2, native, port 5432            | RDS PostgreSQL 18            |
| Cache + queue  | Memurai (Redis-compatible Windows service)    | ElastiCache Redis            |
| Object storage | `LocalDiskStorageDriver` → `.data/uploads/`   | `S3StorageDriver`, presigned |
| Mail           | `maildev` (pure Node)                         | SES-class provider           |
| Malware scan   | `NoopScanDriver`, dev-only and loudly flagged | real scanner                 |
| WhatsApp / SMS | console + delivery-log adapters               | BSP + DLT-registered sender  |

Compensating controls, since containers aren't doing this work for us:

1. **A preflight check** runs before `pnpm dev`. It verifies Postgres is reachable, **asserts the server's major version is 18**, checks Memurai, confirms migrations are current, and validates env vars — printing exact remediation for each failure instead of letting the app fail obscurely later.
2. **The port is pinned explicitly**, never defaulted. PostgreSQL 13 also runs on this machine (5433) and an orphaned 17 data directory exists, so "connected to the wrong database" is a plausible failure that the version assertion makes impossible.
3. **`infra/local/bootstrap.sql`** creates both database roles (owner and app — required by ADR-005's RLS) and both databases (`healthcloud_dev`, `healthcloud_test`), idempotently. This is what a container init script would otherwise have done.
4. **Two databases, not one.** Integration tests truncate and re-seed `healthcloud_test`, never touching dev data.
5. **Nothing in the application assumes a filesystem layout, path separator, or locale.** Path handling goes through Node's `path`; anything that would behave differently on Linux is treated as a defect.

## Alternatives considered

**docker-compose as the checklists recommend.** Rejected per Narveer's explicit preference. Recorded rather than argued: the compensating controls above address the specific risk that containers were mitigating.

**WSL2 for the whole stack.** Would give Linux parity while keeping Docker out. Not chosen — it adds a filesystem boundary and a second environment to reason about, for parity benefits that mostly matter at deploy time, which is deferred anyway.

## Consequences

**Good**

- No container runtime in the development loop; faster start, less memory, fewer moving parts.
- Uses the PostgreSQL and Memurai installations already present.
- The driver interfaces are valuable in their own right — they're what make the storage and notification layers testable without stubbing HTTP.

**Costs, accepted**

- **Environment drift is a live risk**, managed by preflight and by disciplined path/locale handling rather than eliminated. It will first bite at the initial Linux deploy; that's expected and the deploy runbook accounts for it.
- One-time manual setup — run `bootstrap.sql`, start Memurai from an elevated shell — instead of `docker compose up`. Documented in the README and made idempotent.
- Onboarding a second developer means following the README rather than running one command. Acceptable while the team is one person; a reason to revisit if that changes.

**Reversibility**
Good. Because every dependency is already behind a driver interface and no code assumes a host layout, adding a compose file later is additive — nothing needs unwinding.
