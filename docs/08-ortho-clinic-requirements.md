# Requirements from the orthopaedic clinic demo — 26 Aug 2026

Five points from the call with the orthopaedic consultant who is taking the
system. Written as BRD-ready requirements: what he asked for, what it means in
this codebase, what is already there, and the decisions that have to be made
before any of it can be built.

**Proposed IDs are provisional.** They follow the existing convention but were
written without the BRD open — check them against it before pasting, especially
the `FR-P36-*` series, which is already sparsely numbered.

---

## Summary

| #   | Ask                                                     | Proposed ID  | Size      | Blocked on a decision?              |
| --- | ------------------------------------------------------- | ------------ | --------- | ----------------------------------- |
| 1   | A free-text note block on the prescription              | FR-CON-11    | Small     | No                                  |
| 2   | X-ray and lab departments; attach an X-ray to a patient | FR-DIA-01…05 | **Large** | **Yes — storage, and DICOM**        |
| 3   | Correct patient data entered by mistake                 | FR-P36-20…22 | Medium    | **Yes — how far the right extends** |
| 4   | Only an administrator may correct finance, with history | FR-BIL-11…13 | Medium    | **Yes — what "consent" means**      |
| 5   | Show the last visit's history                           | FR-P36-23…24 | Medium    | **Yes — where he expected it**      |

Two of these are much bigger than they sound (2 and 5), and two are mostly
already built and need surfacing rather than building (4 and, in part, 5).

---

## 1. A note block on the prescription

> _"need to add block in prescription for writing some note"_

### What exists

The consultation already stores four narrative fields — `chiefComplaint`,
`historyOfPresentIllness`, `examinationFindings` and `advice` — and the printed
prescription renders **`advice`** under an "Advice" heading. So there is already
a free-text block on the printed sheet.

This is very likely one of two things, and they need different work:

- **(a) He did not find `advice`** — it is below the medicines on the
  consultation screen and easy to miss. Then this is a labelling and layout
  problem, not a missing feature.
- **(b) He wants a note that is NOT advice to the patient** — a line to the
  pharmacist, a note to himself for next time, or something handwritten-in-spirit
  that sits apart from the clinical narrative.

**Ask him which.** If (a), this is half an hour. If (b), it is the requirement
below.

### Requirement

**FR-CON-11 — Prescription note. BUILT, 26 Aug 2026.** Narveer chose: printed
and separate from Advice, sitting directly below the medicines on the
consultation screen, bounded at 1000 characters. The bound is enforced in three
places — the textarea, the DTO, and a database CHECK — because each is the last
line of defence for a different caller.

**FR-CON-11 — Prescription note.** The consultation shall provide a free-text
note that prints on the prescription in its own block, distinct from Advice.
Maximum 1000 characters. Optional. Included in the signed record and therefore
immutable once signed (FR-CON-09), correctable only by addendum.

**Acceptance**

- A note entered during consultation appears on the printed prescription under
  its own heading, below Advice.
- An empty note prints nothing at all — no empty heading, no blank space.
- The note is carried into the encounter's signed content and appears in the
  patient's visit history.
- After signing, the note cannot be edited; an addendum is the correction path.

**Open question for the doctor:** should this note be visible to the patient
(printed) or internal to the clinic (screen only, not printed)? These are two
different fields and the answer changes the design. If both are wanted, say so
now — retrofitting a second one later is more work than adding two today.

---

## 2. X-ray and laboratory departments, with results attached to the patient

> _"need to add the xray and blood test department so they can attach the xray
> against patient"_

**This is the largest item on the list by a wide margin, and it is really three
features.** Splitting them is what makes it schedulable.

### What exists

- `Department` already exists (name, display order, active flag) and is used to
  group doctors on the booking screen. **Creating "X-ray" and "Pathology" as
  departments is already possible today** — Settings → Doctors and hours.
- The queue already models a patient leaving for tests and returning:
  `AWAITING_TESTS`, `sentOutAt`, `sentOutReason`, `returnedAt`
  (`docs/05-token-queue-plan.md`). So the _workflow_ half exists.
- **No file storage of any kind exists** for clinical documents. The only binary
  the system stores is a clinic logo, and that is deliberately a 512KB PNG kept
  in Postgres (`docs/07`, section 4).

### The decision that gates everything else

**An X-ray is not a logo.** A plain-film JPEG is 2–10MB; a DICOM study is
20–200MB. That does not go in Postgres, and the `BrandingStore` interface built
last week was written specifically so that the day this arrived, moving to an
object store would be a new adapter rather than a rewrite. **That day is now.**

So FR-DIA-02 below is really "build the storage module", and it should be
costed as such: an S3 bucket, an IAM role, presigned upload and download URLs,
lifecycle rules, and a decision about encryption at rest. It is a week of work
that has nothing to do with X-rays specifically, and everything after it depends
on it.

### Requirements

**FR-DIA-01 — Diagnostic departments.** The clinic shall be able to create
departments that provide diagnostics rather than consultations (X-ray,
pathology), and assign staff to them. Such a department has no appointment
slots and does not appear on the booking screen.

**FR-DIA-02 — Document storage.** The system shall store clinical documents
(images, PDFs, reports) against a patient, in an object store, encrypted at
rest, with access authorised per request and per tenant. Documents shall never
be served from a public URL; every read shall be attributable to a session.

**FR-DIA-03 — Diagnostic order.** A doctor shall be able to raise an order
against a visit ("X-ray, left knee, AP and lateral"), which appears as work for
the named diagnostic department and links back to the visit that raised it.
This replaces the free-text `sentOutReason` currently captured when a patient is
sent out of the queue.

**FR-DIA-04 — Result attachment.** Diagnostic department staff shall be able to
attach one or more files and a short report against an order. Attaching a result
shall mark the order complete and notify nothing — the patient returns to the
queue by the existing return flow (FR-APT-17).

**FR-DIA-05 — Results in the consultation.** A doctor shall see, within the
consultation screen, the results attached to the current visit and to previous
visits, and shall be able to open an image without leaving the consultation.

**Acceptance (FR-DIA-04)**

- A file up to 50MB is accepted; type is determined from content, not filename.
- A result is visible to the ordering doctor within the same visit.
- A result attached at one clinic is unreachable from another, asserted by the
  cross-tenant isolation suite.
- Deleting a result is not possible; superseding it with a corrected one is.

**Open questions**

1. **DICOM or ordinary images?** If the clinic's X-ray machine outputs DICOM and
   he expects to view it in the browser, that is a viewer project — measured in
   weeks, not days. If he will attach a JPEG or a PDF exported from the machine's
   own console, this is ordinary file upload. **Ask him what comes off the
   machine.** This single answer changes the estimate by an order of magnitude.
2. **Does the clinic do its own blood tests, or send them out?** If they send
   them out, "pathology department" is really "external lab", and the
   requirement is recording a result that arrives on paper, not staffing a
   department.
3. **Retention.** Medical imaging carries statutory retention periods in India.
   Decide the period before choosing S3 lifecycle rules, because moving 200MB
   studies between storage classes afterwards is expensive.

---

## 3. Correcting data entered by mistake

> _"doctor or xray department or staff can change the data of patient if
> mistakly they written or submitted wrong"_

### What exists

- **Patient demographics are currently read-only after registration.** This is a
  known gap (`docs/03-resume-here.md`, section 4) and the most-requested missing
  feature. Point 3 is largely this.
- **A signed consultation is deliberately immutable** and corrected by addendum
  (FR-CON-09). That is a clinical-records decision, not an oversight: a
  prescription that can be silently rewritten after dispensing is not a record.

### The distinction the BRD must draw

These are two different things and the doctor is likely to hear them as one:

| Data                                                   | Correction model                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| Patient demographics — name, age, sex, mobile, address | **Edit in place**, with the previous value kept in the audit trail |
| An unsigned consultation                               | Edit freely; nothing has been committed                            |
| A **signed** consultation, prescription or diagnosis   | **Addendum only.** The original stays exactly as written           |
| A diagnostic result                                    | Supersede with a corrected version; the original stays             |

**Say this to him explicitly before building.** "You can fix a typo in the phone
number, but you cannot rewrite yesterday's prescription — you add a correction
to it" is a sentence he will either accept immediately or push back on, and it
is far cheaper to have that conversation now.

### Requirements

**FR-P36-20 to FR-P36-22 — BUILT, 27 Aug 2026.** Narveer chose: everything
except UHID and ABHA is correctable; front desk and doctors only (the roles that
already hold `patient:write`); and previous values ARE kept, in a new
`patient_correction` table readable with `audit:read`.

That last choice is a deliberate exception to the audit trail's rule of
names-without-values, and it has a cost worth restating: **the table holds
patient data, so a DPDP erasure request now has a second place to reach in the
database and a third in S3 — and there is still no erasure process.**

Two behaviours decided while building it. Setting a date of birth clears the
stored age and vice versa, because an age recorded two years ago beside a newly
known birth date is worse than no age. And a correction that creates a duplicate
is allowed with a warning rather than refused — blocking would leave the clinic
holding both the typo and the duplicate, and merging remains the fix.

**FR-P36-20 — Edit patient demographics.** A user holding `patient:write` shall
be able to correct a registered patient's demographics. Every change shall record
who changed what, when, and the previous value.

**FR-P36-21 — Correction is not deletion.** A patient record shall not be
deletable. Merging duplicates (FR-P36-16) remains the route for a patient
registered twice.

**FR-P36-22 — Visible history of corrections.** The patient record shall show
that a field was corrected, by whom and when. The previous value shall be
visible to users holding `audit:read`.

**Acceptance**

- Correcting a mobile number writes an audit event naming the field, not the
  value, in the event itself; the previous value is retrievable from the audit
  detail by an administrator.
- UHID cannot be edited by anyone. It is printed on cards and quoted on paper.
- A signed consultation offers "add an addendum", never "edit".

**Open question:** should a **doctor** be able to correct demographics, or only
the front desk? He asked for "doctor or xray department or staff", which is
everyone. That is defensible in a small clinic and worth confirming rather than
assuming — the permission already exists (`patient:write`) and today only the
front desk and doctors hold it.

---

## 4. Finance corrections, administrator only, with history

> _"only admin can change the finance data if some thing went wrong and that
> entry should present the history record with consent"_

### What exists — most of this, and it is stronger than he thinks

This is the requirement the system is already closest to satisfying, because the
rules were built into the database rather than the application:

- **A payment can never be edited or deleted.** `REVOKE UPDATE, DELETE ON
payment` — the application role physically cannot do it. Money movements are
  append-only rows, and the balance is derived from them.
- **An invoice can never be deleted**, for the same reason.
- Corrections are already modelled as new entries rather than edits: **refund**,
  **waive**, **defer** and **cancel** all exist, each writes an audit event, and
  each records who did it.
- Waive and refund are already restricted — the front desk can take money but
  cannot make it leave without a service behind it.

**So the correct framing for the BRD is not "let the admin change finance data".
It is "the admin can post a correcting entry, and the trail shows both".** Tell
him that. A clinic owner usually hears it as a stronger promise, not a weaker
one: nothing in his books can be quietly altered, including by us.

### Requirements

**FR-BIL-11 to FR-BIL-13 — BUILT, 27 Aug 2026**, and most of it turned out to
already exist. `REVOKE UPDATE, DELETE ON payment` meant corrections were already
compensating entries; refund, waive, defer and cancel were already
administrator-only and already required a reason. FR-BIL-12 needed nothing.

What was actually missing:

- **The reason was captured and shown to nobody.** It had been stored since the
  billing module was written and never returned. The invoice now shows, to
  anyone who can read it, who corrected what, when and why — Narveer's choice
  over restricting it to `audit:read`.
- **A reversal looked identical to a refund.** New `payment.correction_kind`:
  `PATIENT_REFUND` (money left the drawer) or `RECORDED_IN_ERROR` (it was never
  there). Required with no default, because the two net to the same figure and
  are completely different problems for whoever counts the cash. The day-end
  report now reports both separately alongside the unchanged total.
- **There was no refund UI at all** — corrections were API-only. The payment
  dialog now offers both kinds to an administrator.

No approval step: the recorded reason is the control, matching how refund, waive
and defer already worked. A correction lands on the day it is made, never
retroactively on the day of the original entry — rewriting a closed day means a
report that changes after somebody has acted on it.

**FR-BIL-11 — Corrections are entries, never edits.** A financial record, once
written, shall not be modified or removed. A mistake shall be corrected by a
compensating entry that references the original.

**FR-BIL-12 — Corrections are administrator-only and reasoned.** Posting a
correction shall require an administrator, and shall require a reason recorded
in free text. A correction without a reason shall be refused.

**FR-BIL-13 — The trail is visible in the clinic, not only in the audit log.**
An invoice that has been corrected shall show, on the invoice itself, what was
corrected, by whom, when and why — visible to any user who can read the invoice,
without needing `audit:read`.

**Acceptance**

- An administrator can reverse a wrongly recorded payment; both the original and
  the reversal appear on the invoice with the reason.
- A front-desk user attempting the same is refused.
- The day-end collections report reflects the correction on the day the
  correction was posted, not by retrospectively changing a closed day.
- No route exists, at any permission level, that updates or deletes a `payment`
  row.

**Open question — what does "with consent" mean?** Three readings, and they are
materially different:

1. **A recorded reason** — the administrator types why. Cheapest, and what
   FR-BIL-12 assumes.
2. **A second person approves** — maker-checker: one person proposes, another
   approves. Real work, and genuine control for a clinic where the owner is not
   present daily.
3. **The patient consents** — a signature or acknowledgement from the patient
   that their bill was corrected.

**Ask him.** I have written the requirement as (1) because it is the common
meaning and the smallest thing that satisfies the ask, but (2) is what a clinic
owner often actually wants.

---

## 5. Last visit's history is not showing

> _"Patient history from last visit is also not showing, (Need to improve
> Patient 360 view)"_

### What exists

The Patient 360 page **does** list previous visits, and each row carries the
date, the doctor, the chief complaint, the diagnoses and a count of medicines
prescribed. So "not showing" is unlikely to be literally true, which makes this
the point most in need of clarification before anything is built.

Three candidate readings:

- **(a) He was in the consultation screen, not the patient page.** While
  consulting, there is no view of the previous visit at all — he would have to
  leave the consultation to see it. **This is my strongest guess** and it is a
  real gap: the question a doctor asks mid-consultation is "what did I give her
  last time", and today the answer requires navigating away and losing his place.
- **(b) The list is there but shows too little.** It gives a diagnosis and
  "3 medicines" — not _which_ medicines, not the dose, not the vitals. For a
  follow-up that is not enough to act on.
- **(c) It was genuinely empty** because that patient's earlier visits predated
  the consultation module, or the visits were never signed.

**Ask him to show you the screen he was on.** (a) and (b) are different features;
(c) is not a feature at all.

### Requirements

**FR-P36-23 — BUILT, 27 Aug 2026**, together with checkpoint 4 of docs/09,
because they are the same panel.

**FR-P36-23 — Previous visit inside the consultation.** The consultation screen
shall show a summary of the patient's most recent previous visit — date, doctor,
diagnoses, medicines prescribed with dose, and vitals — without leaving the
consultation, and shall allow the doctor to expand it to the full note.

**FR-P36-24 — Repeat a previous prescription.** The doctor shall be able to
carry the previous visit's medicines into the current prescription in one action,
as editable lines rather than as a committed copy.

**Acceptance**

- Opening a consultation for a patient with previous visits shows the most
  recent one without a further click.
- The summary names each medicine with its dose and duration, not a count.
- A patient with no previous visits shows a plain "first visit" state, not an
  empty panel.
- Carrying medicines forward produces editable draft lines; nothing is
  prescribed until the doctor signs.

**FR-P36-24 was not asked for.** It is included because it is the reason doctors
want the previous visit on screen — in an orthopaedic follow-up the answer is
usually "the same again, for two more weeks" — and it is small once FR-P36-23
exists. Drop it if he does not want it.

---

## Suggested order of work

Sequenced by what unblocks what, not by size:

1. **FR-P36-23** — previous visit in the consultation. Highest value per day of
   work, directly addresses point 5, and needs nothing new underneath it.
2. **FR-CON-11** — the prescription note, once he has confirmed which kind.
   Possibly nothing at all, if `advice` was what he wanted.
3. **FR-P36-20…22** — editing a patient. Already the top of the existing backlog;
   his ask makes it urgent rather than merely overdue.
4. **FR-BIL-11…13** — surface the corrections that already exist, add the
   administrator-only reversal and put the trail on the invoice.
5. **FR-DIA-01…05** — diagnostics. Last, because FR-DIA-02 is a storage project
   with its own infrastructure, and because it is the only one of the five that
   cannot be demonstrated to him in a fortnight.

Points 1–4 are demonstrable inside two weeks. Point 2 is a month, and most of
that month is object storage rather than anything he would recognise as X-rays —
worth telling him plainly so the wait is expected rather than discovered.

---

## Answers needed from the doctor

Collected here so they can go back in one message:

1. The prescription note — patient-facing (printed) or internal? Is `advice`
   already what he meant?
2. What comes off the X-ray machine — DICOM, or JPEG/PDF from its console?
3. Blood tests — done in-house, or sent to an external lab?
4. "With consent" on a finance correction — a typed reason, a second person's
   approval, or the patient's acknowledgement?
5. Which screen was he on when the last visit's history was missing?
6. Should doctors be able to correct patient demographics, or only the front desk?
