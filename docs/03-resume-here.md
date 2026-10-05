# Resume here — state as of 12 Aug 2026

A handover note to myself. What is built, what is not, and what to pick up next.

---

## 1. Getting running from cold

```bash
pnpm install                                   # from the repo root
pnpm preflight                                 # environment check, fails loudly with fixes
pnpm --filter @healthcloud/db seed:demo        # patients, roles, schedules, queue, formulary
pnpm --filter @healthcloud/api dev             # :3001
pnpm --filter @healthcloud/web dev             # :3000
```

Sign in at http://localhost:3000/login as `doctor@demo.local` / `demo1234`, clinic
`sunrise-clinic`. Also `reception@demo.local`, `nurse@demo.local` and
`admin@demo.local`. **No authenticator prompt** — MFA is off everywhere; see
section 3. The clinic slug has to be typed: the login screen no longer pre-fills
it, and the demo-account panel that used to list these addresses was removed on
26 Aug 2026, so this note is now the only place they are written down.

The platform console is a separate realm at http://localhost:3000/platform/login.
Create an account for it with
`pnpm --filter @healthcloud/db platform:user -- <email> "<name>"`.

**Run the API with `dev`, not `start`.** `start` serves whatever is in `dist`,
which silently means new routes 404 while old ones work — an hour was lost to
that on 7 Aug.

After clicking through the queue, `pnpm --filter @healthcloud/db seed:scheduling`
restores it on its own. Both that and `seed:formulary` are re-runnable.

---

## 2. What works, end to end

Register a patient → book (token issued here) → pay → check in → the waiting list
in arrival order → open the consultation → vitals → complaint, history,
examination → ICD-10 diagnosis → prescription from the formulary → sign → print.
Verified in a browser, not only by test.

| Module                     | State                                                     |
| -------------------------- | --------------------------------------------------------- |
| Tenancy, RLS, auth, RBAC   | Done. 20 tenant tables under FORCE RLS, `pnpm rls:check`. |
| Patient 360, registration  | Done, including the detail page and visit history.        |
| Appointments and OPD queue | Done. `docs/01-appointments-opd-queue-plan.md`.           |
| Consultation, prescription | Done. `docs/02-consultation-plan.md`.                     |
| Billing — OPD, pay-first   | Done. `docs/04-billing-plan.md`.                          |
| Tokens, recall, screen     | Done, all three phases. `docs/05-token-queue-plan.md`.    |
| Staff management           | Done. Settings → Staff. `docs/06-platform-...-plan.md`.   |
| Roles and permissions      | Done. Settings → Roles. `docs/06`, section 9.             |
| Platform tier, onboarding  | Done. `/platform`. Per-clinic logo upload deferred.       |
| IPD, claims, ABDM          | Not started, deliberately parked.                         |

**The clinic is pay-first.** Check-in refuses to add a patient to the queue while
money is outstanding — that is the rule Narveer confirmed, and it lives in
`AppointmentsService.checkIn` via `BillingService.blockingReason`, not in the UI.
Since 12 Aug the gate withholds a _position_, not a token: tokens are issued at
booking, and what an unpaid visit lacks is `readyAt`.
Billing is opt-in per tenant: a clinic with no priced services raises no invoices
and the gate stays open, which is how the pre-billing tests still pass.

`pnpm verify` exits 0: 150 API integration tests, 13 cross-tenant isolation tests,
format, lint, typecheck, build, migration drift, RLS coverage, audit.

Everything through billing is committed on branch `Aug7HC` as `77521df`
("Aug 7th Changes"), on top of `21d7f97`. Not merged to `main`, not pushed — that
is Narveer's call (ADR-018).

---

## 3. Things that will bite, and did

**`prisma migrate reset` refuses to run when Claude Code invokes it.** A guard on
Prisma's side, and a reasonable one. To rebuild the test database instead:

```sql
-- as healthcloud_owner, against healthcloud_test ONLY
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION healthcloud_owner;
GRANT USAGE ON SCHEMA public TO healthcloud_app;
```

then let the vitest global setup re-apply the migrations. Note the schema drop
also discards the `ALTER DEFAULT PRIVILEGES` from `bootstrap.sql`, which is
harmless only because every migration issues its grants explicitly.

**Roles are seeded, so new permissions need `seed:auth` re-run.** Adding a
permission to `packages/db/src/permissions.ts` changes nothing in a running
database until the seed writes it into the `role` rows — and the symptom is a
button that silently never renders, because `can('invoice:read')` is false for
everyone. Rebuild the db package first (`SYSTEM_ROLES` is read from `dist`), then
`pnpm --filter @healthcloud/db seed:auth`.

**A narrower `GRANT` in a migration does nothing.** `bootstrap.sql` sets
`ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`, so
every new table already has all four. Restricting one takes an explicit `REVOKE`
— `encounter_addendum` is the example, and the integration test asserts the
resulting privilege list because the mistake is otherwise invisible.

**`pnpm test` is `turbo run test --concurrency=1`.** The db and API suites share
`healthcloud_test`; in parallel, one suite's TRUNCATE lands inside the other's
assertions and a dozen unrelated tests fail with 401s.

**Two-factor is one switch, `MFA_ENABLED`, and it is currently OFF everywhere
including production** — Narveer's decision on 25 Aug 2026, while the product is
being demonstrated rather than used. Every account signs in with a password
alone, and the API says so in its startup log.

It replaced three overlapping flags (two `DEV_DISABLE_*` plus a seed-only one)
whose combined effect nobody could state without reading three files. One switch,
one answer.

Nothing was deleted: enrolment, code verification and the platform realm are all
still implemented, `SYSTEM_ROLES` still marks administrator and owner as
requiring TOTP, and `setup-env.ts` forces `MFA_ENABLED=true` for the integration
suite so all of it keeps its end-to-end test. Turning it back on is that one
variable.

**Set it to `true` before real clinics hold real patient data.**

**A MIGRATION is subject to FORCE RLS as well, and says nothing when it is.**
Same root cause as the entry below, in the place it is easiest to miss: a
migration runs as the owner, so an `UPDATE` on a tenant table without
`app.tenant_id` set matches zero rows, reports success and changes nothing. Walk
the tenants and `set_config` inside the loop —
`20260826180000_fold_prefix_under_rls` is the pattern, and it raises a NOTICE
with the row count because the attempt before it failed silently. **Read the
rows back before believing a data migration.**

**A SECURITY DEFINER function still gets row-level security applied to it.**
FORCE RLS applies to the table's OWNER, which is who a SECURITY DEFINER function
runs as — so a function that reads `patient` without setting `app.tenant_id`
matches zero rows and reports success. This has now bitten four times:
`auth_lookup_user`, the token backfill, `platform_clinic_stats`, and a
practitioner-name migration. The fix is
always the same shape — resolve the tenant, `set_config(..., true)`, then read
inside the policy.

**Platform accounts are not clinic accounts.** `/platform` is a separate console
with its own table, its own token realm and its own cookies (`hc_pat`), so a
clinic session cannot reach it and a platform session cannot read a patient.
Create the first one with
`pnpm --filter @healthcloud/db platform:user -- <email> "<name>"`.

MFA there is not role-dependent — when `MFA_ENABLED` is on, every platform
account needs an authenticator, no exceptions. With it off, the password the
script prints is the entire credential for an account that can suspend every
clinic on the platform, so treat that output accordingly.

**A waiting-room screen is paired, not logged in.** Its key is
`<tenantId>.<secret>`, hashed at rest, and shown exactly once at pairing —
Settings → Waiting-room screens, administrator only. To pair one without walking
an admin through TOTP on the command line, insert a `display_device` row with the
SHA-256 of a key you generate; the API authenticates it identically. The screen
shows tokens and doctor names only, and that is enforced by the query in
`DisplayService.board`, not by the component.

**A schema change needs `pnpm --filter @healthcloud/db build`, not `generate`.**
`generate` writes the client into `src/generated`; the API imports the package's
`dist`, so until the build runs every write carrying a new column fails with
`Invalid ... invocation` and 44 tests go red for a reason that has nothing to do
with the change. Same class of trap as `seed:auth` and `SYSTEM_ROLES`.

**The demo queue empties at IST midnight, and it is not a bug.** The seed creates
"today's" appointments in the clinic's timezone, and the machine runs on
`America/New_York` — so from roughly 14:30 local onwards it is already tomorrow
in Kolkata and the board is legitimately empty. `pnpm --filter @healthcloud/db
seed:scheduling` re-seeds for the new clinic day. Half an hour went into chasing
this as a queue bug on 7 Aug.

**Symmetric round trips hide driver bugs.** The timezone regression test writes
with raw SQL and reads through Prisma on purpose. A test that sets up its data
through the API cannot catch it, because a driver that misreads a timestamp also
miswrites one and the two cancel out.

---

## 4. Known gaps

| Gap                              | Note                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Printed receipt                  | Invoices are numbered and complete; nothing prints one yet.                    |
| Per-clinic logo                  | One default for everyone at `apps/web/public/branding/`. Upload waits on S3.   |
| Assigning a custom role          | Made at Settings → Roles, given out at Settings → Staff. Two screens, one job. |
| Password reset                   | No flow at all.                                                                |
| Reminders (FR-APT-06)            | Built against a console channel (docs/10). A real BSP + DLT is still needed.   |
| Patient self-booking (FR-APT-04) | Needs the patient portal, which does not exist.                                |
| `audit_event` partitioning       | Plain table with a BRIN index. Fine until production volume.                   |
| Rate limiting                    | Per-account lockout only. No IP throttle.                                      |
| Web tests                        | None. The browser checks are written ad hoc and deleted after use.             |

---

## 5. Next, in the order I would do it

1. **User management and password reset.** Unglamorous, and the first thing that
   blocks a pilot with a real clinic — right now users exist only because a seed
   script created them.
2. **The printed receipt.** The invoice is complete and numbered; nothing prints
   it. Small, and the print stylesheet already exists from the prescription.
3. **FR-P36-24 — repeat the last visit's prescription in one click.** The last
   point from the orthopaedic demo still outstanding; the previous-visit panel
   already loads everything it needs.
4. **A DPDP erasure process.** Patient data now sits in three places — the patient
   row, `patient_correction`, and S3 — and nothing deletes a person on request.

Then IPD, claims or ABDM — all large, and none urgent for a single OPD clinic.
