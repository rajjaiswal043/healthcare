# Consultation and prescription — plan

Module 3 of the BRD. This is the screen a doctor uses while the patient is in
the room, and it is the half of the clinic story the product currently cannot
tell: the queue ends at "call" and "complete", and nothing is recorded in
between.

Status: **plan**. Nothing here is built yet.

---

## 1. What the demo has to show

A receptionist registers a patient, books them, checks them in. The doctor calls
them from their day list, opens the consultation, records what happened, writes a
prescription, and hands the patient something printed. Then the visit closes and
the note is part of the record forever.

Anything that does not serve that sentence is out of scope for this round.

---

## 2. Three decisions worth arguing with

### 2.1 A signed consultation is never edited, only amended

Once the doctor signs off, the note is immutable. Corrections are **addenda** —
new rows, timestamped and attributed, displayed beneath the original.

This is the single most consequential decision in the module, and it will feel
obstructive the first time someone fixes a typo. It stands anyway. A clinical
note that can be silently edited is worthless as evidence, and the questions this
record eventually gets asked — "what did the doctor know on the 3rd of March, and
when did they know it" — cannot be answered by a table whose rows change. NMC
record-keeping expects the same thing, and the DPDP Act's accuracy obligations
are satisfied by a visible correction, not an invisible one.

The cost is a slightly clumsier UI. The alternative is a record nobody can
defend.

Before signing, the note is a **draft** and freely editable. The doctor is not
signing every keystroke.

### 2.2 Prescriptions are structured rows, not a text box

One row per drug, with dose, frequency, duration, route and instructions as
separate fields — not "Tab Azithral 500 1-0-1 x 3 days" in a textarea.

A textarea is faster to build and faster to type into, and every clinic in India
would accept it. It is still wrong, because everything the product needs to do
later reads these fields: interaction checking, repeat prescriptions, ABDM
record exchange as `MedicationRequest`, and the simple question "how much
azithromycin did we prescribe last month". None of that can be recovered from
free text afterwards, and by then there are a hundred thousand rows of it.

The structure is the point. The typing burden is mitigated by defaults and by
the formulary below, not by abandoning it.

### 2.3 A seeded formulary, with free text allowed anyway

Drugs come from a per-tenant formulary the clinic can edit. But the field also
accepts anything typed into it.

Both halves matter. With no list, every prescription is a spelling variant and
the structured fields in 2.2 buy nothing. With a _mandatory_ list, the first
drug a clinic stocks that we did not seed makes the software unusable at the
worst possible moment — mid-consultation, patient waiting.

So: seed roughly 150 common Indian generics and brands, autocomplete against
them, and let anything else through. Free-text entries are flagged so a clinic
can promote the ones it uses into its own formulary later.

---

## 3. Data model

FHIR-aligned, per ADR-013 — the names are FHIR's even where the shape is ours.

| Model               | FHIR                 | Notes                                                                  |
| ------------------- | -------------------- | ---------------------------------------------------------------------- |
| `Encounter`         | Encounter            | One per visit. Created when the doctor opens the consultation.         |
| `VitalsObservation` | Observation          | Height, weight, BP, pulse, temperature, SpO2. BMI derived, not stored. |
| `Diagnosis`         | Condition            | Coded (ICD-10) plus free text. Multiple per encounter, one primary.    |
| `Prescription`      | MedicationRequest    | One row per drug.                                                      |
| `FormularyItem`     | Medication           | Per-tenant drug list.                                                  |
| `EncounterAddendum` | Provenance / amended | Corrections after signing.                                             |

`Encounter` carries the narrative fields directly — chief complaint, history,
examination, advice, follow-up date — rather than splitting them into a separate
note table. They are one-to-one with the encounter and always read together;
a second table would buy nothing but a join.

**BMI is derived at read time, never stored.** A stored BMI disagrees with its
height and weight the moment either is corrected, and then two numbers claim to
be true.

### Why vitals are their own table

They could be columns on `Encounter`. They are not, because a nurse records them
before the doctor sees the patient, they can be taken more than once in a visit,
and the same shape will later carry readings taken outside a consultation
entirely. One row per observation set, with a timestamp and a recorder.

---

## 4. Scope

### In

| BRD ref   | Feature                                                          |
| --------- | ---------------------------------------------------------------- |
| FR-CON-01 | Open a consultation from the queue / day list                    |
| FR-CON-02 | Record vitals                                                    |
| FR-CON-03 | Chief complaint, history, examination findings                   |
| FR-CON-04 | Diagnosis with ICD-10 coding, one marked primary                 |
| FR-CON-05 | Structured prescription against a formulary                      |
| FR-CON-06 | Advice and follow-up date                                        |
| FR-CON-07 | Sign the consultation — locks it, completes the appointment      |
| FR-CON-08 | Amend a signed consultation via addendum                         |
| FR-CON-09 | Printable prescription carrying the doctor's registration number |
| FR-CON-10 | Past consultations visible on Patient 360                        |

### Out, deliberately

| Feature                        | Why                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Drug interaction checking      | Needs a licensed interaction database. Clinical safety claim we cannot make on seeded data.                         |
| Lab and imaging orders         | Module 4. Nothing to send them to yet.                                                                              |
| Note templates and favourites  | Real time-saver, but it optimises a workflow nobody has used yet.                                                   |
| Digital signature certificates | "Signed" here means attributed and locked, not cryptographically signed. Real e-signature is an ABDM-phase concern. |
| PDF generation service         | The browser prints. A PDF pipeline is infrastructure for a feature a print stylesheet already delivers.             |
| Voice / handwriting input      | Phase 5 at the earliest.                                                                                            |

---

## 5. Permissions

Two new strings, added to `packages/db/src/permissions.ts` — the single
definition, for the reason recorded in that file.

| Permission           | Held by              |
| -------------------- | -------------------- |
| `consultation:read`  | Doctor, nurse, owner |
| `consultation:write` | Doctor               |
| `vitals:write`       | Doctor, nurse        |
| `prescription:write` | Doctor               |

A nurse records vitals and reads the note; only a doctor diagnoses and
prescribes. The front desk gets neither — a receptionist has no business reading
a clinical note, and "they can see it anyway" is not a reason to grant it in the
model.

---

## 6. Risks

**The signing lock is easy to get wrong.** If the lock is enforced only in the
UI, it is not a lock. It belongs in the service, with an integration test that
attempts to modify a signed encounter over HTTP and expects a 409.

**Prescription printing carries legal content.** The doctor's registration
number is required on a prescription under the Drugs rules. If it is missing from
the practitioner record, the print must say so loudly rather than print a
document that looks valid and is not.

**Vitals ranges need bounds.** A weight of 700 kg is a typo, and a system that
accepts it will eventually chart it. Validation with clinically plausible ranges,
and a confirm step rather than a hard refusal at the edges.
