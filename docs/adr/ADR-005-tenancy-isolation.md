# ADR-005 — Tenant isolation via shared schema and Postgres Row-Level Security

**Status:** Accepted (6 Aug 2026)
**Deciders:** Narveer
**Related:** ADR-004 (Prisma), ADR-003 (PostgreSQL 18)

## Context

The platform is multi-tenant: each hospital or clinic is a tenant, and a tenant may have several locations. Every table holding patient data is therefore tenant-scoped.

Three facts shape this decision:

1. **The data is sensitive personal data under DPDP.** A cross-tenant read means one hospital seeing another's patients. Under the DPDP Act 2023 and Rules 2025, security-safeguard failures carry penalties up to ₹250 crore, and the hospital — our customer — is the data fiduciary carrying that exposure.
2. **The build is solo.** There is no second reviewer. Any control that depends on a developer remembering something will eventually fail, and there is no code review to catch it.
3. **The commercial target is 10–150-bed facilities** (BRD §14.3), scaling to ≥100 tenants (NFR-02). Per-tenant fixed costs break the price point.

The failure mode we are designing against is specific and mundane: a repository method that omits `WHERE tenant_id = ?`. Not an attacker — a typo.

## Decision

**Shared schema, every tenant-scoped table carries `tenant_id`, and PostgreSQL Row-Level Security enforces isolation at the database.**

1. Every tenant-scoped table has a non-null `tenant_id` and an RLS policy:
   `USING (tenant_id = current_setting('app.tenant_id')::uuid)`
2. Every such table is declared `FORCE ROW LEVEL SECURITY`, so the policy applies even to the table owner.
3. The application connects as a **non-owner role**. Table ownership and migrations use a separate role. RLS does not apply to a table's owner by default, so this separation is what makes the policy real rather than decorative.
4. Tenant context is set per transaction via `SET LOCAL app.tenant_id`, wired through a Prisma client extension so no caller can forget it.
5. **`pnpm verify` fails if any table lacks `tenant_id` or an RLS policy.** This check is written before the first table exists, so it can never be retrofitted onto a non-compliant schema.
6. An integration suite asserts that cross-tenant reads return zero rows _even when the service layer is deliberately handed another tenant's ID_.

The application-layer guard stays too. This is defence in depth: the guard gives good errors, the database gives guarantees.

## Alternatives considered

**Application-layer filtering only.** Simplest, and what most products do. Rejected: it makes a single omitted `WHERE` clause into a notifiable breach, and with no second reviewer the probability of that omission over a multi-year build approaches certainty.

**Schema per tenant.** Strong isolation, easy per-tenant export and offboarding. Rejected: every migration must fan out across every schema — an operation that gets slower and riskier with each customer, run by one person. Connection pooling also degrades badly past a few dozen schemas. It optimises for an offboarding story we can satisfy other ways (NFR-11 export).

**Database per tenant.** Strongest isolation, worst economics. Rejected outright against the price point.

## Consequences

**Good**

- Isolation survives developer error, which is the actual threat model.
- One migration run covers all tenants.
- No per-tenant fixed cost; a new tenant is a row.
- Gives a concrete, demonstrable answer to the security-review question every hospital IT committee asks.

**Costs, accepted**

- Prisma setup is more involved: all tenant-scoped queries must run inside a transaction that has set the GUC. The client extension makes this the default path rather than a thing to remember.
- Local dev needs two database roles, hence `infra/local/bootstrap.sql`.
- Connection pooling must not leak session state between tenants. `SET LOCAL` is transaction-scoped, which is precisely why it's used here rather than `SET`.
- Genuinely cross-tenant work (platform admin, aggregate analytics) needs an explicit, audited escape hatch rather than ambient access. Treated as a deliberate, logged privilege.

**Reversibility**
Poor, and knowingly so. Moving to schema-per-tenant later means a data migration per tenant plus a rewrite of the data-access layer. This is why it was settled before any domain table existed.
