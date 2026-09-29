# The price list, and the receipt

**Source:** clinic demo calls, 3 Sep 2026. Two requirements that belong together —
the administrator decides what things cost, and the finance desk hands the patient
a piece of paper proving they paid it.

Companion to `docs/10-finance-persona-and-promotions.md` (who takes the money) and
`docs/11-walk-in-diagnostics.md` (the receipt is what the patient carries to the
X-ray room).

---

## 1. Why these are one requirement

A receipt is only as good as the prices on it. If the price list is a number
somebody typed from memory, the receipt is a piece of paper with a guess printed
on it. The administrator sets the prices once, at onboarding; every bill and every
receipt afterwards is just those numbers being read back.

They also fail together. A clinic that cannot print a receipt cannot prove a
patient paid, and a patient who paid ₹500 for an X-ray and has nothing in their
hand has no way to show the department they are owed one.

---

## 2. What exists today

| Already built                                          | Note                                          |
| ------------------------------------------------------ | --------------------------------------------- |
| A `service` with a price and a tax rate, per clinic    | Prices in integer paise                       |
| A per-practitioner price override                      | Dr A's consultation can cost more than Dr B's |
| `POST setup/services` to create or update one          | Guarded by `tenant:configure`                 |
| Invoices, numbered per clinic, with lines and payments | `docs/04-billing-plan.md`                     |
| **Invoice lines store the name and price as charged**  | See the warning below — this is important     |
| A print stylesheet and a working print flow            | Built for the prescription; reusable          |

**Missing:** any way to _list_ services (there is only an upsert endpoint), any
screen at all for prices, and any printed receipt. The receipt is a known gap —
`docs/03-resume-here.md` records it as "invoices are numbered and complete;
nothing prints one yet."

> **Warning for whoever picks this up.** `invoice_line` deliberately copies the
> service name and unit price at the moment of billing rather than pointing at the
> service row. This looks like duplication and is not: it is what lets a receipt
> reprinted in 2029 show the ₹500 that was actually charged, not the ₹800 the
> X-ray costs by then. **Do not "normalise" it.**

---

## 3. The price list

### FR-PRC-01 — An administrator sets what everything costs

**What the business needs.** The hospital administrator opens a screen and sees
everything the clinic charges for, with its price, and can change it.

Each entry has:

| Field      | Notes                                                           |
| ---------- | --------------------------------------------------------------- |
| Name       | What it is called on the bill — "Chest X-ray", "CBC"            |
| Category   | Consultation, diagnostic, procedure — so the list stays legible |
| Department | Which department performs it, where that applies                |
| Price      | In rupees, entered as rupees, stored as paise                   |
| Tax rate   | Zero for most clinics — see decision 3                          |
| Active     | Switched off without being deleted                              |

**The screen must show the whole list at once**, grouped, searchable. An
administrator pricing a clinic is comparing forty numbers against each other, not
editing one in isolation.

**For the developer.** The `service` model and the upsert endpoint exist. What is
missing is a **list endpoint** and the screen. Prices are integer paise in the
database and rupees on screen — convert at the edge, never store a float.

---

### FR-PRC-02 — Prices are set when the clinic is onboarded

**What the business needs.** Pricing is part of onboarding, not something a clinic
discovers is empty on its first morning. Whoever onboards sits with the clinic and
enters their charges.

- A clinic with **no prices raises no invoices**, and its check-in gate stays open.
  This is already how the system behaves and it is the right behaviour — it means
  a clinic can start using the software before its pricing is settled.
- But an empty price list should **say so plainly** on the finance desk, rather
  than looking like a bug: _"No services are priced yet. Ask your administrator."_

---

### FR-PRC-03 — Changing a price later

**What the business needs.** Prices go up. When they do, **every invoice and
receipt already issued keeps the price it was issued at.**

- A price change applies to bills raised from that moment on.
- Nothing already billed changes, ever — not the invoice, not a reprint of its
  receipt, not the day's collection figures for a past date.
- A service that is no longer offered is **switched off, not deleted**. Reporting
  groups by service, and a deleted service makes last month's report
  unexplainable.

**For the developer.** Because invoice lines already copy the price, this
requirement is mostly _already satisfied by the data model_ — the work is making
sure the screens don't undo it, and that the price-change screen says what it
does.

---

## 4. The receipt

### FR-RCP-01 — Print a receipt for every payment

**What the business needs.** Every time the finance desk takes money, they can
print a receipt and hand it over. It is the patient's proof of payment, and in the
walk-in test flow it is what they carry to the department.

- Available immediately after taking a payment, and again later from the invoice.
- Prints on the paper the clinic already has — A5 or thermal, see decision 4.
- Carries the clinic's own name and logo, like the prescription already does.

---

### FR-RCP-02 — What is on it

**At the top — who and where**

- The clinic's name, logo, address and phone.
- Receipt number and date-time.
- Patient name, **patient ID**, age and sex, mobile.
- The doctor, where there is one. A walk-in test has no doctor and the receipt
  should not pretend otherwise.

**In the middle — what they are paying for.** One line per item, with the rate
shown:

| Item        | Rate | Qty | Amount |
| ----------- | ---- | --- | ------ |
| Chest X-ray | ₹500 | 1   | ₹500   |
| CBC         | ₹700 | 1   | ₹700   |

**At the bottom — the money, in this order and never collapsed**

- Total charged
- **Discount**, with the promotion named, if one was applied
- Amount payable
- **Amount paid now**, and how — cash, UPI, card
- **Balance outstanding**, if any

**Who took it** — the name of the person at the desk, and the clinic's stamp
space.

---

### FR-RCP-03 — A receipt is for a payment, not for a bill

This is the part most likely to be got wrong, so it is stated separately.

**One invoice can have several receipts.** A ₹1,100 bill where the patient pays
₹500 now and ₹600 on the way out is **one invoice and two receipts**, each showing
what was paid at that moment and what remained. A receipt that reprints the whole
bill every time is a receipt the patient can use to claim they paid twice.

**Reprints are marked.** The first print is the receipt; every print after it says
**DUPLICATE** on its face. Two identical unmarked receipts for one payment is how
cash goes missing in a clinic, and the person it exposes is the finance desk.

**Every print is recorded** — which receipt, by whom, when. Cheap to store, and it
is the answer when somebody asks how a second copy exists.

---

## 5. Decisions Narveer needs to make

### 5.1 Who sets the prices — the platform at onboarding, or the clinic's administrator?

The requirement says both: set at onboarding, changed by the clinic afterwards.
That is workable, but decide who owns it. **Recommendation: the clinic's own
administrator owns it, and onboarding is simply the first time they use the
screen** — prices change far too often for a clinic to have to ask you.

### 5.2 Does a per-practitioner price override belong on this screen?

The model already supports Dr A's consultation costing more than Dr B's. Is that
part of the price list, part of the doctor's own setup screen, or not exposed at
all yet? **Recommendation: on the doctor's setup screen**, where the rest of that
doctor's arrangements live.

### 5.3 Tax — GST, and what a receipt must legally carry

Most clinical services in India are GST-exempt, and the tax field exists but is
zero. **If any of your clinics are GST-registered**, their receipt legally needs
more on it than what is listed above — GSTIN, HSN/SAC codes, a tax breakdown, and
a specific document title. That is a compliance question, not a design one, and it
needs answering before receipts print. If none of them are, say so and the field
stays zero.

### 5.4 What paper does the receipt print on?

A5 sheet from a normal printer, or a thermal roll from a small till printer? They
are different layouts and a clinic will already own one of them. **Ask the ortho
clinic what is on their desk** — it costs one question now and a rebuild later.

### 5.5 Is the receipt number the invoice number, or its own sequence?

**Recommendation: its own sequence.** One invoice can produce several receipts, so
they cannot share a number without a suffix — and a receipt with a suffix invites
somebody to invent one.

---

## 6. Summary for the developer

| Requirement | State                                                              |
| ----------- | ------------------------------------------------------------------ |
| FR-PRC-01   | New screen; the model and upsert exist, the list endpoint does not |
| FR-PRC-02   | Onboarding step; behaviour with no prices already correct          |
| FR-PRC-03   | Mostly satisfied by the data model — don't break it                |
| FR-RCP-01   | New. The print flow exists from the prescription                   |
| FR-RCP-02   | New. Layout only                                                   |
| FR-RCP-03   | New, and the one with real consequences if it is got wrong         |

Rules that apply throughout: money is integer paise, never float; invoice lines
keep the price as charged; and every new table needs its row-level security
policy or `pnpm rls:check` fails the build.
