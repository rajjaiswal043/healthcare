# Tokens at booking, priority and the waiting-room display — plan

Module 2, revisited. Narveer asked for three things on 12 Aug 2026:

1. A token number issued **when the appointment is booked**, not when the patient
   arrives.
2. That token visible to the nurse and the doctor, and — later — on a screen in
   the waiting room showing what is being served now.
3. A way to **put a patient back in front of the doctor out of order**: sent for
   an X-ray, back in thirty minutes, and they should not start the queue again.

Status: **built** on 12 Aug 2026 — all three phases. Tokens are issued at
booking, the queue sorts on readiness rather than on the token, the pay-first
gate withholds a place in the queue rather than a number, a patient can be sent
for an X-ray and brought back without ending their visit, and a screen on the
waiting-room wall shows what is being called.

---

## 1. The collision this has to resolve first

Today `tokenNumber` does two jobs at once. It **identifies** the visit, and it
**orders** the queue — `queue()` sorts by it, and that sort is the doctor's
worklist. That works only because the token is issued at check-in, so token
order and arrival order are the same thing by construction.

Issuing at booking breaks it. Someone who books next Tuesday's first slot gets
token 1; a walk-in that Tuesday morning gets token 40 and is standing in the
room at 09:05 while token 1 is still in traffic. If the queue keeps sorting by
token, the walk-in waits for a patient who has not arrived, and the front desk
re-orders the list by hand all day — which is exactly the failure the original
"token at check-in" decision was written to avoid (`docs/01`, section 2).

So the requirement is fine, but it forces a split that has to happen first:

> **A token is an identity. It is not a position.**

- **Token** — allocated at booking, per doctor per clinic day. Printed on the
  slip, spoken out loud, shown on the display, quoted on the phone. It never
  changes for the life of the visit.
- **Serving order** — computed at read time from priority and from when the
  patient became ready to be seen. Never shown to the patient as a number.

Every other decision below follows from that one, and once it is made, the rest
of the request is straightforward.

---

## 2. Decisions worth arguing with

### 2.1 One series per doctor per clinic day, allocated at booking

Confirmed by Narveer on 12 Aug 2026: **per doctor**, not per clinic.

Tokens restart daily and are unique per doctor — unchanged from today, and
`queue_counter` and `next_queue_token()` already work exactly this way. The only
change is **when** the function is called: at `book()` and `walkIn()` rather
than at `checkIn()`.

Two consequences to accept deliberately:

**The series will have gaps.** A cancelled or rescheduled appointment leaves its
number unused. That is fine — a token is not a financial document. It is the
opposite of the receipt-number rule in `docs/04`, and worth stating so nobody
"fixes" it later by renumbering, which would move a token out from under a
patient who is already holding a slip with it printed.

**A low token no longer means "seen sooner".** Someone booking three weeks ahead
gets token 1. This will be misread by patients unless the display never implies
ordering — hence the board shows "Now serving" and an explicit "Next" list, and
never a sorted column of every token.

_The alternative considered:_ separate series with a prefix — `A-07` for
appointments, `W-03` for walk-ins. It reads honestly, and it is worse in the
room: staff calling out "W three" and patients hearing "A three" is a
mis-called patient, and mis-called patients are how the wrong person ends up in
the chair. One series, one word, one number.

### 2.2 Pay-first moves off the token and onto the queue

The billing gate is currently phrased and enforced as "no token until the visit
is paid". Once the token exists from booking, that sentence is no longer the
rule — the rule is **no place in the queue until the visit is paid**.

The enforcement point does not move: it stays in `AppointmentsService.checkIn`,
calling `BillingService.blockingReason`. What changes is the wording, and what
check-in actually does:

|                  | Today           | After                                                            |
| ---------------- | --------------- | ---------------------------------------------------------------- |
| Booking          | no token        | token allocated, visit is `BOOKED`                               |
| Check-in blocked | no token issued | token unchanged, patient is **not** admitted to the waiting list |
| Check-in allowed | token issued    | `readyAt` stamped, patient joins the waiting list                |

Message becomes: _"₹500.00 outstanding on invoice INV-000026. Collect payment
before adding them to the queue."_

This is the biggest blast radius in the change — it touches the check-in tests,
the queue board, and six cases in the UAT pack (QUE-001 to QUE-003, APT-005,
APT-018, APT-019). Better done in one pass than half-gated.

### 2.3 The bypass is a re-entry, not a jump

"Bypass the token" is the right instinct and the wrong model. The X-ray patient
is not skipping anything — they queued, they were seen, the doctor sent them
away, and they are coming back to finish a consultation that never ended. The
software should treat that as **the same visit, resumed**, not as a new arrival
with a favour attached.

So sending a patient out is a state on the visit, and their return puts them
back in the waiting list at the **front**, carrying:

- the same token,
- the same appointment,
- the same draft clinical note,
- the same invoice.

That last point matters, and Narveer confirmed it on 12 Aug 2026: **a same-day
recall is not charged again.** If a recall were modelled as a new appointment it
would raise a second invoice, and the clinic would either charge twice or spend
its afternoon cancelling bills. Same visit, one bill.

If a clinic ever wants to charge for reviewing a report, that is a _line added
to the existing invoice_ — which the billing module already supports — and not a
second consultation fee. Worth knowing that the invoice becomes uneditable once
money has been collected against it (`ALREADY_PAID`), so a post-report charge on
an already-settled visit would need a second, standalone invoice. Not a problem
today; a real one the day someone asks for it.

**A separate case, deliberately not the same thing:** the patient told to come
back _tomorrow_ with the report. That is a follow-up appointment — new day, new
token, new bill at the follow-up rate. The line between the two is the clinic
day, and it is worth being explicit that the software draws it there.

### 2.4 Where a returning patient lands is a decision, not a rule

Narveer's answer on 12 Aug 2026: **the front desk or the doctor decides.** The
software does not compute a fair position — it offers the two positions that
actually occur in a clinic and records which one a named person chose.

When the patient comes back to the desk with their report, the return dialog
asks one question:

| Choice                        | What it does                                                                                    | When it is used                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **See next** (default)        | Flags the visit. They go in front of everyone waiting, after the patient currently in the room. | The ordinary case — they have already waited once.                                                                         |
| **Add to the queue normally** | No flag. `readyAt` is stamped now, so they sit behind everyone already waiting.                 | The doctor is deep in a long consultation, the report is not urgent, or the room is full of people who have waited longer. |

"Somewhere in the middle" is deliberately not offered. An arbitrary insert
position is a fiddly control that produces an order nobody can explain to the
person it disadvantaged — and it is unnecessary, because the doctor can call any
waiting patient directly whenever they choose to.

Serving order is therefore:

```
ORDER BY (priority_set_at IS NULL),  -- flagged patients first
         priority_set_at,            -- among them, first flagged, first served
         ready_at,                   -- everyone else, by when they became ready
         token_number                -- deterministic tie-break
```

First-flagged-first-served matters: two patients back from X-ray within a minute
of each other are served in the order they returned, and a later emergency does
not silently displace a recall that was already promised "you're next".

Four rules around it:

**Nothing interrupts the patient in the chair.** A recall or an emergency goes
_next_, after the current consultation is signed. Interrupting a consultation to
insert someone is a clinical safety problem, not a queue feature.

**The doctor's list is a recommendation, not a lock.** The doctor can call any
waiting patient from their day list, in any order, without asking the software's
permission — they can see the room and the software cannot. Calling out of order
is audited but needs no reason: a doctor is in charge of their own room. What
needs a reason is _flagging_, because that changes what the board tells a waiting
room.

**Every flag has a reason code and an author.** Both the front desk and the
doctor hold `queue:prioritise`, so both can flag — and both are recorded.
Without this, "See next" becomes the button pressed for whoever complains
loudest, and within a month the queue means nothing. Same argument as
`invoice:defer` in `docs/04`: an escape hatch that is recorded is a control; one
that is silent is a loophole. The codes:

- Back from tests or with a report _(set automatically on return)_
- Emergency — clinically urgent
- Frail, elderly or in distress
- Doctor asked for them
- Clinic error — we lost their turn

**A flag can be taken back.** "Move back to normal position" clears it, keeping
the token and the visit. Without an undo, a mis-click gets fixed by cancelling
and re-registering the patient, which loses their token and their bill — the
expensive repair for a cheap mistake.

**The board shows that a jump happened.** A waiting room can see that someone
went ahead of them. It cannot see _why_ without seeing clinical information, so
the screen says only "priority" — but it does not pretend the order was normal.

### 2.5 The display shows tokens, never names

The future waiting-room screen shows the doctor, the room, the token being
served, and the next few tokens. **No patient names, no UHIDs.**

A screen in a public room is a disclosure to everyone in that room. "Kavita
Sharma — Dr Nair, Dermatology, 11:15" tells a waiting room who is being treated
for what, by whom, and when. Under the DPDP Act that is personal data processed
beyond the purpose it was collected for, and it is also just bad manners in a
small clinic where people know each other. A token is a number that means
something only to the person holding the slip. That is the whole point of
tokens, and it is why this is a design constraint rather than a preference.

---

## 3. Data model

Additive. No column is dropped, and the existing token machinery is reused.

### `Appointment` — new fields

| Field                 | Type               | Why                                                                                                                                                             |
| --------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priorityReasonCode`  | enum, null         | Null means no flag — the ordinary case. Non-null is one of the five codes in 2.4, and it is the _why_, kept separate from the _where_.                          |
| `priorityNote`        | varchar(200), null | Optional free text beside the code. "Chest pain", "we called the wrong token".                                                                                  |
| `prioritySetAt`       | timestamptz, null  | **This is what orders flagged patients** — first flagged, first served. Cleared by the undo.                                                                    |
| `prioritySetByUserId` | uuid, null         | Who flagged them. Not nullable when the code is set — a CHECK constraint, not just service code.                                                                |
| `readyAt`             | timestamptz, null  | When the patient became ready to be seen — stamped at check-in, re-stamped on return from tests. This, not `checkedInAt`, is what the unflagged queue sorts on. |
| `sentOutAt`           | timestamptz, null  | Doctor sent them for an investigation.                                                                                                                          |
| `sentOutReason`       | varchar(200), null | "X-ray — left wrist". Shown to the front desk so they know who they are waiting for.                                                                            |
| `returnedAt`          | timestamptz, null  | Back at the desk with the report.                                                                                                                               |

Three fields rather than a rank enum, because the earlier draft's
`NORMAL | RECALL | EMERGENCY` conflated two things that turned out to be
separate: an emergency and a returning X-ray patient occupy the _same_ position
in the queue — in front — and differ only in why they are there. Ranking them
against each other would have meant a late emergency jumping a recall that had
already been told "you're next", which is the promise the desk least wants to
break. So: one flag, ordered by when it was set, with the reason recorded
alongside it.

`tokenNumber` and `queueDate` keep their columns, their unique constraint and
their allocation function. Only the call site moves. The doc comment on
`tokenNumber` ("Issued at CHECK-IN, not at booking") gets rewritten — it is
currently the schema's own statement of the rule we are changing.

### `AppointmentStatus` — one new value

`AWAITING_TESTS`, between `IN_PROGRESS` and `FULFILLED`.

It could be modelled as `ARRIVED` plus a non-null `sentOutAt`, which avoids
touching an enum every switch statement reads. It is still worth the explicit
status: the board, the doctor's list and the day-end counts all need to
distinguish "waiting to be seen" from "waiting for a report", and a state that
exists only as the absence of a timestamp gets forgotten by the next query
someone writes.

Lifecycle after the change:

```
BOOKED ──check-in──▶ ARRIVED ──open note──▶ IN_PROGRESS ──sign──▶ FULFILLED
                        ▲                        │
                        │                        ├──send for tests──▶ AWAITING_TESTS
                        └────────back at desk────────────────────────────┘
                                 (priority = RECALL, readyAt re-stamped)
```

### `DisplayDevice` — for phase C

A television in a waiting room cannot hold a user session, and giving it a staff
login is how a clinic ends up with a permanent front-desk session on an
unattended screen.

| Field             | Notes                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `id`, `tenantId`  | Standard.                                                          |
| `name`            | "Kothrud — ground floor waiting"                                   |
| `locationId`      | Which waiting room.                                                |
| `practitionerIds` | Which doctors this screen shows. Empty means all at that location. |
| `accessKey`       | Long random string, hashed at rest. The screen's only credential.  |
| `lastSeenAt`      | So an admin can tell a dead screen from an idle one.               |

The display endpoint reads through this key, is scoped to one tenant and one
location, and can return only tokens and doctor names. It is a separate,
narrower read path — not the staff queue endpoint with authentication relaxed.

---

## 4. Scope

### In

| Ref       | Feature                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| FR-APT-11 | Token allocated at booking and at walk-in registration, per doctor per day                                                    |
| FR-APT-12 | Token shown on the booking confirmation, the queue board, the nurse's view, the doctor's day list and the consultation header |
| FR-APT-13 | Serving order computed from priority and readiness, independent of token                                                      |
| FR-APT-14 | Send a patient out for an investigation without ending the visit                                                              |
| FR-APT-15 | Return them with the same token, note and bill — the desk or the doctor choosing "see next" or "queue normally"               |
| FR-APT-16 | Flag any waiting patient to be seen next, with a reason code, an author and an undo — recorded and audited                    |
| FR-APT-17 | Read endpoint shaped for a display board — tokens only                                                                        |
| FR-APT-18 | Public display screen: now serving, next few, per doctor                                                                      |

### Out, deliberately

| Feature                                  | Why                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Physical token printer                   | A slip printed from the browser covers it; ESC/POS hardware is an integration, not a feature.      |
| "Your turn is near" SMS/WhatsApp         | Same blocked channel as reminders (BRD A-03). The data will be there when the channel is.          |
| Predicted call time per token            | Needs weeks of real consultation-duration data. A wrong prediction on a screen is worse than none. |
| Multi-room routing, nurse-station triage | One doctor, one room is what these clinics run.                                                    |
| Voice announcement                       | After the screen earns its keep.                                                                   |
| Self-check-in kiosk                      | Needs the patient portal.                                                                          |

---

## 5. Permissions

| Permission         | Held by            | Why                                                                                                  |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `queue:prioritise` | Front desk, doctor | Recall a returning patient, or mark an emergency. Both roles are physically present when it happens. |
| `display:manage`   | Administrator      | Pairing a screen is a clinic setting, and the access key is a credential.                            |

The nurse keeps read-only on the queue. Recording that a patient is back from
X-ray is a desk action, and a nurse who needs it can be given the front-desk
permission explicitly rather than by widening the role for everyone.

---

## 6. Phases

**A — Split identity from order. Done, 12 Aug 2026.** Migration
`20260812061500_queue_tokens_at_booking`: the queue columns, two CHECK
constraints, and a per-tenant backfill that gave every appointment already in the
diary a token. Allocation moved to `book()` and `walkIn()`; `readyAt` stamped at
check-in; the queue re-sorted; the gate's message rewritten; the token shown on
the booking confirmation and on every board row. The flag columns landed here
too, so phase B is application code against a schema that already holds.

`pnpm verify` green at 129 API tests — the three new ones being the waiting list
ordered against its token, the diary staying in time order, and a flagged patient
overtaking the queue.

**B — Out and back. Done, 12 Aug 2026.** Migration
`20260812130000_queue_send_out_and_recall`: the `AWAITING_TESTS` status, the
send-out columns, and two CHECK constraints — a send-out must say what for, and a
return is only reachable through a recorded departure. Four endpoints
(`send-for-tests`, `return`, `PATCH`/`DELETE priority`), the `queue:prioritise`
permission on the front desk and the doctor, an "Away for tests" panel on the
board, and the placement dialog with its two choices.

Three decisions that only appeared while building it:

- **Resuming a note calls the patient back in.** Opening an existing encounter
  used to leave the appointment alone, which was harmless when a visit was opened
  once. On the second leg it left the board showing a patient as waiting while
  they sat in the room, and the next patient was never called because "now
  serving" was empty.
- **Signing works from `AWAITING_TESTS`.** That is how a doctor closes out
  someone who went home instead of coming back — open question 3, answered.
- **Undo puts them behind whoever arrived while they were out**, because
  `readyAt` is stamped at their return. That is their normal position, and it is
  the honest one.

`pnpm verify` green at 141 API tests. The twelve new ones cover the round trip,
both placement choices, the undo, first-flagged-first-served, and the
constraints that stop a return without a departure.

**C — The screen. Done, 12 Aug 2026.** Migration
`20260812160000_waiting_room_display`: `display_device` under RLS like everything
else, the key stored only as a SHA-256 hash. Pairing lives in Settings →
Waiting-room screens behind `display:manage`; the key is shown once, with the
page arranged around not letting an administrator close that panel too early.
`/display/:key` polls every 5 seconds and paints now-serving and the next three
per doctor, in the clinic's real serving order.

What it cost to get right:

- **The key carries its tenant**, `<tenantId>.<32 random bytes>`, exactly as a
  session refresh token does. `display_device` is under FORCE row-level security
  and a television has no session, so the API parses the tenant from the key,
  sets context, and reads _inside_ the policy. The alternative was a BYPASSRLS
  role that could read every clinic's screens — a far bigger hole than the one it
  would have closed.
- **"Running late" is derived, not declared.** The payload carries minutes since
  the last call and the screen decides (20 minutes). A manual "delayed" flag
  would need somebody to remember to set it and, more importantly, to unset it —
  and a stale flag on a waiting-room wall is a screen telling a room something
  untrue.
- **The privacy rule is enforced by the query, not the component.** `board()`
  selects token numbers and doctor names; there is no patient name in the
  response to render or fail to render. The test asserts that against the whole
  payload rather than a field.
- **Every failure is the same 401** — wrong key, malformed key, revoked screen.
  This endpoint is reachable by anyone who can guess a URL, and whoever holds a
  bad key learns nothing from the refusal.

`pnpm verify` green at 150 API tests, nine of them this phase.

**D — Later.** Announcements, kiosk, predicted waits.

---

## 7. Risks

**Existing appointments have no token.** Anything already booked for a future
date was created under the old rule and has `tokenNumber = NULL`. The migration
needs a backfill for future-dated `BOOKED` appointments, ordered by `startAt` so
the numbers come out sensibly, and it must run inside each tenant's counter so
the next live booking does not collide. Historical rows are left alone.

**Two receptionists, one token.** Unchanged in mechanism —
`next_queue_token()` is atomic and the unique constraint backs it — but the
allocation now happens on a much busier path than check-in. The concurrency test
moves to booking.

**Recall can be abused into a fast lane.** If "back from tests" needs no
evidence that the patient was ever sent out, it becomes the button for anyone
who complains. Mitigation: `returnedAt` is only settable on a visit that has a
`sentOutAt`, enforced in the service and by a CHECK constraint.

**A patient sent out and never returning.** They sit in `AWAITING_TESTS`
indefinitely and quietly inflate the day's open-visit count. The day-end view
needs to list them, and the doctor needs a way to close the visit as fulfilled
(or to sign the note as it stands) without the patient coming back.

**The screen is the most visible thing in the clinic.** It is on a wall, in
front of patients, all day. A stale or blank display is a support call in a way
that a stale admin report is not — which is why phase C spends its effort on the
failure state rather than on the layout.

---

## 8. Decisions and remaining questions

### Settled — 12 Aug 2026

| Question                                | Decision                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token series scope                      | **Per doctor per clinic day.** Matches how the queue is already built and how tokens are already constrained.                                                              |
| Is a same-day recall charged again?     | **No.** Same visit, same token, same bill. A post-report charge, if a clinic ever wants one, is a line on the existing invoice.                                            |
| Where does a returning patient land?    | **The front desk or the doctor decides**, at the moment of return — "see next" (the default) or "queue normally". The software offers two positions and records who chose. |
| Who may flag a patient to be seen next? | **Front desk and doctor**, both holding `queue:prioritise`. Nurse stays read-only.                                                                                         |

### Answered while building

| Question                                                 | Answer                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does the screen show when a doctor is running late? | **Derived, not declared.** After 20 minutes without a call it says "running late" and how long. Nobody has to set a flag, and — the real point — nobody has to remember to unset one. |
| A patient sent for tests who never comes back?           | **The doctor signs what they have.** Signing works from `AWAITING_TESTS` and completes the visit, so it does not sit open all day.                                                    |

### Still open

1. **Does something print the token slip?** If patients are to hold a token, the
   desk needs to print it — and there is no receipt print yet either
   (`docs/03`, known gaps). These two want doing in one pass, and until then a
   token is a number the desk reads out loud.
2. **Does the screen need sound?** A chime when the called token changes is the
   usual next request from a real waiting room. Deliberately not built: it needs
   a decision about volume control that only a clinic with the screen on a wall
   can make.
