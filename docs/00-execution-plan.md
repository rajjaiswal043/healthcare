# Health Cloud CRM — Execution Plan v2 (solo build)

Derived from: `BRD_Health_Cloud_CRM_India_v0.9`, `Enterprise Full-Stack Master Checklist`, `Full-Stack Industry-Standard Checklist`.

**Status:** decisions settled, awaiting go-ahead to start Phase 1.

---

## 0. Settled decisions

| #   | Question             | Answer                                                                                                                                          |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Team                 | **Solo** — you + me. You review, push, deploy.                                                                                                  |
| 2   | Hosting              | **AWS ap-south-1, single EC2 + RDS first**, ECS Fargate later. Local-first: no cloud spend during Phase 1.                                      |
| 3   | Tenancy              | **Shared schema + `tenant_id` + Postgres Row-Level Security.**                                                                                  |
| 4   | Database             | **PostgreSQL 18.2** (see §0.1 — 17 turned out not to be installed). **Memurai** for Redis.                                                      |
| 5   | Docker in production | **Deferred to Phase 2.** Phase 1 writes nothing container-specific either way.                                                                  |
| 6   | ABDM sandbox         | **Not started.** I write the NHA application runbook in Phase 0; you submit it while I build Phase 1.                                           |
| 7   | Local dev            | **Native services, no Docker.**                                                                                                                 |
| 8   | Git & deploys        | **You own both.** I never run `git` or deploy.                                                                                                  |
| 9   | **Scope**            | **Clinic-first (Option B), confirmed.** Modules 3–6 (care plans, telehealth, IPD, claims, referral CRM) are **parked** until v1.0 Clinic ships. |
| 10  | **Demo-ability**     | **A hard requirement, not a nice-to-have.** Every phase must end in something you can show a prospective clinic on a laptop. See §2.1.          |

Still open, needed later, not blocking: product name (BRD OQ-01, before UI freeze), payment gateway (OQ-03, before billing), video SDK (OQ-04, parked with telehealth), design direction (proceeding with shadcn/ui + Tailwind unless told otherwise).

### 0.1 Verified local environment (6 Aug 2026)

Checked rather than assumed, because two assumptions turned out to be wrong:

| Component           | State                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / npm / pnpm   | 24.5.0 / 11.5.1 / **11.20.0**                                                                                                                                 |
| **PostgreSQL 18.2** | **Running on port 5432** — this is our database                                                                                                               |
| PostgreSQL 13       | Running on port 5433 — unrelated, left alone                                                                                                                  |
| PostgreSQL 17       | **Not installed.** `C:\Program Files\PostgreSQL\17\` holds only an orphaned `data` directory (no `bin/`), almost certainly a `pg_upgrade` leftover. See §0.2. |
| Memurai (Redis)     | Installed, **currently stopped** — needs an elevated `Start-Service Memurai`. Not required until queues land.                                                 |
| Auth method         | `scram-sha-256` — so `bootstrap.sql` needs your `postgres` password; **you** run it, I never hold it.                                                         |
| Git                 | 2.51.0                                                                                                                                                        |

**PATH fix applied:** `%APPDATA%\npm` was missing from your user PATH, which is why `pnpm` (and your existing global `codex` / `eas`) didn't resolve. Appended to the User scope — reversible, no admin needed.

### 0.2 Why PostgreSQL 18 instead of the 17 you chose

You picked 17 on my recommendation, and my rationale was ecosystem safety. That rationale didn't survive contact with the facts:

- **17 isn't on this machine.** Choosing it means a fresh install for no gain.
- **RDS**: PostgreSQL 18 went GA on Amazon RDS in Nov 2025, now shipping minor 18.3 — the deployment path is proven.
- **Prisma**: works against PG18 (confirmed on 7.2+); only their docs page lags.
- **Bonus**: PG18 gives us **UUIDv7**, which has materially better index locality than UUIDv4 on tenant-scoped tables — a real win for a schema where nearly every table is keyed by tenant.

**Left for you to decide, no rush:** the orphaned `PostgreSQL\17\data` directory. I haven't touched it — it may hold pre-upgrade data. Worth confirming it's redundant before you delete it.

---

## 1. What we are building, in engineering terms

A **multi-tenant, India-hosted SaaS** for 10–150-bed hospitals and clinics, storing **sensitive personal health data** under DPDP, with a data model that maps to **FHIR R4** so ABDM M2/M3 and NHCX are later integrations rather than rewrites.

Three properties drive every decision below, in this order:

1. **Tenant isolation is a security boundary, not a filter.** A forgotten `WHERE tenant_id = ?` is cross-hospital PHI leakage — a ₹250 crore-class DPDP event (BRD §7.1). The database enforces it, not developer discipline. **This matters more now that you're solo: there is no second reviewer.**
2. **Auditability and consent are schema, not features.** "Who read this record, under which consent" cannot be retrofitted. It lands in the platform core before the first domain table.
3. **FHIR alignment is a naming and modelling constraint from day one** — not a JSON blob store (BRD §7.6, §11.1).

---

## 2. Scope — settled: clinic-first

All six v1 modules, at the quality bar in your two checklists, is **roughly 18–24 months for one engineer**. That is the honest number. The BRD says 1–3 months (§2) and 3–6 months (§14.1 A-01); neither was written for a team of one.

**Decided: Option B, clinic-first.** Everything outside it is parked — not cancelled, not designed around, simply not built until v1.0 Clinic ships and real clinics are using it.

**Parked until after v1.0 Clinic:** IPD and bed management (Module 2's inpatient half), billing beyond OPD, insurance pre-auth and claims (Module 5), care coordination and care plans (Module 3), telehealth (Module 4), referral and provider network CRM (Module 6), analytics suite, Hindi pack, ABDM M2/M3/M4.

What "parked" means concretely: I won't build them, but I also won't design in a way that blocks them. The FHIR-shaped data model (ADR-013), the consent subsystem (§4.3) and the tenancy foundation are all built once, correctly, because retrofitting those is what actually kills projects. Adding a parked module later is then feature work, not surgery.

**Ship target — v1.0 "Clinic":**

Platform core · Patient 360 · ABHA M1 · appointments, queue and tokens · OPD consult + e-prescription · OPD billing and payments · WhatsApp/SMS notifications · DPDP consent and rights · patient portal booking. **~7–9 months solo.**

Why this split: clinics don't need bed boards or TPA claims, so the parked modules aren't blocking your first real users. It gets working software in front of someone around month 8 rather than month 20, and that feedback reshapes everything after it. It also matches how your own BRD sequences R1.0.

Sequencing after v1.0 Clinic gets re-planned from pilot learnings rather than guessed at now — but the likely order is IPD and full billing, then insurance claims, then care plans and referral CRM, then telehealth and analytics.

### 2.1 Demo-ability as a build constraint

You asked for it demo-able, so I'm treating that as a requirement with teeth rather than a hope:

- **A seeded demo tenant exists from Phase 1** — a realistic fictional clinic with doctors, schedules, a service catalogue and a few hundred patients with plausible Indian names, ages and histories. Not three rows called "Test Patient". It's re-seedable with one command, so a demo can never be wrecked by yesterday's poking.
- **Every phase ends in a demo script** — `docs/demos/phase-N.md`, a walkthrough you can follow in front of a clinic owner without touching a terminal or apologising for anything.
- **No visible dead ends.** A parked feature is absent, not a greyed-out button that invites "and what does that do?" Half-built UI is worse than missing UI in a sales conversation.
- **Demo data is obviously fictional.** Names, mobiles and ABHA-style identifiers are clearly synthetic, so a demo build can never be confused with real patient data — which also keeps demos outside DPDP's blast radius.

---

## 3. Technology decisions

Each becomes an ADR in `docs/adr/`.

| #       | Decision      | Choice                                                                                                                                                | Why / rejected                                                                                                                                                                                                                                                          |
| ------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 | Repo layout   | **Turborepo + pnpm workspaces** monorepo                                                                                                              | Shared TS types across Next.js/NestJS, contract drift caught at build time. Rejected Nx (heavier than needed for solo), polyrepo (drift).                                                                                                                               |
| ADR-002 | Backend       | **NestJS on Fastify**, TypeScript strict                                                                                                              | Checklist §2. DI makes tenancy/audit interception clean; modules map to BRD modules.                                                                                                                                                                                    |
| ADR-003 | Database      | **PostgreSQL 18** — native locally (18.2, port 5432), RDS later                                                                                       | RLS, declarative partitioning, JSONB for FHIR extensions, **UUIDv7** primary keys. Rationale and the reversal from 17 in §0.2.                                                                                                                                          |
| ADR-004 | ORM           | **Prisma** + tenancy client-extension                                                                                                                 | Type-safe, strong migrations. Extension issues `SET LOCAL app.tenant_id` per transaction (§4.1).                                                                                                                                                                        |
| ADR-005 | **Tenancy**   | **Shared schema + `tenant_id` + RLS, `FORCE ROW LEVEL SECURITY`, app connects as non-owner role**                                                     | Defence in depth: app guard _and_ DB policy. Scales to ≥100 tenants (NFR-02) on one migration run, no per-tenant fixed cost (§14.3). Rejected schema-per-tenant (migration fan-out, pool pressure) and DB-per-tenant.                                                   |
| ADR-006 | Cache + async | **Redis + BullMQ** — Memurai locally, ElastiCache later                                                                                               | NFR-01: booking/billing never block on notification delivery. Also drives reminders (T−24h/T−2h), care-plan scheduling, exports, doc scanning.                                                                                                                          |
| ADR-007 | Frontend      | **One Next.js 15 app** (`apps/web`) with `(staff)` and `(portal)` route groups                                                                        | **Revised for solo.** Two separate apps was a team-sized choice — it doubles config, build, and deploy surface. Route groups give per-group middleware, auth, and CSP, which is all we actually needed. Split later if the portal's release cadence genuinely diverges. |
| ADR-008 | Client state  | **TanStack Query** (server state) + **Zustand** (local UI state)                                                                                      | Both checklists call this out. No hand-rolled `useEffect` fetching.                                                                                                                                                                                                     |
| ADR-009 | UI kit        | **Tailwind + shadcn/ui**, wrapped in `packages/ui` with our tokens                                                                                    | **Solo cannot afford a bespoke design system.** We own the code (it's copied in, not a dependency), so accessibility and behaviour stay ours to fix.                                                                                                                    |
| ADR-010 | Auth          | Short-lived JWT + rotating refresh in **httpOnly, Secure, SameSite cookies**; TOTP MFA mandatory for admin (FR-USR-02); patient portal via mobile OTP | Never localStorage. CSRF tokens on cookie-auth mutations.                                                                                                                                                                                                               |
| ADR-011 | Authorization | Permission strings (`patient:read`, `bill:discount:approve`) + **object-level scoping** (tenant → location → ownership)                               | FR-USR-01 needs tenant-customisable permissions to module/action level. Checklist §4: prevent IDOR, not just "is logged in".                                                                                                                                            |
| ADR-012 | API contract  | NestJS DTOs → **OpenAPI** → generated client in `packages/api-client`; **zod** schemas in `packages/contracts` shared with the frontend               | One source of truth; contract mismatch is a build failure.                                                                                                                                                                                                              |
| ADR-013 | **FHIR**      | Relational tables **named and shaped to FHIR R4 concepts** + a `packages/fhir` mapper layer                                                           | Rejected "FHIR JSON as truth": destroys the CRM query workloads you need (AR ageing, referral analytics, queue boards). The mapper is what makes M2/M3/NHCX an integration (§7.6).                                                                                      |
| ADR-014 | Files         | Local-disk driver in dev, S3 later; server-brokered presigned URLs; malware scan before a doc becomes visible                                         | FR-DOC-01; NFR-06 no vendor keys in the browser.                                                                                                                                                                                                                        |
| ADR-015 | Observability | pino structured logs (request/tenant/user/correlation IDs) + OpenTelemetry + Sentry                                                                   | Checklist §8. `console.log` banned by lint rule.                                                                                                                                                                                                                        |
| ADR-016 | Quality gates | **`pnpm verify`** — lint → typecheck → test → build → migrate-check → RLS-policy check → `npm audit`, on a **pre-push hook**                          | You own git (ADR-018), so the gate runs before a push rather than on a runner after it. Same gates, same receipts. A disabled GitHub Actions workflow ships in the repo for the day you want CI.                                                                        |
| ADR-017 | Local dev     | **Native, no Docker** — local Postgres 17, Memurai, disk storage, `maildev`                                                                           | Prod parity preserved by driver interfaces (§5.1), not containers.                                                                                                                                                                                                      |
| ADR-018 | Git & deploy  | **You push and deploy. I produce code, migrations, artifacts, runbooks.**                                                                             | Revisit whenever you want automation.                                                                                                                                                                                                                                   |
| ADR-019 | Infra         | **AWS ap-south-1, single EC2 + RDS + S3 in Phase 2**, ECS Fargate when load justifies it                                                              | NFR-06 residency. Terraform written in Phase 2, structured so the Fargate move is a module swap, not a migration. **No infra code in Phase 1.**                                                                                                                         |

---

## 4. The three things that must be right before any feature code

### 4.1 Tenancy enforcement

```
Request → session → TenantContext (AsyncLocalStorage)
        → prisma.$transaction(tx => {
              SET LOCAL app.tenant_id = <tenant>;
              SET LOCAL app.user_id   = <user>;
              ...handler...
          })
        → RLS policy on EVERY table:
              tenant_id = current_setting('app.tenant_id')::uuid
```

- The app's DB role is **not** the table owner, and every table has `FORCE ROW LEVEL SECURITY`.
- **`pnpm verify` fails if any table lacks `tenant_id` or an RLS policy.** This check is written before the first table exists.
- An integration suite proves cross-tenant reads return zero rows even when the service layer is deliberately handed a foreign ID.

### 4.2 Audit + transactional outbox

- Append-only `audit_event`, **monthly partitions**, ≥ 1 year online (NFR-07, §7.5 CERT-In).
- An interceptor records every read/write of patient-identifiable data: actor, tenant, location, patient, resource, action, changed fields, IP/UA, and `reason` for break-glass (FR-USR-04).
- Domain writes emit events into an **outbox in the same transaction**; a worker drains it to BullMQ. This is how notifications, care-plan scheduling and referral loop-closure stay off the request path (NFR-01).

### 4.3 Consent as a first-class subsystem

Modelled once, serving DPDP **and** ABDM (the synergy your §7.6 identified):

- `consent_purpose` — care delivery, communications/marketing, ABDM linking, telehealth
- `consent_notice` — versioned, per purpose, per language, plain language
- `consent_record` — patient, purpose, notice version, granted/withdrawn timestamps, capturing user, proof
- `rights_request` — access / correction / erasure / grievance, with identity verification, owner, SLA timer, closure reason (FR-CON-03)
- `@RequiresConsent('communications.marketing')` guard — the notification engine cannot be invoked without passing it

Guardian-linked profiles for minors (FR-P36-16) are part of this model, not bolted on.

---

## 5. Repository structure

```
healthcloud/
├── apps/
│   ├── api/            # NestJS + Fastify
│   ├── workers/        # BullMQ processors (shares api modules, separate bootstrap)
│   └── web/            # Next.js 15 — (staff) and (portal) route groups
├── packages/
│   ├── contracts/      # zod schemas + shared types — single source of truth
│   ├── api-client/     # generated from OpenAPI
│   ├── db/             # prisma schema, migrations, RLS policies, seed
│   ├── fhir/           # FHIR R4 mappers + terminology (ICD-10, SNOMED, LOINC)
│   ├── ui/             # design system: tokens + shadcn-based primitives
│   ├── observability/  # logger, tracing, metrics
│   └── config/         # eslint / tsconfig / prettier / tailwind presets
├── infra/
│   └── local/          # bootstrap.sql (roles + dev/test DBs), preflight, env template
└── docs/
    ├── adr/            # ADR-001…019
    ├── runbooks/       # ABDM/NHA application, DLT + WhatsApp registration, onboarding
    └── traceability.md # BRD FR-ID → module → test
```

**API module layout** — `platform/` is domain-agnostic; the BRD modules sit on top:

```
apps/api/src/
├── platform/    tenancy · auth · rbac · audit · consent · outbox
│                notifications · documents · masterdata · health
├── clinical/    patients · encounters · prescriptions · care-plans
├── scheduling/  slots · appointments · queue/token · check-in
├── revenue/     tariffs · billing · payments · pre-auth · claims · AR
├── network/     referrers · referrals · camps · empanelment
├── telehealth/  sessions · consent · guardrails
└── analytics/   read models · dashboards · exports
```

Controllers logic-free, logic in services, data access in repositories — enforced by dependency-cruiser rules, not by memory.

### 5.1 Local development — native, no Docker

Every external dependency sits behind a **driver interface**, so local and production differ by configuration rather than code path.

| Concern        | Local (native, Windows)                     | Later (ap-south-1)           |
| -------------- | ------------------------------------------- | ---------------------------- |
| Database       | **PostgreSQL 18.2**, native, port 5432      | RDS PostgreSQL 18            |
| Cache + queue  | **Memurai**                                 | ElastiCache Redis            |
| Object storage | `LocalDiskStorageDriver` → `.data/uploads/` | `S3StorageDriver`, presigned |
| Mail           | `maildev` (pure Node)                       | SES-class provider           |
| Malware scan   | `NoopScanDriver` (dev-only, loudly flagged) | real scan step               |
| WhatsApp / SMS | console + delivery-log adapters             | BSP + DLT-registered sender  |

Consequences handled explicitly:

- **RLS needs two DB roles.** The migration owner owns the tables; the app connects as a separate non-owner role that policies actually apply to. `infra/local/bootstrap.sql` creates both roles and both databases, idempotently, run once during setup.
- **Two databases:** `healthcloud_dev` and `healthcloud_test`. Integration tests truncate and re-seed `healthcloud_test` per run and never touch dev data.
- **`pnpm dev` is still one command**, preceded by a **preflight** that checks Postgres and Memurai are reachable, that the server really is major version 18, that migrations are current, and that env vars parse — printing exact remediation when they aren't.
- **Port is pinned explicitly** in `.env` (5432), never assumed — you have PG13 on 5433 alongside, and the preflight asserts the major version so a future install can't silently steal the port.
- **Memurai must be started** before queue work begins: `Start-Service Memurai` from an elevated PowerShell (it's set to Automatic, so this is one-time).

---

## 6. Phase 1 — the foundation

**Goal:** a secure, observable, _empty_ platform plus one thin vertical slice proving every layer. When Phase 1 is done, adding a module is ordinary work rather than architecture.

**Solo-adjusted:** no infra code, no cloud, no CI runner, one frontend app, shadcn instead of bespoke components. Estimated **5–7 weeks solo.**

### 6.1 Deliverables

**Track A — Foundation**

1. Monorepo scaffold, Turborepo pipeline, pnpm workspaces, strict TS, ESLint + Prettier, dependency-cruiser rules.
2. Native local setup: `bootstrap.sql`, preflight, zod-validated env module, `pnpm dev` running api + workers + web against your Postgres 17 and Memurai.
3. `pnpm verify` gate + husky pre-push hook; disabled GitHub Actions workflow committed for later.
4. ADR-001…019 written.
5. **`docs/runbooks/abdm-nha-application.md`** — what NHA needs, so you can submit during Phase 1.

**Track B — Platform core** 6. Prisma bootstrap + **RLS framework + the verify-gate check that enforces it**. 7. Tenancy context + tenant-scoped Prisma extension + **cross-tenant isolation test suite**. 8. Auth: login, sessions, refresh rotation, TOTP MFA, password policy, idle timeout, session list + remote sign-out (FR-USR-02/03). 9. RBAC engine, seeded roles for all nine BRD §6 personas, permission guard, object-level scoping. 10. Audit interceptor + partitioned `audit_event` + admin-visible audit view (FR-P36-19). 11. Consent subsystem (§4.3) + rights-request skeleton. 12. Transactional outbox + workers app + one live consumer. 13. Notification engine skeleton: templates, channel-adapter interface, mock adapters, delivery log, fallback chain. (Real WhatsApp/DLT wiring waits for the customer registrations in BRD A-03.) 14. Document service: presigned upload, type/size limits, scan hook, visibility flag, sharing audit. 15. Master data: tenant/location/department/user setup + admin screens. 16. Global exception filter, standard error envelope, structured logging, health endpoints, Sentry, OTel. 17. `packages/ui`: tokens, WCAG 2.1 AA primitives, keyboard-first form patterns, loading/empty/error states.

**Track C — Walking skeleton** 18. **Patient registration + search** end-to-end: FR-P36-01, -02, -03 (fuzzy dedupe), -05, -19, plus consent capture (FR-CON-01). Single-screen, keyboard-first, <2-minute target. Exercises the entire path: RSC → typed client → Fastify → guard → RBAC → tenant tx → RLS → Prisma → audit → outbox → worker → mock notification. 19. **Seeded demo tenant** per §2.1 — a fictional clinic, re-seedable with one command, with enough realistic data that search and dedupe are actually exercised. 20. **`docs/demos/phase-1.md`** — the walkthrough you can run in front of someone.

### 6.2 Exit criteria — demonstrable, not asserted

- [ ] Cross-tenant isolation suite green, including deliberate-attack cases.
- [ ] A table without `tenant_id` + RLS policy **fails `pnpm verify`**.
- [ ] `pnpm dev` from a clean clone brings everything up, with preflight failing loudly and actionably.
- [ ] `pnpm verify` green; pre-push hook blocks a red push.
- [ ] Register → search → audit slice working locally; p95 search < 1.5 s on a realistically-sized seed, not a toy fixture.
- [ ] Consent captured at registration, visible in a consent register, withdrawal honoured.
- [ ] Audit log shows every read and write of the demo patient with actor and timestamp.
- [ ] Lighthouse ≥ 95, a11y 100, axe zero violations on the registration screen.
- [ ] Structured logs carry request/tenant/user/correlation IDs; Sentry proven with a synthetic error.
- [ ] `docs/adr/` and `docs/runbooks/` populated; README gets you productive on a clean Windows machine in under 30 minutes.
- [ ] NHA sandbox application submitted (your action, my runbook).
- [ ] **Demo runs clean**: `pnpm demo:reset` then the `docs/demos/phase-1.md` walkthrough, start to finish, nothing broken or half-built on screen.

Nothing from Modules 2–6 ships in Phase 1. That is deliberate.

---

## 7. After Phase 1 — road to v1.0 Clinic

| Phase                    | Contents                                                                                                                                                                   | Exit gate                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **2 — OPD core**         | Patient 360 complete (timeline, banner, allergies, vitals, documents, merge), scheduling + slots + token/queue, OPD consult + e-prescription (ICD-10, Schedule H/H1 flags) | A real clinic day runs end-to-end on it                                                                      |
| **3 — Money + messages** | OPD billing, tariffs, GST treatment, payments, receipts, daily close; real WhatsApp/SMS/email channels; patient portal booking                                             | First rupee collected through the platform; reminders flowing; backup/restore rehearsed on live RDS (NFR-04) |
| **4 — ABHA M1**          | ABHA create/verify/link on ABDM V3 sandbox → production, QR intake, linkage reporting                                                                                      | M1 flows working against sandbox, production path agreed                                                     |
| **5 — v1.0 hardening**   | DPDP rights + breach workflows, retention engine, performance pass, first deploy to EC2, pilot onboarding runbook                                                          | **v1.0 "Clinic" live at first design partner**                                                               |
| 6+                       | **Parked** — IPD, full billing, claims, care plans, referral CRM, telehealth, analytics. Re-planned from pilot learnings once v1.0 Clinic is in real use.                  |                                                                                                              |

Every phase from 2 onward ends with an updated `docs/demos/phase-N.md`, so there is always something current to show.

ABDM M2/M3 (FT + WASA certification) and NHCX M4 stay where the BRD puts them — its own Phases 2 and 3, well after v1.

---

## 8. How the checklists are enforced

Every gate runs inside **`pnpm verify`**, blocked at pre-push. The honest tradeoff: a local gate can be bypassed with `--no-verify` in a way CI can't. Mitigation is that `verify` is fast and the hook is on by default; the day that stops being enough, the committed workflow file turns the identical gates into CI with no rewrite.

| Checklist item                                       | Enforcement                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Semantic HTML, WCAG 2.1 AA                           | `eslint-plugin-jsx-a11y` + axe assertions in Playwright + Lighthouse budget in `verify`            |
| Server Components by default                         | Lint rule flagging `"use client"` without a justification comment                                  |
| React Query for server state                         | Lint rule banning `fetch` inside `useEffect`                                                       |
| Hooks discipline, stable keys                        | `eslint-plugin-react-hooks` at error level                                                         |
| Controllers logic-free                               | Dependency-cruiser: a controller may not import a repository                                       |
| DTO validation                                       | Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`                           |
| Helmet, CORS allow-list, throttler, httpOnly cookies | Wired in Phase 1; a security integration test asserts each header                                  |
| Secrets validated on boot                            | zod env module; the app refuses to start otherwise                                                 |
| TypeScript strict                                    | `strict: true`, no implicit any, typecheck gate                                                    |
| API documented                                       | OpenAPI generated from DTOs; drift check fails `verify`                                            |
| Dependency scanning                                  | `npm audit` in the gate; Dependabot once the repo is on GitHub                                     |
| N+1 eliminated, indexed                              | Query-count assertions in integration tests; `pg_stat_statements` enabled locally                  |
| Pagination everywhere                                | Shared paginated-response type; lint rule on list endpoints                                        |
| Idempotency on critical writes                       | Idempotency-key middleware on payments, bill finalisation, claim submission                        |
| PII, retention, erasure                              | Consent + retention engine (§4.3); erasure honours statutory retention with recorded justification |
| Backups & DR                                         | Phase 3 gate, once RDS exists — rehearsed restore with written evidence                            |

**Deliberate deviations, with reasons:**

- _"Deploy the frontend to Vercel/Cloudflare"_ — **rejected.** NFR-06 requires Indian residency and the staff app renders PHI server-side. Runs in ap-south-1.
- _"SSG/ISR for public pages"_ — applies to marketing pages only; every authenticated screen is inherently dynamic.
- _"Kubernetes"_ — single EC2 for Phase 2 (ADR-019); ECS when load justifies it; K8s likely never at this scale.
- _"docker-compose one-command local stack"_ — **adapted, not skipped.** Same outcome (one command, documented onboarding) via native services + preflight.
- _"CI/CD pipeline"_ — **adapted** per ADR-016/018. Identical gates, local trigger.

**Testing strategy, solo-adjusted.** Not chasing a coverage number. Heavy integration testing on the platform core (tenancy, RLS, auth, RBAC, consent, audit) and every money path; unit tests on business rules with real branching; Playwright on a handful of critical journeys only. Rationale: with one engineer, tests are the regression safety net that a reviewer would otherwise be — so they go where a silent break would be most expensive.

---

## 9. What happens the moment you say go

1. Write ADR-001…019 into `docs/adr/`.
2. Write `docs/runbooks/abdm-nha-application.md` so you can start the NHA lead time immediately.
3. Scaffold the monorepo, tooling, and native local setup — **files only; you run `git init` and the first push.**
4. Land the tenancy + RLS foundation **with its isolation test suite**, before any domain table exists.
5. Work down §6.1 in order, stopping at each exit criterion to show you it actually works.

No feature code before the isolation suite is green.
