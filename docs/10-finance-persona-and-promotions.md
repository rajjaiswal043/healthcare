# Finance persona and promotions

**Source:** clinic demo calls, 3 Sep 2026. Written for the BRD and for a
developer joining the project who has not seen the codebase.

---

## 1. What is changing, in one paragraph

Today the front desk does everything at the door: finds the patient, registers
them, books, takes the money, checks them in. The clinics we demoed to split that
job in two. **A finance person now meets the patient first** — finds or registers
them, decides which doctor they are seeing, raises the bill, applies a discount if
one has been authorised, and takes the payment. The patient only reaches the front
desk once the money is settled, and the front desk's job shrinks to arrival and the
queue. Alongside it, the clinic wants **promotions**: discounts the administrator
sets up in advance and the finance person applies when told to.

**This is a change of who does what, not a change to how money works.** The
billing engine, the invoice, the payment rows and the pay-first rule already exist
and are unchanged. Most of this requirement is a role, a screen that puts four
existing steps in one flow, a reporting screen, and one genuinely new thing —
promotions.

---

## 2. Requirements

### FR-FIN-01 — A finance role

**What the business needs.** A member of staff whose entire job is money. They can
find and register patients and handle everything financial, and they cannot do
anything clinical or touch the diary.

**Can do**

| Capability                                                         | Why                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| Search for a patient, open their record                            | The first thing they do when someone walks in         |
| Register a new patient                                             | A first-time patient must not be sent to another desk |
| See which doctors are consulting today, and whether they have room | To answer "can I be seen today?" before taking money  |
| Open today's visit for a doctor                                    | So the bill has something to attach to — see 3.1      |
| Raise an invoice, add and remove charges                           | The bill itself                                       |
| Apply an authorised promotion                                      | FR-PRO-02                                             |
| Take a payment and print a receipt                                 | The money                                             |
| See all financial reporting                                        | FR-FIN-03                                             |

**Cannot do**

Book or reschedule a future appointment. Cancel an appointment. Order a test.
Open, read or write a consultation. Prescribe. Record vitals. Refund, waive or
defer — those stay with the administrator, which is already the rule and should
not be relaxed for this role.

**For the developer.** Roles are already editable per clinic at **Settings → Roles
and permissions**, and the permission catalogue lives in
`packages/db/src/permission-catalogue.ts`. Two notes that will save a day:

- Decide with Narveer whether Finance is a **seventh built-in role** or a custom
  role each clinic creates for itself. Recommendation: built-in, because
  onboarding and seat limits address roles by key, and every clinic adopting this
  flow needs the same one.
- **Adding a built-in role needs two changes that must not drift**: an entry in
  `SYSTEM_ROLES`, _and_ a backfill migration that creates the role for clinics
  that already exist. These have drifted apart once before and it caused a bug a
  test eventually caught. Also note migrations run under FORCE ROW LEVEL SECURITY
  — a backfill must loop tenants with `set_config('app.tenant_id', …)` or it will
  match zero rows and report success. See `docs/03-resume-here.md`.

---

### FR-FIN-02 — The finance desk: one screen, one flow

**What the business needs.** Everything the finance person does for a walk-in
patient, in one place, in the order it actually happens — so they are not moving
between four screens with a patient standing in front of them.

**The flow**

1. **Find the patient.** Search by name, mobile or UHID. Existing patients appear
   with enough detail to tell two people of the same name apart.
2. **Or register them.** If they are new, register them here without leaving the
   screen. Same duplicate checking as the front desk uses today.
3. **Choose the doctor.** Show which doctors are consulting today and whether they
   still have room. The finance person needs to answer "can I see Dr Sharma
   today?" before taking any money.
4. **Raise the bill.** The doctor's consultation fee comes in automatically. Other
   priced services can be added.
5. **Apply a promotion, if one has been authorised.** FR-PRO-02.
6. **Take the payment.** Cash, UPI or card, as today.
7. **Print the receipt**, and send the patient to the front desk.

**Acceptance:** a new patient can be found-or-registered, billed and paid in a
single screen without navigating away, and arrives at the front desk with nothing
outstanding.

**For the developer.** Steps 1, 2, 4, 6 and 7 all exist as endpoints already —
this is largely a new screen over work that is done, not a new module.

---

### FR-FIN-03 — Finance reporting

**What the business needs.** The finance person owns the numbers, and the owner
asks them, not the doctor, where the day's money went.

**Must show, for a chosen day or date range:**

| Report                | Content                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| Collections           | Total taken, split by cash / UPI / card                                     |
| By doctor             | Patients seen, gross billed, discount given, net collected — per doctor     |
| Discounts             | Every promotion applied: which promo, how much, by whom, authorised by whom |
| Outstanding           | Bills raised and not paid, and anything deferred                            |
| Refunds and reversals | Money returned to a patient, kept separate from entries recorded in error   |

**Gross billed, discount and net collected must be three separate figures, never
one.** If a ₹600 consultation given free is recorded as a ₹0 bill, the clinic
cannot answer how much it gave away, and cannot pay a doctor on what they billed.
Recording it as ₹600 billed less ₹600 discount answers both.

**For the developer.** A day-end collections report already exists behind the
`report:revenue` permission and separates refunds from entries recorded in error.
This extends it rather than replacing it. Everything is integer paise — never
float, never decimal rupees.

---

### FR-PRO-01 — The administrator sets up promotions

**What the business needs.** The clinic gives discounts for real reasons — a
doctor's own patient, a camp, a staff family member, a hardship case. Today that
is a verbal instruction and a hand-written note. The administrator should be able
to set the discounts up in advance so the finance person applies a known thing
rather than inventing one.

**A promotion has:**

| Field            | Notes                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| Code             | Short, typed or picked at billing, e.g. `CAMP50`                                 |
| Name             | What it is for, in words — read by whoever approves it later                     |
| Type             | **Percentage** or **flat amount**                                                |
| Value            | 1–100 for a percentage; a rupee amount for a flat discount                       |
| Maximum discount | Optional cap on a percentage, so "50% off" cannot become ₹4,000                  |
| Valid from / to  | A camp offer should stop working when the camp ends                              |
| Active           | Switched off without being deleted — past invoices must still explain themselves |

**Rules.** 100% is allowed — it is the "don't charge this patient" case, and is
the whole reason the feature exists. A flat discount larger than the bill reduces
it to zero and never below; the clinic does not owe the patient money because a
promo was too big. A promotion that has ever been used **cannot be deleted or
edited**, only switched off — an invoice from March has to keep explaining itself
in September.

**Only the administrator can create, change or switch off a promotion.** The
finance person applies them and cannot invent one.

---

### FR-PRO-02 — Applying a promotion at billing

**What the business needs.** The administrator rings the finance desk: "this one
is my patient, give them 50%." The finance person applies it and takes the reduced
amount.

**How it must work**

- The discount is **a line on the invoice, not a changed price**. The doctor's fee
  still reads ₹600 and the discount reads −₹300. A bill that simply says ₹300
  loses the fact that anything was given away.
- **Who authorised it is recorded, and is required.** The instruction arrives by
  phone, so the system cannot see it — the finance person must name the person who
  approved it, from the clinic's own staff list. Free text is not enough here.
- A promotion can only be applied **before payment is taken**. Afterwards it is a
  refund or a correction, which is an administrator's job and already exists.
- Applying one is recorded permanently: which promotion, the amount it came to,
  who applied it, who authorised it, and when.

**Why the authorisation matters, stated plainly for the BRD.** Without it, the
record shows the finance person gave away money and shows nothing about the
instruction they were following. That is how discount schemes go wrong in clinics,
and the person most exposed by it is the finance person themselves. Naming the
approver protects them.

---

### FR-FIN-04 — The front desk after this change

**What the business needs.** Once finance takes the money, the front desk checks
the patient in and manages the queue. Billing is no longer its job.

**For the developer.** Do **not** remove billing from the front desk in code. Some
clinics will keep one person doing both, and the roles screen now lets each clinic
decide: a clinic adopting this flow removes `invoice:write` and `payment:collect`
from its own Front desk role. This is configuration, not a code change, and it is
the reason the roles screen was built.

The **pay-first rule already enforces the sequence** — check-in refuses to put a
patient in the queue while money is outstanding, and that lives in the API, not
the UI. So a patient who somehow skips finance is stopped at the front desk
automatically. Nothing new is needed for that.

---

## 3. Decisions Narveer still needs to make

These change the build, and are cheaper to answer now than to discover later.

### 3.1 What does the bill attach to?

Today an invoice hangs off a visit. If finance bills before anyone has booked,
either the bill floats and is matched to the visit later, or **the act of billing
opens the visit**.

**Recommendation: billing opens today's visit.** The finance person picks the
doctor anyway, the system already has a walk-in visit concept, and it keeps the
invoice attached to something real. Note this is _not_ the same as giving finance
the ability to book — opening today's visit for a walk-in and booking Thursday
afternoon are different powers and should be different permissions.

### 3.2 Are doctors paid on gross or net?

A ₹600 consultation given away free: does the doctor's figure show ₹600 or ₹0?
This has no right answer, it is a commercial decision, and it must be settled
before the reports are built because it decides what they add up.

### 3.3 Can finance apply a promotion with nobody named?

**Recommendation: no.** Naming the approver is the control. If the answer is yes,
say so explicitly, because it is a deliberate decision to give the finance desk
unsupervised discretion over price.

### 3.4 Are promo codes told to patients, or internal only?

If patients are ever given a code, the codes need to be hard to guess and the
usage limits matter. If they are purely internal, `CAMP50` is fine. This changes
the design.

### 3.5 Do promotions apply to tests, or only to the consultation fee?

An X-ray and a consultation are both priced services. "50% off" needs to say off
what.

### 3.6 Does finance close a drawer at the end of the day?

Not raised in the demo, and it is usually the next thing asked for once one person
owns the cash. Worth confirming it is out of scope for now rather than assumed in.

---

## 4. What already exists, so nothing gets rebuilt

| Already built                                                   | Where                                    |
| --------------------------------------------------------------- | ---------------------------------------- |
| Invoices, charges, payments, receipts                           | `docs/04-billing-plan.md`                |
| Pay-first gate at check-in                                      | `AppointmentsService.checkIn`            |
| Day-end collections report, split by method                     | Reports, `report:revenue`                |
| Refunds, waivers, deferrals — administrator only, with a reason | `docs/04`, and `payment.correction_kind` |
| Editable roles and permissions per clinic                       | Settings → Roles, `docs/06` section 9    |
| Patient search, registration, duplicate detection               | Patients module                          |

**Rules the new work must not break:** money is integer paise everywhere; payments
are append-only rows, never edited or deleted, and a correction is a new
compensating row; every clinic's data is isolated by row-level security, so every
new table needs its tenant policy and `pnpm rls:check` will fail the build if it is
missing.
