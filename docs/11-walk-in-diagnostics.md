# Walk-in diagnostics — a test without a doctor

**Source:** clinic demo calls, 3 Sep 2026. Companion to
`docs/10-finance-persona-and-promotions.md`; read that one first, because the
finance desk prices and collects for these tests.

---

## 1. What is being asked for

Today a test exists because a doctor asked for it. During a consultation the
doctor raises a diagnostic order, the patient walks to the X-ray room or the lab,
the department does the work and attaches the result, and the result comes back
into the consultation for the doctor to read. That whole chain assumes a doctor at
both ends.

The clinics want the other case: **somebody walks in off the street wanting an
X-ray and does not want to see a doctor at all.** They may be carrying a
prescription from a hospital across town, or they may simply want a chest film.
They pay, the department does the test, they take the report away.

> "I need an X-ray, and I don't want to visit the doctor, so I can directly go to
> that lab and I can do that."

**The flow the clinics described**

1. The patient arrives and says which test they want.
2. **Finance** finds or registers them, quotes the price for that test, and takes
   the payment.
3. **Front desk** raises the request against the department.
4. **The department** performs the test, attaches the result, and hands the report
   over.

No consultation, no prescription, no doctor anywhere in it.

---

## 2. Requirements

### FR-DIA-10 — A test request with no ordering doctor

**What the business needs.** A diagnostic order that stands on its own, raised
because a patient asked for it rather than because a doctor prescribed it.

- The order records **who asked for it**: this clinic's doctor (as today), a
  doctor at another hospital (FR-DIA-14), or the patient themselves.
- A self-referred order behaves like any other on the department worklist — the
  department does not need to care why it exists.
- It is attached to the **patient**, not to a consultation, so it appears in that
  patient's history for any doctor who sees them later.

**For the developer.** `diagnostic_order` currently hangs off a consultation and
carries the ordering practitioner. Both need to become optional, and a
**referral source** — `IN_HOUSE_DOCTOR` / `EXTERNAL_DOCTOR` / `SELF` — needs to
be stored explicitly rather than inferred from a null consultation. Inferring it
works today and stops working the first time a fourth case appears; the reports in
FR-DIA-15 need the distinction stated, not deduced.

Everything downstream already exists: the department worklist, attaching a result
file, writing the report, marking it done. See `docs/09-diagnostics-plan.md`.

---

### FR-DIA-11 — Pricing and paying for a walk-in test

**What the business needs.** The finance desk quotes the test, takes the money,
and prints a receipt — the same desk and the same screen as a consultation, with a
test in place of a doctor's fee.

- Finance selects the **test**, not a doctor. The price comes from the clinic's
  priced services, which already exist.
- More than one test on one bill — an X-ray and a blood test together — is one
  invoice, one payment, one receipt.
- **Promotions apply here too**, if the clinic decides they do — see decision 5 in
  `docs/10`, which asks exactly this.

**The department does not start work until the test is paid for.** This is the
same rule as the pay-first gate at check-in, applied to the department worklist
instead of the queue: an unpaid test appears on the worklist marked unpaid and
cannot be started. A clinic that does not price its services is unaffected, as it
is today.

---

### FR-DIA-12 — Raising the request at the front desk

**What the business needs.** After paying, the patient goes to the front desk,
which sends the request to the department without any consultation involved.

- The front desk picks the patient, the department and the test, and sends it.
- It appears on that department's worklist immediately.
- The person who raised it is recorded.

**For the developer.** The front desk will need the permission to order a test,
which it does not have today. Note this is a genuine widening of what the front
desk can do — see decision 1, which asks whether it should be finance doing this
instead.

---

### FR-DIA-13 — Doing the test and handing the report over

**What the business needs.** The department performs the test, attaches the film
or the result, writes its report, and **gives the report to the patient**, because
there is no doctor waiting for it.

- Same worklist and same result attachment as a doctor-ordered test — the
  department's screen does not change.
- The report can be **printed and handed over**, and the system records that it
  was handed over and when. A patient who paid and left without their film is a
  complaint waiting to happen.
- The result stays on the patient record. If that patient sees a doctor here in
  six months, it is in their history like any other test.

---

### FR-DIA-14 — The doctor who sent them, from somewhere else

**What the business needs.** Many walk-ins arrive holding a prescription from a
doctor at another hospital, and in Indian practice the report is addressed back to
that doctor by name.

- Capture the **referring doctor's name** — and, if given, their clinic and
  number.
- Print it on the report.
- Report on it: which outside doctors send the most work is a number the clinic
  owner will want, and it is the beginning of a referral relationship.

**For the developer.** Start as free text on the order. A managed list of external
referrers is the obvious next step and should not be built until somebody asks —
see decision 6.

---

### FR-DIA-15 — Money that belongs to no doctor

**What the business needs.** A test-only patient never sees a doctor, so a report
that splits revenue by doctor cannot see them at all.

- Collections must also split **by department** — X-ray, pathology, and each
  doctor's consulting — so every rupee lands somewhere.
- Split **by referral source**: work the clinic's own doctors generated, work sent
  in by outside doctors, and work that walked in off the street. That is three
  different businesses and an owner will want them separated.
- Patient counts alongside, since a department's throughput is not the same
  question as its revenue.

**This changes FR-FIN-03 in `docs/10`.** That requirement says collections split
by doctor. It must say by doctor **and by department**, or walk-in test revenue
disappears from the finance person's own reports. Whoever picks up either
requirement should read both.

---

## 3. Decisions Narveer still needs to make

### 3.1 Should finance raise the request instead of the front desk?

In the described flow, **finance already selects the test in order to price it,
and then the front desk selects it again in order to request it.** The same
information is typed twice by two people, with a patient standing in front of each
of them, and the second entry can silently disagree with the first — paid for a
chest X-ray, requested a knee.

**Recommendation: finance raises the request as part of taking the payment**, and
the front desk simply directs the patient to the right room. It is one less step
for the patient, one less place for the two records to diverge, and it does not
require giving the front desk a power it has never had.

Against it: it puts more on the finance desk, and it is not what the clinics
described. **This is your call, not the developer's** — but it should be made
deliberately, because building it as described means accepting the double entry.

### 3.2 Does a walk-in test patient get a token?

Consultation patients get a token at booking and appear on the waiting-room
screen. A patient waiting for an X-ray is also waiting, in the same room. Do they
get a token and a place on that screen, or do departments simply work through
their list?

### 3.3 Does the printed report say that no clinician has read it?

Nobody interprets a self-referred test. The clinic is selling a film and a
technical report, not a diagnosis, and the patient may well read it as one.
Whether the report carries a line saying so is a medico-legal question for the
doctors, not a technical one — but it must be settled before reports print.

### 3.4 Must a test be paid before the department starts it?

**Recommendation: yes**, consistent with the pay-first rule everywhere else. Worth
confirming, because a clinic that lets a regular patient pay afterwards will find
this obstructive.

### 3.5 What if they decide they do want to see a doctor?

A patient has an X-ray, the technician sees something, and now they want a
consultation. Can that test be pulled into the consultation that follows, so the
doctor reads the film they just paid for rather than ordering it again? This will
happen, and it is better answered now than discovered.

### 3.6 Free text or a managed list for external referrers?

Free text is right to start with. A managed list gives you referral reporting that
actually adds up, at the cost of somebody maintaining it. Start free, watch
whether anybody uses the report.

---

## 4. What already exists

| Already built                                    | Where                               |
| ------------------------------------------------ | ----------------------------------- |
| Departments, including diagnostic ones           | `docs/09-diagnostics-plan.md`       |
| `diagnostic_order`, worklist, result attachment  | `docs/09`, checkpoints 2 and 3      |
| A `diagnostics` role that can attach results     | Settings → Roles                    |
| Files against a patient — X-rays, scans, reports | S3-backed clinical document storage |
| Completed tests showing in a patient's history   | `PreviousVisitsPanel`               |
| Priced services, invoices, payments, receipts    | `docs/04-billing-plan.md`           |
| Pay-first enforcement in the API, not the UI     | `AppointmentsService.checkIn`       |

**What is genuinely new:** an order that has no consultation and no ordering
doctor, a referral source, the external referrer, handing a report to a patient,
and department-level revenue reporting. Everything else is reuse.
