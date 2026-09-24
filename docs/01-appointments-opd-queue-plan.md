# Appointments and the OPD Queue — plan

BRD Module 2 (§9.2.1), the scheduling half. Branch: `Aug7HC`.

---

## 1. What this has to do

A clinic's day runs on two things the current build has neither of: **who is available when**, and **who is next**. Everything here serves one of those.

From the BRD:

| ID        | Requirement                                                                                            | This branch                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| FR-APT-01 | Doctor schedules per location: weekly templates, slot duration by visit type, capacity, validity dates | ✅                                                                                                                 |
| FR-APT-02 | Leave/block management with conflict detection and assisted rebooking                                  | ✅ (conflict detection; assisted rebooking listed but manual)                                                      |
| FR-APT-03 | Book / reschedule / cancel from the front desk with reason codes                                       | ✅                                                                                                                 |
| FR-APT-05 | Walk-ins flow into the same queue with token issuance                                                  | ✅                                                                                                                 |
| FR-APT-07 | Token and queue per doctor; "now serving" display; average-wait indicator                              | ✅                                                                                                                 |
| FR-APT-08 | Check-in marks arrival and orders the doctor's worklist                                                | ✅                                                                                                                 |
| FR-APT-09 | No-show capture and analytics                                                                          | ✅ capture; analytics deferred                                                                                     |
| FR-APT-10 | Overbooking policy per doctor (COULD)                                                                  | ✅ — it is three lines once capacity exists                                                                        |
| FR-APT-04 | Patient self-booking via portal link, OTP-verified                                                     | ⛔ blocked — needs the patient portal and an OTP channel, neither of which exists                                  |
| FR-APT-06 | Automated reminders at T−24h / T−2h via WhatsApp/SMS                                                   | ⛔ blocked — needs a WhatsApp BSP and DLT-registered templates, which are **customer** onboarding tasks (BRD A-03) |

The two blocked items are blocked on things outside the code. The schema carries the fields they will need (`reminderSentAt`, `source`) so turning them on later is wiring, not a migration.

Also out: the `tele` visit type, because telehealth is parked with the rest of Module 4.

---

## 2. Three decisions worth arguing with

**Slots are computed, never stored.**
A materialised `slot` row per bookable interval means a nightly generation job, a rebuild whenever a doctor changes their hours, and rows that silently disagree with the template. Instead, availability is derived at read time from the weekly template minus exceptions minus booked appointments. A clinic has a handful of doctors and perhaps sixty slots each per day — this is a cheap query, and it is always consistent with the template. Revisit only if a tenant ever needs months of pre-published availability.

**Tokens are issued at check-in, not at booking.**
This is how Indian OPD actually works: the appointment gives you a _time_, the token gives you a _position_, and position is decided by arrival. Issuing a token at booking would mean token 4 arriving an hour after token 9, and staff reordering the list by hand all day. So: book → arrive → check in → token.

**Walk-ins and appointments share one queue.**
FR-APT-05 requires it, and it matches the room: there is one line of people, not two. A walk-in is an appointment record created at the moment of arrival with `source = WALK_IN` and no prior slot — which keeps one code path for the doctor's worklist instead of two.

---

## 3. Data model

FHIR R4 names throughout, per ADR-013.

| Model                  | FHIR                         | Notes                                                                                                                      |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Department`           | `HealthcareService`          | Choose-a-department is the first step of booking                                                                           |
| `Practitioner`         | `Practitioner`               | Name, NMC registration number, specialty. `hprId` reserved for ABDM. Optionally linked to a `User` so a doctor can sign in |
| `PractitionerSchedule` | `Schedule`                   | Weekly template: practitioner + location + weekday + start/end + slot minutes + capacity per slot + validity dates         |
| `ScheduleException`    | `Schedule` (planningHorizon) | Leave, blocks, one-off extra sessions                                                                                      |
| `Appointment`          | `Appointment`                | patient, practitioner, location, start/end, status, visit type, reason, token, source                                      |

`Appointment.status` follows the FHIR value set, narrowed to what we use: `BOOKED`, `ARRIVED`, `IN_PROGRESS`, `FULFILLED`, `CANCELLED`, `NO_SHOW`.

Every table is tenant-scoped with RLS, like everything else — `rls:check` will fail the build otherwise.

**Token allocation** gets the same treatment as UHID: a `SECURITY DEFINER` function doing increment-and-read atomically. Two receptionists checking patients in at the same moment must not be handed token 7 twice — rare in testing, routine at 9am.

---

## 4. Permissions

New strings, added to the vocabulary and to seeded roles:

- `appointment:read` — front desk, doctor, nurse, owner
- `appointment:write` — front desk, doctor (book, reschedule, check in)
- `appointment:cancel` — front desk, doctor
- `schedule:manage` — administrator only (a doctor's hours are a clinic-level setting)

---

## 5. Phases

**A — Masters and schema.** Department, Practitioner, PractitionerSchedule, ScheduleException, Appointment. Migration with RLS and the token function. Demo seed: doctors with realistic weekly hours across both clinics.

**B — Booking.** Availability computation, book / reschedule / cancel with reason codes, conflict detection against leave and existing bookings. Front-desk booking screen: department → doctor → date → slot.

**C — The OPD day.** Walk-in registration into the queue, check-in with token issue, live queue board per doctor with now-serving and average wait, doctor's day list.

**D — Follow-on, not this branch.** No-show analytics, the waiting-room display view, assisted rebooking when a doctor blocks a session.

Each phase ends green on `pnpm verify`, and C ends with a demo script addition.

---

## 6. Known gaps this leaves

Stated plainly so they are not discovered later:

- **No reminders**, so the no-show rate this is meant to reduce will not move until the WhatsApp channel exists.
- **No patient self-booking**, so every booking is staff-entered.
- **No consultation capture** — this branch gets the patient in front of the doctor and stops there. The consult, prescription and encounter record are the next slice.
- **Assisted rebooking is manual**: blocking a session shows which appointments are affected, but moving them is one at a time.
