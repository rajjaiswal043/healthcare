# Architecture Decision Records

**How this is organised.** The full decision table with rationale lives in [`docs/00-execution-plan.md` §3](../00-execution-plan.md). Duplicating all nineteen entries here as separate files would create two sources of truth that drift apart, which is the usual way ADR directories become worthless.

So: this index is the complete list, and **full ADR files exist only for decisions that are expensive to reverse, that overturned an earlier decision, or whose reasoning isn't obvious from the choice itself.** The rest are one-liners here, and get promoted to a full record the moment someone needs to argue with them.

| #   | Decision                                                                         | Status   | Record                                      |
| --- | -------------------------------------------------------------------------------- | -------- | ------------------------------------------- |
| 001 | Turborepo + **pnpm** workspaces monorepo                                         | Accepted | note below                                  |
| 002 | NestJS on Fastify, TypeScript strict                                             | Accepted | index only                                  |
| 003 | **PostgreSQL 18** (reversed from 17)                                             | Accepted | [ADR-003](./ADR-003-postgresql-18.md)       |
| 004 | Prisma + tenancy client extension                                                | Accepted | index only                                  |
| 005 | **Shared schema + `tenant_id` + Postgres RLS**                                   | Accepted | [ADR-005](./ADR-005-tenancy-isolation.md)   |
| 006 | Redis + BullMQ (Memurai locally)                                                 | Accepted | index only                                  |
| 007 | **One Next.js app with route groups** (revised from two apps)                    | Accepted | [ADR-007](./ADR-007-single-frontend-app.md) |
| 008 | TanStack Query (server state) + Zustand (UI state)                               | Accepted | index only                                  |
| 009 | Tailwind + shadcn/ui in `packages/ui`                                            | Accepted | index only                                  |
| 010 | JWT + rotating refresh in httpOnly cookies; TOTP MFA for admin; OTP for patients | Accepted | index only                                  |
| 011 | Permission-string RBAC + object-level scoping                                    | Accepted | index only                                  |
| 012 | DTOs → OpenAPI → generated client; zod contracts package                         | Accepted | index only                                  |
| 013 | **FHIR R4 as a modelling constraint, not a storage format**                      | Accepted | [ADR-013](./ADR-013-fhir-alignment.md)      |
| 014 | Storage driver interface: local disk in dev, S3 later                            | Accepted | index only                                  |
| 015 | pino + OpenTelemetry + Sentry; `console.log` banned                              | Accepted | index only                                  |
| 016 | **`pnpm verify` as a local pre-push gate instead of CI**                         | Accepted | [ADR-016](./ADR-016-local-quality-gates.md) |
| 017 | **Native local services, no Docker**                                             | Accepted | [ADR-017](./ADR-017-native-local-dev.md)    |
| 018 | Narveer owns git and deploys; Claude produces artifacts only                     | Accepted | see ADR-016                                 |
| 019 | AWS ap-south-1, single EC2 + RDS first, ECS later                                | Accepted | index only                                  |

## Note on ADR-001 — why pnpm rather than npm

npm workspaces would have worked. Two properties decided it, and neither is
about speed:

1. **Dependency install scripts are blocked unless allowlisted.** An install
   script is arbitrary code execution from a package nobody has read. pnpm
   requires each one to be named in `pnpm-workspace.yaml` with a reason;
   currently five are (`prisma`, `@prisma/engines`, `esbuild`, `@swc/core`,
   `sharp`). npm runs every one of them silently. For a system holding patient
   data, a reviewed list of what may execute at install time is worth the
   friction.
2. **Undeclared imports fail immediately.** npm's flat `node_modules` lets a
   package import something it never declared; it works until an unrelated
   version bump moves that dependency, and then it breaks somewhere confusing.
   pnpm's layout turns that into an error at the point of the mistake.

Explicitly NOT reasons: workspaces (npm has them), overrides (npm has them),
speed and disk usage (irrelevant at this scale).

Cost, stated honestly: one more tool to install, and configuration that lives in
`pnpm-workspace.yaml` rather than `package.json` — which is genuinely easy to
get wrong.

## Conventions

- ADRs are **immutable once accepted**. A changed mind means a new ADR that supersedes the old one, with the old one marked `Superseded by ADR-NNN` and left in place. ADR-003 is already an example of this pattern.
- Status is one of `Proposed`, `Accepted`, `Superseded by ADR-NNN`, `Deprecated`.
- If you find yourself explaining the same decision twice in code review or in a comment, that's the signal to write the full record.
