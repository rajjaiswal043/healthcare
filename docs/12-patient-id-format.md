# The patient ID format, chosen per clinic

**Source:** clinic demo calls, 3 Sep 2026.

---

## 1. What is being asked for

Every patient gets a unique ID belonging to that hospital, in a format the
hospital chooses at onboarding. Dr Vivek's clinic wants `DRVIV-0001`,
`DRVIV-0002`, and so on — a prefix they pick, a separator, and a number that
counts up on its own.

---

## 2. Before anything is built: most of this already exists

This matters more than the requirement itself, so it goes first.

**Every patient already has a unique per-clinic ID.** It is called the UHID, it
appears on the patient record, on bills and in search, and it cannot be changed
after registration. The clinic table already carries:

| Column         | Meaning                                  | Today       |
| -------------- | ---------------------------------------- | ----------- |
| `uhid_prefix`  | The letters in front, up to 8 characters | Default `P` |
| `uhid_padding` | How many digits the number is padded to  | Default 6   |
| `uhid_counter` | The last number issued                   | Starts at 0 |

Numbers are allocated by `next_uhid()`, a SECURITY DEFINER function that
increments and returns in one statement, so two receptionists registering at the
same moment can never be handed the same ID. **That part is solved and should not
be touched.**

The onboarding API already accepts `uhidPrefix`. What is missing is smaller and
more specific than "add a unique hospital ID":

| Gap                                                                        | Effect today                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The onboarding **screen** never asks for a prefix, so the API default wins | Every clinic silently gets the first three letters of its name |
| `uhid_padding` is not settable anywhere — no API input, no screen          | Every clinic gets 6 digits whether it wants them or not        |
| Nothing previews the result                                                | Whoever onboards cannot see what they have chosen              |
| Nothing displays the format after onboarding                               | The clinic cannot find out what its own format is              |

**So Dr Vivek's clinic today would get `DRV000001`, not `DRVIV-0001`** — right
mechanism, wrong prefix, wrong number of digits, and nobody was asked.

---

## 3. Requirements

### FR-UID-01 — Choose the format when the clinic is onboarded

**What the business needs.** Whoever onboards a clinic asks what the hospital
wants its patient IDs to look like, and sets it there and then.

- **Prefix** — the letters in front, including any separator the clinic wants.
  `DRVIV-` is a prefix; so is `SNC/`.
- **Number width** — how many digits, zero-padded. Four gives `0001`.
- **A live preview**, updating as they type: _"Your first patient will be
  `DRVIV-0001`."_ This is the whole point of the screen. Somebody choosing a
  format they cannot see will choose wrong.
- Sensible defaults, so an onboarding that skips this still works — as it does
  today.

**For the developer.** The API already takes `uhidPrefix`; it needs `uhidPadding`
alongside it, and the onboarding screen needs both fields. `next_uhid()` already
composes the two correctly and needs no change.

---

### FR-UID-02 — The clinic can see its own format

**What the business needs.** The format appears in the clinic's own settings, so
an administrator can answer "what do our patient numbers look like?" without
asking us.

- Shows the prefix, the width, an example, and how many IDs have been issued.
- **Read-only for the clinic.** Changing it is the platform's job — see FR-UID-03
  for why.

---

### FR-UID-03 — Changing the format after patients exist

**What the business needs.** A clinic will ask to change it, usually a fortnight
in, usually because they got it wrong at onboarding.

**The rule, and it is not negotiable: existing patients keep the ID they were
given.** A UHID is printed on cards, written on files, quoted on bills and stuck
on X-ray envelopes. Renumbering makes every one of those wrong, and the patient
holding the card becomes untraceable.

So a format change:

- applies to **patients registered from that moment on**, never retrospectively;
- leaves the clinic with **two formats in circulation, permanently**, which is
  correct and must not be tidied away;
- **does not reset the counter** — if 40 patients exist, the next is 41 in the new
  format. Restarting at 1 creates two patients with the same number, differing
  only by prefix, and that is the one thing this ID exists to prevent;
- is done by the platform, not the clinic, and is recorded.

**Say this out loud on the screen** when somebody changes it: _"Patients already
registered keep their existing IDs. This applies to new registrations only."_

---

### FR-UID-04 — Where the ID has to appear

Already true in most places; listed so nothing is missed when the format becomes
visible:

- The patient record, and search results — searching by ID already works.
- Every bill and receipt.
- The prescription.
- Diagnostic reports, including walk-in ones (`docs/11`).
- The patient's card, if the clinic prints one.

---

## 4. Decisions Narveer needs to make

### 4.1 A template like `DRVIV-{0000}`, or two separate fields?

You described a template string. Two fields — prefix and digit width — produce
exactly the same result, and that is what the database already stores.

**Recommendation: two fields with a live preview.** A template _syntax_ invites
the next question immediately — `{YYYY}` for the year, `{DEPT}` for the
department, a check digit — and each one is a parser, a validator, and a new way
for a clinic to lock itself into a format that collides with itself. Two fields
cannot express anything that breaks.

If you want the template box because it demos better, say so and it can be a
template box that only accepts one placeholder. But it is worth knowing that is a
presentation choice, not a capability.

### 4.2 Eight characters — is that enough prefix?

`uhid_prefix` is 8 characters today. `DRVIV-` fits; `DRVIVEKCLINIC-` does not.
Widening it is a small migration but must be decided before clinics start using
it, because narrowing it again later is not possible without touching issued IDs.

### 4.3 Can a clinic administrator change the format themselves?

**Recommendation: no** — platform only. It is a decision with permanent
consequences that looks like a harmless setting, and there is no undo. A clinic
that wants it changed should have to say so out loud to somebody.

### 4.4 Does the number ever restart — per year, say?

**Recommendation: no.** `DRVIV-2026-0001` and `DRVIV-2027-0001` are two different
patients whose IDs differ by a year nobody says out loud on the phone. If a clinic
asks for it, that is decision 4.1 all over again.

### 4.5 Does a sequential number tell people too much?

`DRVIV-0007` on a patient card says the clinic has seen seven patients. Patients
compare cards, and so do competitors. Most Indian clinics number sequentially and
nobody minds — but if this matters to any of your clinics, the time to decide is
before the first card is printed, because the fix is a different numbering scheme
entirely.

---

## 5. Honest summary for the developer

**This is a screen, one database column exposed, and a preview.** The identifier,
its uniqueness, its atomic allocation, its per-clinic isolation and its
appearance across the system are all built and working. Do not rebuild any of it —
in particular, do not replace `next_uhid()`. The whole requirement is: ask the
question at onboarding, store the answer, show what it will look like, and be
honest on screen about what changing it later does and does not do.
