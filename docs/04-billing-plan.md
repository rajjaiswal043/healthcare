# Billing and payments — plan

Module 4. OPD billing: what a visit costs, who collected it, and what the clinic
took today.

Status: **built** as of 7 Aug 2026 — schema, API, 31 integration tests, payment
dialog on the queue board, and the collections report. Verified end to end in a
browser: check-in refused with "₹500.00 outstanding on invoice INV-000057",
₹200 cash then ₹300 UPI, then admitted.

---

## 1. The decision everything else follows from

**Payment is collected before the consultation.** Narveer confirmed this on
7 Aug 2026, and it is not a display preference — it puts billing _inside_ the
queue flow rather than beside it.

Concretely: **check-in does not issue a token until the visit is paid, waived, or
explicitly marked pay-later.** The gate is at check-in, not at the consultation,
even though the rule is "pay before consulting". The reason is who finds out:

- Gate at check-in → the **receptionist** discovers an unpaid visit, at the desk,
  with the patient standing in front of them and a card machine to hand.
- Gate at the consultation → the **doctor** discovers it, with the patient
  already in the room, and the only available action is to send them back out.

So the hard rule lives at check-in. The consultation keeps a second check as a
backstop — a visit that reached the doctor unpaid is a bug, and it should surface
as a refusal rather than as free care nobody notices until the day-end report.

**Pay-later is a deliberate, recorded exception, not a loophole.** It needs the
`invoice:defer` permission, a reason, and it shows on the queue board as an
unpaid flag until settled. A clinic that never wants it simply does not grant the
permission. Without an escape hatch, the first emergency walk-in at 9pm with no
cash would have the front desk registering fake payments — which is worse than
recording the truth.

---

## 2. Money is stored in paise, as integers

Every amount in the schema is `Int`, in paise. Never a float, never a decimal
rupee.

Floating point cannot represent ₹0.10 exactly, and a system that adds up a few
thousand consultation fees a month with `Float` will disagree with the cash
drawer by rupees within a year — and there is no way to tell which of the ten
thousand rows is wrong. `Decimal` would be defensible, but it arrives from
Prisma as an object that needs converting at every boundary, and this is the one
place where a silent conversion mistake is a financial error.

So: `amountPaise: Int`. `₹350.00` is `35000`. Formatting happens once, at the
edge, in one helper.

---

## 3. GST

Healthcare services provided by a clinical establishment are **exempt** from GST
under Notification 12/2017 — a consultation carries no tax. Pharmacy sales,
consumables and cosmetic procedures are not exempt.

So the tax rate lives on the line item and defaults to zero, rather than being
absent. Modelling it as absent would mean a migration against live invoice data
the first time a clinic sells a strip of tablets, and back-filling tax onto
historical invoices is not something anyone wants to explain to an auditor.

Nothing computes GST in this round beyond `taxPaise` per line, because nothing
taxable is sold yet.

---

## 4. Data model

| Model            | Notes                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `Service`        | The chargeable catalogue: consultation, follow-up, dressing, injection.  |
| `Invoice`        | One per appointment, plus standalone invoices later.                     |
| `InvoiceLine`    | One row per charged item, with its own price and tax.                    |
| `Payment`        | One row per tender. Several per invoice — part cash, part UPI is normal. |
| `InvoiceCounter` | Per-tenant serial receipt numbers.                                       |

### Why payments are rows, not a column

An invoice does not have "a payment". A patient pays ₹200 cash and ₹300 by UPI;
a refund is a third row. Storing `paidAmount` on the invoice loses who tendered
what, which is exactly what the day-end reconciliation needs — the drawer is
counted by mode, not in total.

The invoice's `status` and outstanding balance are **derived from the payment
rows**, not stored alongside them where they can drift.

### Receipt numbers must be serial and gapless

A receipt is a financial document. Numbers come from a per-tenant counter using
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, the same atomic pattern as the
UHID and queue-token counters, for the same reason: `SELECT max + 1` hands two
receptionists the same number.

### A cancelled invoice is voided, never deleted

Same principle as the clinical note. A deleted invoice is indistinguishable from
one that never existed, and "we cancelled it" is a claim you have to be able to
prove.

---

## 5. Scope

### In

| BRD ref   | Feature                                                                 |
| --------- | ----------------------------------------------------------------------- |
| FR-BIL-01 | Per-tenant service catalogue with prices                                |
| FR-BIL-02 | Invoice raised automatically when an appointment is booked or walked in |
| FR-BIL-03 | Collect payment — cash, UPI, card, bank transfer — including split      |
| FR-BIL-04 | Check-in refuses to issue a token on an unpaid visit                    |
| FR-BIL-05 | Waive a charge, with a reason and a permission                          |
| FR-BIL-06 | Defer payment (pay later), with a reason and a permission               |
| FR-BIL-07 | Serial receipt numbers, printable receipt                               |
| FR-BIL-08 | Refund against a paid invoice                                           |
| FR-BIL-09 | Day-end collection summary, by mode and by collector                    |
| FR-BIL-10 | Unpaid and deferred visits visible on the queue board                   |

### Out, deliberately

| Feature                       | Why                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Payment gateway integration   | Needs a merchant account. UPI is recorded by reference, not captured.                                |
| Insurance and TPA claims      | Module 5. A different workflow, not a payment mode.                                                  |
| Pharmacy and inventory        | A stock system, not a billing one.                                                                   |
| Packages and discounts scheme | Wants real pricing data to design against.                                                           |
| Accounting export (Tally)     | Worth doing, once a clinic asks for the format they actually use.                                    |
| Credit notes                  | Refunds cover the current need; credit notes are an accounting concept the clinic has not asked for. |

---

## 6. Permissions

| Permission        | Held by                  |
| ----------------- | ------------------------ |
| `invoice:read`    | Front desk, owner, admin |
| `invoice:write`   | Front desk, admin        |
| `payment:collect` | Front desk, admin        |
| `invoice:waive`   | Admin only               |
| `invoice:defer`   | Admin only               |
| `payment:refund`  | Admin only               |
| `report:revenue`  | Owner, admin             |

Waiving, deferring and refunding are administrator-only on purpose: each one is
a way for money to leave without a corresponding service, and the person at the
desk should not be able to authorise their own exception.

Doctors get none of these. A doctor who can waive a fee is a control gap, and
they have not asked for it.

---

## 7. Risks

**The check-in gate will be the most disruptive change so far.** Every existing
test that checks a patient in now needs a paid invoice first, and the queue
board grows a payment state. Worth doing in one migration and one pass rather
than half-gating it.

**Refunds against a partially-paid invoice.** The rule is that total refunds may
never exceed total payments, enforced in the service and by a CHECK where
possible. Getting this wrong means money leaving the clinic that never arrived.

**Day-end reports are read by people who will act on them.** If the number is
wrong the clinic's cash reconciliation is wrong. The collection summary is
derived from payment rows in a single query, never assembled in application code
from several.
