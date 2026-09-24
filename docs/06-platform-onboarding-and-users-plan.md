# Onboarding a clinic, and managing its users — plan

Narveer, 17 Aug 2026, in his words:

> I was expecting this platform as a SaaS based platform. If I need to onboard a
> hospital, how am I going to do that? There will be two admins. One will be
> super admin — that will be us, doctorsdesk.in. To onboard a hospital we set the
> hospital name, the logo, and how many users they can create — how many doctors,
> how many nurses. Then it creates the hospital, and within it one admin account.
> We share that username and password with the hospital admin, and the hospital
> admin creates their own doctors, nurses and reception. But I'm not able to see
> this option.

He is right that it is not there. Neither half is: the platform tier does not
exist at all, and the clinic admin can see a **Settings** menu with one item in
it. Every user in the system exists because `seed-auth.mjs` inserted it.

Status: **phases A and B built** on 17 Aug 2026. A clinic administrator manages
their own staff, and doctorsdesk.in can onboard a clinic, set its seats and
suspend it. Phase C — the logo, and the storage module it needs — is still plan.

Three things the build changed from what is written below, all recorded in the
phase notes in section 6:

- The platform does **not** connect as its own database role. `healthcloud_owner`
  is `NOCREATEROLE` by design, so a migration cannot create one. Its powers are
  four SECURITY DEFINER functions instead, which is a narrower hole than the
  role would have been.
- `platform_clinic_stats()` had to be rewritten before it worked at all: FORCE
  row-level security applies to the table owner, so a SECURITY DEFINER function
  reading `patient` without tenant context counts zero. It now walks the tenants
  and counts inside each one's policy.
- **Two-factor is off everywhere, by Narveer's decision on 25 Aug 2026**, while
  the product is being demonstrated rather than used. It reached that state in
  three steps, and the first two were mistakes worth recording: a seed-only flag
  (`DEV_DISABLE_MFA`) that appeared to disable MFA but did not reach a clinic
  created through this console, because onboarding seeds roles from
  `SYSTEM_ROLES` and never runs the seed script; then a second flag for the
  platform realm; then, when the answer for every persona turned out to be the
  same, a single `MFA_ENABLED` switch that both realms read. Three flags whose
  combined effect needed three files to work out is worse than one switch that
  is honestly off.
- So section 2.1's "no version of this account should be reachable with a
  password alone" is, today, not true — the platform password is the whole
  credential. The code is intact and the integration suite still runs with
  `MFA_ENABLED=true`; **set it to `true` before real clinics hold real patient
  data.**

---

## 1. The thing this has to get right

Everything in HealthCloud rests on one property: **no query can cross a tenant
boundary.** Twenty-one tables under FORCE row-level security, a non-owner
application role, `current_tenant_id()` failing closed, and thirteen tests whose
only job is to prove a session for one clinic cannot touch another's data
(ADR-005).

A super admin crosses that boundary by definition. That is the whole point of
one.

So the question is not "how do we let a super admin see everything" — it is
**how little can a super admin be allowed to do, while still onboarding a
clinic.** Every design below follows from taking that seriously rather than
adding a `isSuperAdmin` flag to `app_user` and moving on.

---

## 2. Decisions worth arguing with

### 2.1 The super admin is not a user of any clinic

`app_user` is tenant-scoped. A row in it belongs to exactly one clinic, and
every policy in the database assumes that. Marking one of those rows as a super
admin means either weakening the policies or carrying an exception through all of
them forever.

So platform staff live in a **separate table, `platform_user`, that is not
tenant-scoped at all** — the same class of table as `tenant` itself. They sign in
at a different endpoint, hold a different kind of session, and their token is not
interchangeable with a clinic session. A clinic login cannot become a platform
login by editing a claim, because the two are looked up in different tables.

Cost: a second login screen and a second session type. Worth it — the
alternative is that the most powerful credential in the system is validated by
the same code path as a receptionist's.

### 2.2 The platform can provision a clinic. It cannot read one.

This is the line, and it is worth defending against the first support ticket
that asks to cross it.

**A platform admin can:** create a clinic, set its name, slug, timezone, UHID
prefix and seat limits, upload its logo, create its first administrator, suspend
and reactivate it, and see counts — how many users, how many patients, when
someone last signed in.

**A platform admin cannot:** open a patient, a queue, an invoice, an appointment
or a clinical note. Not "the UI does not show it" — _cannot_.

Enforced in the database, not in a service. The platform API connects as a new
role, `healthcloud_platform`, which is granted rights on exactly five tables:
`tenant`, `tenant_seat_limit`, `platform_user`, `platform_session`, and INSERT on
`audit_event`, plus the narrow access to `app_user`/`role`/`user_role` needed to
create that first administrator. It holds **no grant at all** on `patient`,
`appointment`, `encounter`, `invoice` or any other clinical table. A bug in the
platform module cannot leak a patient record, because PostgreSQL will refuse the
query before RLS is even consulted.

Two reasons this is not over-engineering:

- **DPDP.** We would be a data processor reading personal health data for a
  purpose the patient never consented to. "Our engineer looked at it to help" is
  not a lawful basis, and a clinic's DPO will ask.
- **It is the credential everyone will attack.** One password that reads every
  clinic in the country is a different security problem from one that reads one
  clinic. Better that it does not exist.

When support genuinely needs to see a clinic's data, that should be a separate,
explicit, **clinic-granted and time-boxed** access — the clinic's administrator
turns it on, it expires, and every read is in their audit trail. Not a standing
power, and not part of this work.

### 2.3 Seat limits are counted on ACTIVE users, which is why deactivate matters

`tenant_seat_limit (tenant_id, role_key, max_users)`. Null or missing means
unlimited, so nothing changes for a clinic nobody has priced.

**All four staff roles carry a limit** — doctor, nurse, front desk and
administrator (Narveer, 17 Aug). The administrator cap is the one that does the
least obvious work and matters most: without it a clinic shares one admin login
between five people, and every action in the audit trail reads as the same
person. A seat limit is the only thing that makes an audit trail worth keeping.

The count is of **active** users holding that role. That single choice is what
makes Narveer's "activate or deactivate the user" requirement do real work: a
clinic on five doctor seats that loses a doctor deactivates them and hires
another. Deleting the old user is not an option — their name is on signed
consultations and issued receipts, and those must keep resolving.

Two rules that will otherwise be discovered awkwardly:

- **At the limit, creation is refused with a message that says what to do:**
  "All 5 doctor seats are in use. Deactivate a doctor, or ask
  doctorsdesk.in to raise the limit." Never a silent failure, never a 500.
- **Lowering a limit below current usage deactivates nobody.** It blocks the
  next creation. Software that logs a working doctor out because a plan changed
  is software a clinic stops trusting.

### 2.4 The first administrator gets a temporary password, and must change it

The platform creates one administrator per new clinic and shows a generated
password **once** — the same pattern as the waiting-room screen key, for the same
reason: we store a hash, so we cannot show it twice.

That password travels over WhatsApp to a clinic owner. So it is temporary by
construction: `mustChangePassword` is already a column on `app_user`, nothing
reads it today, and this is where that gets finished. First login forces a change
before any other screen is reachable.

Deliberately **not** an email invite link yet. Email needs a real sender, a
domain with SPF/DKIM, and a token flow with its own expiry rules — and Narveer's
plan is to share credentials directly for now. The temp password is honest about
what is actually happening; a link that "expires in 24 hours" but is really the
same thing dressed up is not.

### 2.5 The clinic administrator invites, suspends and resets — nothing more

Inside a clinic, the administrator manages users. They can create a user with one
or more roles, deactivate and reactivate, reset a password (again: shown once,
forces a change), and see when each person last signed in.

They **cannot** edit the permission set of a role. That is fixed in code
(`packages/db/src/permissions.ts`), for the reason recorded there: a tenant
inventing a permission produces a string nothing checks, which is worse than
having none because it looks like it works. Role _membership_ is tenant data;
role _contents_ are not.

They also cannot create another administrator beyond their seat limit, and they
cannot deactivate themselves — a clinic that locks itself out of its own
administration becomes a support call that only the platform tier can fix.

### 2.6 A suspended clinic can still read its own records

Narveer's answer on 17 Aug, and the one that changed the design most: a clinic
suspended for non-payment goes **read-only**, not dark. Staff sign in, open
patients, read history, print and export — and cannot book, consult, bill or
register anyone new.

The reasoning is not commercial softness. The clinic is the data fiduciary for
its patients' records and is legally required to retain and produce them; a
switch of ours that puts those records out of reach makes us the reason they
cannot. "We locked a hospital out of its patient history over an invoice" is a
sentence worth designing around. Read-only keeps the commercial pressure — no new
revenue can be taken through the product — without holding patient data hostage.

Three consequences, none of them free:

- **`auth_lookup_user` has to change.** It currently refuses any tenant that is
  not `ACTIVE`, which is why suspension today means darkness. It becomes: allow
  `ACTIVE` and `SUSPENDED`, refuse `ARCHIVED`. Archived stays a full stop.
- **Read-only is enforced twice.** A guard refuses every mutating request from a
  suspended tenant with a message that says why and who to contact — and,
  underneath it, `PrismaService.forTenant` opens the transaction with
  `SET TRANSACTION READ ONLY` when the tenant is suspended, so a route that
  forgets the guard still cannot write. The guard exists for the message; the
  database setting is what makes it true.
- **A short allowlist stays open**: signing in, signing out, and changing your
  own password. Locking someone out of a password change during a billing
  dispute is a support call with no upside.

The console shows a persistent banner, and it must name the way out — who to pay
and how — rather than saying "contact support".

---

## 3. Data model

### New, not tenant-scoped

| Table              | Notes                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform_user`    | doctorsdesk.in staff. Email, password hash, TOTP secret, `isActive`. MFA is **mandatory**, not role-dependent — there is no version of this account that should be password-only. |
| `platform_session` | Separate from `session` so a clinic refresh token can never be presented as a platform one.                                                                                       |

### New, tenant-scoped

| Table               | Notes                                                       |
| ------------------- | ----------------------------------------------------------- |
| `tenant_seat_limit` | `(tenant_id, role_key, max_users)`. Absent means unlimited. |

### Changed

| Table      | Change                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant`   | `logoObjectKey`, `contactEmail`, `contactMobile`, `onboardedByPlatformUserId`, `suspendedAt`, `suspendedReason`. `status` already exists as ACTIVE / SUSPENDED / ARCHIVED and `auth_lookup_user` already refuses a non-ACTIVE tenant — suspension is half-built already. |
| `app_user` | Nothing. It already carries `isActive`, `mustChangePassword`, `lastLoginAt` and the lockout fields.                                                                                                                                                                      |

### The audit question

Platform actions are audited into the same `audit_event` table as everything
else, stamped with the tenant they acted on and with the platform user's id in a
new `platform_actor_id` column. A clinic reading its own audit trail should be
able to see "doctorsdesk.in suspended this clinic on the 14th" — it happened to
them, and hiding it would be the wrong kind of quiet.

---

## 4. Scope

### In

| Ref       | Feature                                                                  |
| --------- | ------------------------------------------------------------------------ |
| FR-PLT-01 | Platform sign-in, separate realm, MFA mandatory                          |
| FR-PLT-02 | Create a clinic: name, slug, timezone, UHID prefix, contact              |
| FR-PLT-03 | Seat limits per role, set at onboarding and editable later               |
| FR-PLT-04 | Create the clinic's first administrator; temp password shown once        |
| FR-PLT-05 | Suspend and reactivate a clinic, with a reason — read-only, not lockout  |
| FR-PLT-07 | Read-only enforcement: request guard, read-only transaction, banner      |
| FR-PLT-06 | Clinic list with counts and last activity                                |
| FR-USR-01 | Clinic admin: list users with role, status, last sign-in                 |
| FR-USR-02 | Clinic admin: create a user with roles, inside seat limits               |
| FR-USR-03 | Clinic admin: deactivate and reactivate                                  |
| FR-USR-04 | Clinic admin: reset a password                                           |
| FR-USR-05 | Forced password change at first login                                    |
| FR-BRD-01 | Clinic logo: upload, store, and render on print, receipt and the display |

### Out, deliberately

| Feature                                | Why                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-serve signup                      | Every clinic needs a conversation about pricing and data anyway. A signup form would only queue work someone still does by hand.                         |
| Email invites and password-reset links | Needs a sending domain with SPF/DKIM and a token flow. The temp password is what is actually happening today; build the link when email exists.          |
| Editable role permissions              | Deliberate — see 2.5.                                                                                                                                    |
| Plans and subscriptions                | Seat limits are numbers on a tenant for now. Turning them into named plans is a pricing decision, not a schema one, and premature until pricing settles. |
| Platform support access to clinic data | Should exist eventually as a clinic-granted, expiring, audited grant. Not as a standing power, and not in this pass.                                     |
| Per-clinic custom domains              | Later, if ever.                                                                                                                                          |

---

## 5. Permissions

Clinic side uses what already exists — `user:manage`, `role:manage`,
`tenant:configure` — all held by the administrator role and nobody else. No new
strings.

Platform side does **not** use the permission vocabulary at all. Platform users
are not in `app_user`, hold no `role` rows, and their capability is the fact of
being a platform user. Reusing the clinic permission system for them would mean
one vocabulary spanning both realms, and the first mistake in it would be a
cross-tenant one.

---

## 6. Phases

**A — Clinic user management. Done, 17 Aug 2026.** Migration
`20260817090000_tenant_seat_limits`, the Staff screen under Settings, create /
deactivate / reactivate / reset-password, forced password change at first login,
and seat limits enforced on all four roles.

Two decisions made while building: deactivating revokes the user's sessions and
clears their lockout, and reactivating consumes a seat — otherwise a clinic at
its limit could exceed it by switching old accounts back on. And changing a
password requires the current one even with a valid session, because a session
proves somebody authenticated once, not that they are still the owner; an
unattended desk is the ordinary case in a clinic.

One thing this exposed rather than fixed: revoking a session does not kill the
access token the user is already holding, which stays valid for up to fifteen
minutes. That is the trade recorded in `tokens.ts` and it applies equally to
deactivation. Asserted explicitly in `users.e2e.test.ts` rather than wished away
— if the guard ever becomes session-aware, that expectation changes first.

Deliberately first, even though Narveer's story starts with onboarding: without
it, provisioning a clinic produces an administrator who cannot do anything. It is
also the piece that blocks a pilot today.

**B — The platform tier. Done, 17 Aug 2026.** Migrations
`20260817140000_platform_tier`, `..160000_platform_operations` and
`..170000_platform_stats_under_rls`. `platform_user` and `platform_session`, a
separate token realm, the console at `/platform`, onboarding, suspend and
reactivate, and seat limits editable after the fact.

The first platform account comes from a script —
`pnpm --filter @healthcloud/db platform:user -- <email> "<name>"` — for the same
reason the database roles live in `bootstrap.sql`: there is nobody to create the
first one in the UI.

**Where the isolation actually ended up.** The plan called for a dedicated
`healthcloud_platform` database role with no grant on any clinical table. That
turned out to be impossible from a migration: `healthcloud_owner` is
`NOCREATEROLE`, deliberately, so creating a role needs a superuser and belongs in
`bootstrap.sql`. Rather than widen the application role — granting it INSERT and
UPDATE on `tenant` would have handed the same power to every clinic-facing
screen sharing that connection — the platform's writes go through four
SECURITY DEFINER functions:

| Function                     | What it can do                                                          |
| ---------------------------- | ----------------------------------------------------------------------- |
| `platform_create_tenant`     | Insert one tenant row.                                                  |
| `platform_set_tenant_status` | Move a clinic between active, suspended and archived.                   |
| `platform_set_seat_limit`    | Write one seat limit.                                                   |
| `platform_clinic_stats`      | Return per-clinic counts — integers and one timestamp, by construction. |

That is a narrower hole than the role would have been: the platform's power is
four named operations rather than table-level rights, and `platform_clinic_stats`
has no shape of return value that could carry a patient's name. The dedicated
role is still worth adding when somebody next runs `bootstrap.sql` as superuser;
it would turn "returns nothing" into "permission denied" on the clinical tables.

Two traps worth remembering, both the same trap:

- `platform_clinic_stats()` counted zero of everything on the first attempt.
  SECURITY DEFINER runs as the owner, and FORCE row-level security applies to the
  owner too — so it read `patient` with no tenant context and matched nothing. It
  now walks the tenants and counts inside each policy, exactly as
  `auth_lookup_user` does. This is the third time this has bitten in this
  codebase; it is in `docs/03` for a reason.
- Prisma cannot deserialise a `void`-returning function through `$queryRaw`.
  The three void functions are called with `$executeRaw`.

**C — Branding. Deferred by Narveer on 17 Aug 2026: one default logo now, S3
later.**

What is built: a single default logo at
`apps/web/public/branding/clinic-logo.svg`, rendered on the printed prescription
and the waiting-room screen through one component,
`apps/web/src/components/clinic-logo.tsx`. Replacing the file changes it
everywhere, with nothing to rebuild or re-seed. There is a README beside it.

The default is deliberately a plain outlined cross in near-black rather than
anything designed. A printed prescription is the CLINIC's document, and a logo
they never chose has no business looking like their emblem. It is also
single-colour because most clinics print on a monochrome laser, where a mid-tone
mark renders as grey mush at 14 mm.

**Still pending, and what it needs when we pick it up:**

- A storage module. `STORAGE_DRIVER=local` has been in `.env` since the start and
  nothing implements it; S3 is the intended destination.
- `tenant.logoObjectKey` — specified in section 3 above, not yet added.
- Upload validation: PNG and JPEG only, re-encoded on upload. No SVG from a
  clinic, for the reason in section 7 — it prints on prescriptions and shows on a
  public screen, so a script-bearing SVG would be stored XSS on the most visible
  surface in the building. The SVG shipped as the default is safe because we
  wrote it.
- Served through the API rather than a public bucket, so a suspended or archived
  clinic's assets stop being reachable along with everything else.
- One change in `ClinicLogo`: take a `src` prop fed from the tenant, keep the
  constant as the fallback. Every surface follows from that one place, which is
  why there is exactly one reference to the file.

---

## 7. Risks

**The platform tier is a second front door.** It needs the same lockout, the same
audit, the same session revocation as the clinic one — and it is the account
least likely to be used daily and most likely to have a weak password. MFA on it
has no role-based exemption for that reason — but it is currently switched off
along with everyone else's, which makes this the single largest open risk in the
system and the first thing to reverse.

**Seat limits are commercial logic in a clinical system.** A limit that blocks a
clinic from adding a doctor on a Monday morning is a support call within the
hour. The refusal message must name the way out, and raising a limit must take
effect immediately with no re-seed and no restart.

**Creating a user across the boundary.** Provisioning writes into
`app_user` — a tenant-scoped table — from the platform realm. It is the one place
in the system where that happens, so it goes through a single function that takes
exactly one tenant id, sets context, writes, and returns. Not a general-purpose
"act as tenant" helper, which is how that kind of thing spreads.

**Read-only is easy to half-build.** Guards that list mutating routes go stale
the day someone adds a route and forgets. That is why the database transaction is
set read-only underneath the guard rather than instead of it: the guard produces
the sentence a receptionist reads, and the transaction is what makes the promise
true for routes nobody remembered. The test that matters is not "the guard
refuses" — it is a suspended tenant attempting a write through a route added
after the guard was written.

**A logo is patient-facing.** It prints on prescriptions and shows on a waiting
room wall. An unvalidated upload is a stored-XSS vector if it is an SVG, so
either SVGs are sanitised or only raster formats are accepted. Simplest safe
answer: PNG and JPEG only, re-encoded on upload.

---

## 8. Settled — 17 Aug 2026

| Question                             | Decision                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seat limits on which roles?          | **All four** — doctor, nurse, front desk, administrator. See 2.3.                                                                                                                                                                                                                                             |
| Suspension behaviour?                | **Read-only, not dark.** Sign in, read, print, export; no writes. See 2.6 — this is the answer with the largest build cost, and the right one.                                                                                                                                                                |
| Platform accounts?                   | **A small team, flat powers.** Two or three accounts, each able to onboard, edit limits and suspend. Accountability comes from the audit trail naming who acted, not from splitting the powers — revisit if the team outgrows it.                                                                             |
| Who chooses the slug?                | **We propose it from the clinic name; it stays editable until save.** Keeps uniqueness and anything embarrassing under our control while the change is still cheap. Dropping the slug from sign-in altogether was considered and parked: it needs platform-wide unique emails, which is a real schema change. |
| Logo formats?                        | **PNG and JPEG only, re-encoded on upload.** Decoding and re-encoding strips embedded script and metadata. No SVG — it prints on prescriptions and shows on a public screen, so a script-bearing SVG would be stored XSS on the most visible surface in the clinic.                                           |
| Can a clinic admin reset a password? | **Yes — a generated temporary password, shown once, forcing a change at next sign-in.** Same pattern as the clinic's first administrator. Self-service reset by email waits for a sending domain; nothing sends email today.                                                                                  |

### Still open, and not blocking

1. **Who is billed, and how do we know a clinic has paid?** Suspension is a
   switch someone flips by hand until there is a billing system. Fine for the
   first few clinics, and worth knowing it is manual.
2. **What does a clinic see when it hits a seat limit at 9am on a Monday?** The
   message names the way out, but if the answer is "message Narveer on WhatsApp",
   that should be what it says.

---

## 9. Roles and permissions by hand — 28 Aug 2026

Modelled on the role management in Narveer's CIPCRM at his request: a catalogue
of permissions grouped into categories, roles holding a list of them, and an
administrator ticking boxes at **Settings → Roles and permissions**. Until now
roles existed only because the seed created them.

Three decisions, all Narveer's:

| Question                             | Decision                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Can a clinic change a built-in role? | **Yes, its permissions — never its key or its name, and never Administrator at all.** |
| Can a clinic invent its own roles?   | **Yes.** The key is slugified from the name once and then fixed.                      |
| When does a change take effect?      | **Immediately: everybody holding the role is signed out.**                            |

### Why Administrator is locked

It is the way back from every other change on the screen. A clinic that removed
`role:manage` from the only role holding it would have lost the screen that puts
it back, and nobody at the clinic could fix it — it would be a support call and a
SQL statement. `LOCKED_ROLE_KEY` in `packages/db/src/permission-catalogue.ts`;
`assertEditable` refuses PATCH, reset and delete with `ROLE_IS_LOCKED`.

### Why the key never changes

Onboarding, seat limits and three backfill migrations all address roles by key.
A renamed key breaks them with no error anybody would see: seats stop counting, a
migration matches nothing and reports success. The name is a label; the key is an
identifier, and the two are allowed to diverge.

### Why the catalogue is code, not a table

CIPCRM seeds its permissions into a collection. Ours is compiled against by
`@RequirePermissions`, so a permission absent from the code guards nothing — a
role holding `patient:delete` would look meaningful on screen and stop no one.
`PERMISSION_CATALOGUE` is typed `Record<Permission, PermissionInfo>`, so adding a
permission without describing it fails the build. `assertPermissionsExist`
refuses anything outside it with `UNKNOWN_PERMISSION`.

### Why saving signs people out

Permissions ride in the signed access token — that is what lets a request be
authorised without a database lookup, and the cost is that a token keeps saying
what it said when it was issued. Without revocation, a permission removed at 10am
stays usable until that person next happens to log out. `revokeSessionsForRole`
sets `revoked_reason = 'role_changed'` and **skips the administrator making the
change**: signing yourself out mid-edit hides whether the change worked, and they
hold every permission anyway.

The screen says how many people a save will interrupt _before_ it is pressed, and
how many it did after.

### Still open

- **Roles are not assignable from this screen.** Adding a custom role tells you to
  go to Staff to give it to somebody. One screen would be better; two is honest.
- **A custom role cannot be deleted while anybody holds it** (`ROLE_IN_USE`). Move
  them first. Reassigning on delete was considered and rejected — deciding on
  somebody's behalf what they may now do is not a thing to do silently.
