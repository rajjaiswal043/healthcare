# Patient journey — plan

Wait from home, recover with a check-in, come back on time. Written 29 Sep 2026,
after the product review that found HealthCloud had no reason to be chosen over
any other clinic EMR. Mockups: the "HealthCloud Finished Product" artifact.

---

## 0. The USP, and why this one

Most clinic software stops at the prescription. HealthCloud runs the part of
the patient's journey that happens **outside** the building: the live token
before the visit, and recovery check-ins after it. Two things an Indian
specialist OPD actually suffers from move with it — a waiting room with thirty
people in it at 11 am, and patients who never come back for review.

It is also the shortest distance from what already exists. Tokens are issued at
booking (docs/05), the follow-up date is recorded on every encounter (docs/02),
FR-APT-06 left `reminderSentAt` on the appointment, and FR-P36-23 already shows
the last visit. What was missing is a channel to the patient and something that
acts on the dates.

---

## 1. What is built in this change

| Area          | Change                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Consent       | A `COMMUNICATIONS` consent captured at registration, and recordable afterwards. Nothing is sent without it.                               |
| Messages      | `outbound_message`, a log of every message, and a `MessageChannel` seam. Only the `console` channel exists.                               |
| Patient links | `patient_link`: a no-login link per visit (live token) or per recovery (check-ins). Hashed at rest, tenant in the key, like a screen key. |
| Live token    | Token message at booking. "Leave now" when the estimated wait drops under 30 minutes. "On my way" / "Running late" from the patient.      |
| Check-ins     | `recovery_checkin`: pain 0–10, exercises yes/no, a note. Scheduled at signing, every N days until the review date. Rising pain flags.     |
| Consultation  | Recovery panel (check-ins since last visit), carry forward last visit's medicines (FR-P36-24), check-in interval, send Rx to patient.     |
| Follow-ups    | A board: reviews due this week, came back, overdue, flagged. One-tap reminders. Return rate over ten weeks. Value of reviews kept.        |
| Display       | Doctor card, wait estimate, "waiting from home" count, thank-you line in English and Hindi.                                               |
| Warmth        | New default logo (SVG), time-of-day greeting at login, warmer empty states, next-visit box on the printed prescription, new welcome copy. |

---

## 2. Decisions taken, and by whom

All mine, pending Narveer. Each is a single place to change.

| Decision               | Chosen                                                                                                                          | Where to change it                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Channel                | `console` only. Messages are logged and recorded as SENT. A WhatsApp BSP is still a customer onboarding task (BRD A-03).        | `MESSAGE_CHANNEL`, `message-channel.ts` |
| Patient authentication | **A link, not OTP.** 256-bit key, expires (visit: end of the next day; recovery: 7 days after the review). ADR-007's OTP later. | `patient-link.service.ts`               |
| What a link discloses  | First name, token, doctor, wait. Never UHID, mobile, diagnosis. The recovery link adds the advice text the patient was given.   | `patient-link.service.ts`               |
| Consent                | `COMMUNICATIONS` must be granted and not withdrawn. Absent consent writes a SKIPPED row, so "why did they get nothing" answers. | `engagement.service.ts`                 |
| Leave-now threshold    | 30 minutes estimated, using today's mean consultation length for that doctor, 10 minutes before anyone has been seen.           | `LEAVE_NOW_MINUTES`                     |
| Rising pain            | Pain 8 or more, or up 2 or more on the previous answer. Flagged to the clinic; the patient is told the clinic will call.        | `flagFor()` in `recovery.ts`            |
| Check-ins give advice  | **Never.** They collect answers. The only thing a check-in says back is thanks, the review date, and that the clinic will call. | —                                       |
| Came back              | Any later visit of the same patient, not cancelled or a no-show, starting before review date + 14 days.                         | `FOLLOW_UP_GRACE_DAYS`                  |
| Who sees the board     | `followup:read` — front desk, doctor, nurse, owner. `followup:manage` (remind, clear a flag) — front desk, doctor.              | `permissions.ts`, migration             |

---

## 3. Deliberately not built

- **A real WhatsApp provider.** The seam exists; the provider needs the clinic's
  own BSP account and approved templates.
- **The QR code on the waiting-room screen.** A walk-in scanning it would need to
  identify themselves, which is OTP, which is ADR-007's patient portal.
- **Doctor photos and uploaded signatures.** Both need the object store for
  something other than clinical documents. The screen uses initials.
- **Message retries.** The console channel cannot fail. A real provider will
  need an outbox worker on BullMQ (ADR-006); the table already has the status.

---

## 4. Running it locally

```bash
pnpm --filter @healthcloud/db seed:demo       # includes seed:journey
# or, on top of an existing demo database:
pnpm --filter @healthcloud/db seed:scheduling && pnpm --filter @healthcloud/db seed:journey
```

`seed:journey` gives every demo patient WhatsApp consent, ten weeks of review
history for the doctor linked to `doctor@demo.local`, three overdue reviews, one
patient with rising pain, and a recovery history for the first patient waiting
in today's queue. Every number it writes is made up.

Due check-ins and late "time to leave" messages are sent by a timer in the API
every 120 seconds (`ENGAGEMENT_SWEEP_SECONDS`; `0` turns it off, and the test
suite does). The follow-up board also has "Send due check-ins now".

Every message appears in the API log as `[whatsapp → 98xxx xxx10] …` with the
patient link in it. Open that link to be the patient: `/p/<key>` needs no
login, and the auth provider leaves it alone the way it leaves `/display`.

Where to look:

| Who          | Where                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| Doctor       | Consult the first waiting patient: "Since last visit" chart, "Repeat these medicines". |
| Doctor       | Set a review date, pick check-ins, sign, then "Send to patient on WhatsApp".           |
| Front desk   | Follow-ups in the rail. Remind, call back, send due check-ins.                         |
| Front desk   | A patient's record: the WhatsApp consent switch and every message sent.                |
| Patient      | The link from the API log: live token, "on my way", or the pain check-in.              |
| Waiting room | Wait estimate, "waiting from home", doctor initials, thank-you band in Hindi.          |
