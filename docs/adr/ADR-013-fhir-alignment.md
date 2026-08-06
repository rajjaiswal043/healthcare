# ADR-013 — FHIR R4 as a modelling constraint, not a storage format

**Status:** Accepted (6 Aug 2026)
**Deciders:** Narveer
**Related:** BRD §7.6, §11.1

## Context

ABDM uses FHIR R4 as its record format. Milestones M2 (share records as a Health Information Provider), M3 (fetch them as a Health Information User) and M4 (NHCX claims) all exchange FHIR resources. The BRD's own strategic argument (§7.6) is that FHIR alignment is cheap on day one and expensive to retrofit — and it's right.

But the product being built is a **CRM and clinic-management system**, not a record-exchange gateway. Its actual query workloads are things like: the doctor's queue for today, outstanding receivables by payer and age, referral conversion by source, patients with an overdue follow-up. These are relational, aggregate, filtered queries over operational data.

So there are two pressures: exchange demands FHIR shapes, operations demand relational shapes.

## Decision

**Relational tables, named and shaped to FHIR R4 concepts, with a dedicated mapping layer that emits and parses FHIR resources.** FHIR is a constraint on the model and a boundary format — not the storage format.

Concretely:

1. Domain tables are ordinary normalised Postgres tables, but their **names, field names and cardinalities follow FHIR R4 concepts**. Our diagnosis table looks like `Condition`; our appointment like `Appointment`; our prescription like `MedicationRequest`. Where FHIR has a coded field, we store a code plus a system, not free text.
2. Terminology is first-class: ICD-10 now, SNOMED CT and LOINC as the model allows, stored as `(system, code, display)` rather than strings.
3. **`packages/fhir`** holds the mappers — pure functions from our entities to FHIR resources and back. No mapping logic leaks into domain services.
4. Genuinely FHIR-shaped extension data that has no relational home goes in a JSONB column, deliberately and sparingly — not as a general escape hatch.
5. Identifier modelling follows FHIR from the start: the local UHID and the national ABHA number/address are both `Patient.identifier` entries with distinct systems, rather than two ad-hoc columns.

## Alternatives considered

**Store FHIR resources as JSONB and treat them as the source of truth.** Superficially attractive — M2/M3 become trivial, no mapping layer. Rejected: it destroys the operational queries that are the actual product. "Receivables by payer over 90 days" against a JSONB document store means either enormous GIN-indexed queries or a parallel relational projection — at which point you have both models anyway, plus a synchronisation problem. It also makes ordinary things like a foreign key or a check constraint impossible.

**Ignore FHIR until M2 is actually needed.** Rejected, and the BRD already rejects it: retrofitting FHIR onto a shipped relational model is the expensive path. Naming a column `diagnosis_text` today and discovering it must become a coded `Condition.code` after real patient data exists is a migration nobody enjoys.

**Adopt a full FHIR server (HAPI or similar) alongside our database.** Rejected for a solo build: two datastores, two consistency models, and an operational burden out of all proportion to a milestone that is currently parked.

## Consequences

**Good**

- Operational queries stay fast and ordinary — indexes, joins, constraints all work normally.
- M2/M3/M4 become integration work: write mappers, wire the gateway. This is exactly the outcome BRD §7.6 asks for.
- Coded-from-the-start terminology means we aren't retrofitting clinical coding onto free text later, which is the genuinely painful version of this migration.

**Costs, accepted**

- A mapping layer must be written and kept correct. Mitigated by mappers being pure functions, which are cheap to test exhaustively.
- FHIR naming occasionally feels verbose against a plain CRUD screen. Accepted deliberately: the alternative is a vocabulary mismatch that compounds for years.
- Some FHIR concepts don't map cleanly onto Indian clinic reality (OPD token culture, UHID, TPA workflows). Where they diverge, **our model wins and the mapper handles the impedance** — we are not distorting the product to please a standard we don't yet exchange with.

**Reversibility**
Moderate. Adding the mapper later is possible; renaming shipped columns and back-coding free-text clinical data is not. The expensive half is done first, which is the point.
