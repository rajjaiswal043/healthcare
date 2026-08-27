# White-label branding — plan

Every clinic sees its own name and logo, not ours. Written 26 Aug 2026, after
Narveer described the goal: _"whenever somebody will log into our portal,
although this is a SaaS platform, they need to have a feeling that this is
customised as per their hospital — it's not a generic tool."_

---

## 0. Decisions taken

Four, all Narveer's, 26 Aug 2026:

| Decision                   | Chosen                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------- |
| How login finds the clinic | Type the slug, branding resolves and swaps in. Last clinic remembered in the browser. |
| Where logos live           | Postgres `bytea`, behind a storage interface.                                         |
| How much of us remains     | **Full white-label.** HealthCloud appears nowhere a clinic can see.                   |
| Who sets branding          | Platform at onboarding; the clinic's administrator can change it after.               |

Subdomains (`sunrise.thedoctordesk.in`) were considered and deferred, not
rejected — see section 10.

---

## 1. The thing this has to get right

**The login screen runs with no session, no tenant and no RLS context.** Every
other screen in the application knows who is looking at it. This one does not,
and it is the first thing a clinic sees.

So branding has to be resolvable from a slug typed into a text box, by an
endpoint that answers before anyone has authenticated. That single fact drives
the schema, the endpoint, its security properties and the shape of the UI.

The second thing: **a clinic must never see another clinic's logo.** The branding
lookup deliberately runs outside RLS, which makes it the only read path in the
application not protected by the database. It therefore reads three columns of
one table by slug and nothing else, through a `SECURITY DEFINER` function narrow
enough that there is no shape of response it could be talked into returning.

---

## 2. What already exists

More than expected, which is why this is a small piece of work:

- `tenant.name` and `tenant.legalName` are **already captured at onboarding and
  already stored**. Nothing in the console has ever displayed them. Half of this
  requirement is wiring, not building.
- `ClinicLogo` (`apps/web/src/components/clinic-logo.tsx`) already renders on the
  **waiting-room screen** and the **printed prescription**, with one hard-coded
  default and a comment describing exactly this change: take a `src`, keep the
  constant as fallback.
- The platform onboarding form already collects the name.

What does not exist: a logo column, any upload or storage code anywhere in the
repository, and tenant identity on `/auth/me`.

---

## 3. Data model

```prisma
model Tenant {
  // ...
  /// Bytes, not a path. See section 4 for why, and for the escape hatch.
  logoBytes     Bytes?    @map("logo_bytes")
  /// Narrowed by CHECK to image/png — never image/svg+xml, see section 7.
  logoMimeType  String?   @map("logo_mime_type") @db.VarChar(64)
  /// Drives the ETag and the cache-busting query parameter.
  logoUpdatedAt DateTime? @map("logo_updated_at") @db.Timestamptz(6)
}
```

A CHECK constraint keeps the three columns consistent: all null, or all set. A
row carrying a MIME type and no bytes is a bug that would otherwise surface as a
broken image on a clinic's login page.

`tenant` is NOT under RLS — it is the tenancy root — and the application role
has **SELECT and nothing else** on it, granted explicitly in the first migration.
That is why the platform tier's writes go through `SECURITY DEFINER` functions,
and logo writes take the same route: `tenant_set_logo` and `tenant_clear_logo`,
added in 20260826130000.

This was nearly got wrong. The first implementation used a plain
`tenant.update(...)` and passed locally, because the DEVELOPMENT database had
drifted into holding INSERT, UPDATE and DELETE that no migration grants. The
integration suite — running against a database built only from migrations —
refused it with 42501. Development being more permissive than production is the
most expensive shape of drift there is, so the same migration REVOKEs those
privileges: a no-op on a correct database, a repair on a drifted one.

---

## 4. Storage: bytes in Postgres

The usual objection to files in a database does not apply well here. A logo is
one row per tenant, under 512KB, written approximately never and read from cache
almost always. Against that:

- No new infrastructure, no bucket, no IAM role and no credentials to leak,
  during a phase that is deliberately local-first and single-EC2.
- Backups stay atomic. A `pg_dump` is the whole system; there is no second store
  that can drift out of sync with it.
- It behaves identically on a laptop and on the box.

It is nonetheless written behind an interface:

```ts
interface BrandingStore {
  put(tenantId: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(tenantId: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
  clear(tenantId: string): Promise<void>;
}
```

`PostgresBrandingStore` today. When patient documents force a real object store —
and they will — `S3BrandingStore` is a new file and one line in a module, not a
migration of the call sites. **The 512KB cap is what keeps this decision cheap.
It is a structural limit, not a UX nicety.**

---

## 5. The public branding endpoint

```
GET /api/v1/branding/:slug        -> { name, hasLogo, logoVersion }
GET /api/v1/branding/:slug/logo   -> image bytes
```

Both unauthenticated, both read-only. Properties they must have:

- **An unknown slug returns the default branding, not a 404** — but be honest
  about what that buys. It gives every caller one response shape, so the sign-in
  page has no error path and a status-code scraper learns nothing. It does NOT
  make a real clinic indistinguishable from an invented one: read the body and a
  real clinic's actual name is right there, and no design can hide that while
  the purpose of the endpoint is to display it. **Confirming that a slug is in
  use is inherent to white-labelling a login page.** The mitigations that are
  real: the per-IP rate limit below, and the fact that a slug must be guessed
  exactly. Written up this way after the first draft of this document claimed
  indistinguishability that the implementation could not deliver.
- **A SUSPENDED clinic still gets its branding.** Suspension is read-only, not
  lockout (docs/06 section 2.6) — its staff still sign in, so they still see
  their own logo.
- **Cache hard.** `logoVersion` derives from `logoUpdatedAt`; the logo response
  carries a strong `ETag` and `Cache-Control: public, max-age=31536000,
immutable`, with the version in the query string. A logo change produces a new
  URL, so nothing needs invalidating.
- **Rate limit it.** This is the first public unthrottled surface in the API — the
  only limit today is per-account login lockout. A per-IP cap on these two routes
  ships with them, not afterwards.

---

## 6. Identity on the session

`/auth/me` and the login response gain `tenantName` and `tenantLogoUrl`. The web
`AuthProvider` already refetches `/auth/me` on load, so both survive a refresh —
the same argument that put `mustChangePassword` there rather than only in the
login response.

---

## 7. Upload and validation

`POST /api/v1/branding/logo` for the clinic administrator (`tenant:configure`),
and the platform equivalent at onboarding.

- **Sniff magic bytes. Never trust the extension or the declared MIME type.**
- **Re-encode server-side to PNG** rather than storing what was uploaded. This is
  the load-bearing decision in this section, because it neutralises SVG entirely.
- **Refuse SVG.** An SVG is a document, not an image: it can carry `<script>`,
  and this file is served from our own origin to an unauthenticated page.
  Sanitising SVG is a losing game; re-encoding to a raster format ends it. If a
  clinic sends one, we convert it or ask for a PNG.
- Cap at 512KB before decode and bound the decoded dimensions, so a decompression
  bomb cannot be handed to the encoder.
- `sharp` is already a dependency (Next image optimisation) and already in the
  install allowlist, so the re-encode costs nothing new.

---

## 8. Surfaces

| Surface                    | Today                         | After                              |
| -------------------------- | ----------------------------- | ---------------------------------- |
| `/login` before slug typed | HealthCloud + tagline         | Neutral, unbranded — see section 9 |
| `/login` after slug        | HealthCloud                   | Clinic logo + clinic name          |
| Header breadcrumb root     | `HealthCloud` (hard-coded)    | Clinic name                        |
| Nav rail                   | —                             | Clinic logo                        |
| Browser tab                | `HealthCloud — Staff Console` | `<Screen> — <Clinic name>`         |
| Prescription print         | Default logo + our line       | Clinic logo, our line removed      |
| Waiting-room screen        | Default logo                  | Clinic logo                        |
| Receipt (when built)       | —                             | Clinic logo                        |
| `/platform`                | doctorsdesk.in                | Unchanged — that console is ours   |

---

## 9. The unbranded state, and what full white-label costs

Full white-label creates a state that did not exist before: **the login page
before a slug has been typed, which belongs to no clinic and may no longer belong
to us either.** It gets a neutral mark and neutral copy — not a HealthCloud
tagline, not a half-branded guess.

This retires copy restored only the day before, on 25 Aug 2026: `Digitally
recorded and signed in HealthCloud` on the prescription, and the sign-in
blockquote, `Clinic CRM for India` and `ABDM-aware · Built for Indian OPD`. They
are our voice, and under this decision a clinic does not hear it.

**Narveer confirmed this explicitly on 26 Aug 2026, asked directly**, because
reversing a same-week instruction is not something to infer from a related
decision. `DPDP-ready · Encrypted · Audited` survives — it makes a claim about
the clinic's data, not about who wrote the software.

What is given up: every incidental impression. A doctor moving between clinics
will not know what this software is called. That is the trade full white-label
makes, and it is a business decision rather than a technical one.

---

## 10. Phases

**A — Branding exists. BUILT, 26 Aug 2026.** Migration, `BrandingStore`, the two public endpoints
with the `SECURITY DEFINER` reader, rate limiting, upload with re-encode.
Integration tests, including the enumeration property and cross-tenant
isolation — 23 of them, and `pnpm verify` exits 0 at 204 API tests.

Two things named for phase A were NOT built and move to B: a logo field on
platform onboarding (the platform tier needs its own route to set a clinic's
logo, which is more natural once the clinic-side settings screen exists), and
the `?v=` query parameter is served but nothing generates it yet — that arrives
with the web app in B.

**B — The console wears it. BUILT, 26 Aug 2026.** The session carries a
`tenant` object (`slug`, `name`, `logoVersion`) on both login and `/auth/me`, so
a logo an administrator changes reaches the front desk on their next refresh
rather than their next sign-in. The sign-in page resolves branding from the
typed slug with a 400ms debounce, guarded by a sequence number so a slow early
response cannot overwrite a fast late one, and remembers the last clinic in
`localStorage` only after a sign-in actually succeeds. Header breadcrumb, nav
rail, browser tab, printed prescription and the waiting-room television all read
the clinic. `grep -r HealthCloud apps/web/src` now matches nothing outside code
comments and the `/platform` console.

Two notes on what that cost. The **printed prescription** gained the clinic's
name on its letterhead and lost `Digitally recorded and signed in HealthCloud`.
And the **root layout title** is now `Clinic console` rather than ours — it is
what a clinic sees in the tab for the instant before the session loads.

**C — The clinic controls it. BUILT, 26 Aug 2026.** Settings → Branding, behind
`tenant:configure`: upload, replace, remove, and rename. The preview shows the
logo at two sizes — large, and at the 26px the nav rail actually renders it —
because a mark chosen only at full size can turn to mush everywhere it is used.
`PATCH /branding` renames through `tenant_set_display_name`, another
SECURITY DEFINER function for the same reason as the logo writes.

**`legalName` is deliberately not editable here.** It is what the clinic is
registered as, it appears on documents that have to match a registration, and
changing it is a platform-side operation with a paper trail rather than a
settings toggle. A test asserts a rename leaves it untouched.

The platform tier gained `PUT`/`DELETE /platform/clinics/:id/logo`, so a newly
onboarded clinic's first sign-in already looks like theirs — before anybody
there has an account to fix it with. That write is recorded in the clinic's
audit trail with a NULL actor, because a platform account is not one of their
staff and should not appear as one; there is a test for exactly that.

**D — Deferred.** Subdomains. The resolver in phase B reads the host first and
falls back to the typed slug, so this later becomes a DNS and certificate task
with no code rewrite. `tenant.slug` already carries the comment "used in
subdomains later".

---

## 11. Risks

- **The public endpoint is the first unauthenticated read in the application.**
  Narrow it by construction — three columns, one table, by slug — rather than by
  review.
- **A clinic uploads a 4000×3000 photograph of their signboard.** Re-encode and
  bound the dimensions; do not trust the input to be a logo.
- **A flash of the wrong brand.** Between page load and slug resolution the login
  screen shows the neutral state. Debounce, and never keep a previous clinic's
  logo on screen while a different slug is being typed.
- **`tenant` sits outside RLS.** Every new column on it is a column the database
  is not protecting. Correct for the tenancy root, and worth restating each time
  it grows.

---

## 12. Testing

Integration, in the API suite:

- An unknown slug returns default branding with 200, never 404 — the enumeration
  property, asserted directly rather than assumed.
- Clinic A's slug never returns clinic B's bytes.
- A suspended clinic still resolves its branding.
- SVG is refused; a PNG with a lying extension is accepted on its magic bytes; an
  oversized file is refused before decode.
- A changed `logoUpdatedAt` produces a different ETag.

Browser, before this is called done — the rule from `docs/03-resume-here.md`:
type a slug on the login page and watch the logo and name swap; sign in and check
the header, the tab title and the nav rail; print a prescription and confirm the
clinic's logo and no mention of HealthCloud.
