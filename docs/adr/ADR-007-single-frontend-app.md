# ADR-007 — One Next.js application with route groups, not separate staff and patient apps

**Status:** Accepted (6 Aug 2026) — revises an earlier proposal of two applications
**Deciders:** Narveer

## Context

The platform has two clearly distinct audiences (BRD §8): a **staff console** used by front desk, doctors, nurses and billing, and a **patient portal** delivered as a responsive PWA reached from WhatsApp and SMS links. They differ in authentication (staff sessions with MFA versus patient mobile-OTP), in threat model, in content security policy, and in usage pattern.

The initial plan proposed two separate Next.js applications on those grounds. That recommendation was made when the team size was still an open question. It is now settled that this is a **solo build**, which changes the calculus: the cost of a split is paid continuously by one person.

## Decision

**One Next.js 15 application (`apps/web`) with `(staff)` and `(portal)` route groups.**

- Route groups get **separate layouts, middleware, and auth flows** — the isolation that actually mattered is preserved at the routing layer.
- CSP and security headers are set **per route group** in middleware, so the portal can carry a stricter policy than the staff console without a second deployment.
- Shared UI primitives come from `packages/ui`; nothing is duplicated.
- Patient sessions and staff sessions use **different cookie names, different scopes and different token audiences**, so a patient session can never satisfy a staff route. This is asserted by tests, not assumed from routing.

## Alternatives considered

**Two applications (the original proposal).** Cleanest conceptual separation, independent deploys, independently tunable bundles. Rejected for now because every recurring cost lands on one person: two build pipelines, two dependency sets to keep in step, two sets of config drift, two deploy targets, and a shared-component package that must be versioned rather than simply imported. The benefits are real but accrue mainly to a team working in parallel.

**One app with no route grouping**, distinguishing audience by path checks. Rejected: security boundaries expressed as `if (path.startsWith('/patient'))` scattered through middleware is exactly the pattern that fails quietly.

## Consequences

**Good**

- One build, one dependency tree, one deploy — a meaningful fraction of solo maintenance overhead removed.
- Shared components are imported directly, with no package-versioning dance.
- A single place to get security headers, error handling and observability right.

**Costs, accepted**

- The bundle serves both audiences. Mitigated by route-group-level code splitting, so a patient never downloads the billing screens. Worth watching, since the patient side is the one on poor mobile networks.
- A single deploy means a staff-side change redeploys the portal too. Acceptable at current cadence; it becomes a real argument for splitting once the portal has independent release pressure.
- Sharing one process means one blast radius. Mitigated by the auth separation above, which is the part that actually matters.

**Reversibility**
Good, and deliberately so. Route groups are already directory-scoped with their own layouts and middleware, so extracting `(portal)` into its own app later is largely a move operation plus a second deploy target. **This is the reason the split can safely be deferred rather than guessed at now** — revisit when the portal's release cadence genuinely diverges from the staff console's, or when bundle size on mobile stops being acceptable.
