/**
 * The permission vocabulary and the seeded roles.
 *
 * THIS IS THE ONLY DEFINITION. It lives in the db package rather than the API
 * because two consumers need it — the API, which enforces permissions, and the
 * seed scripts, which write them into the database.
 *
 * It used to be duplicated across both. Adding appointment permissions to the
 * API but not the seed produced a working build where every scheduling endpoint
 * returned 403, with nothing to indicate why. One definition removes that class
 * of bug entirely.
 *
 * Permissions are a fixed set defined in code, not tenant data: a tenant
 * inventing a new string would produce a permission nothing ever checks, which
 * is worse than none because it looks like it works. What IS tenant-editable is
 * which permissions a role holds (FR-USR-01).
 */

export const PERMISSIONS = {
  PATIENT_READ: 'patient:read',
  PATIENT_WRITE: 'patient:write',
  PATIENT_MERGE: 'patient:merge',

  CONSENT_READ: 'consent:read',
  CONSENT_WRITE: 'consent:write',

  APPOINTMENT_READ: 'appointment:read',
  APPOINTMENT_WRITE: 'appointment:write',
  APPOINTMENT_CANCEL: 'appointment:cancel',
  /** Changing a doctor's hours is a clinic setting, not a booking action. */
  SCHEDULE_MANAGE: 'schedule:manage',
  /**
   * Move a waiting patient to the front of the queue.
   *
   * Separate from `appointment:write` because it is the one queue action a
   * whole waiting room can see the effect of. Held by the front desk and the
   * doctor — both are physically present when a patient needs to jump — and
   * every use carries a reason code and an author.
   */
  QUEUE_PRIORITISE: 'queue:prioritise',

  /**
   * Start today's visit for a doctor, without holding the diary.
   *
   * Split from `appointment:write` on Narveer's decision of 3 Sep 2026, for the
   * finance desk. Those are two different powers and they were one permission:
   * opening a walk-in that is happening now is an act at the door, while booking
   * Thursday afternoon, rescheduling it and cancelling it is control of the
   * clinic's diary. A finance person needs the first so the bill has a visit to
   * attach to, and must not have the second.
   *
   * The front desk holds both, as it always did — this narrows what a NEW role
   * can be given, and takes nothing away from an existing one.
   */
  VISIT_OPEN: 'visit:open',

  /**
   * The clinical note. Split three ways rather than one `consultation:write`,
   * because the three actions are held by different people: a nurse records
   * vitals, only a doctor diagnoses and prescribes, and the front desk does
   * none of it. "They can see it on the screen anyway" is not a reason to grant
   * a receptionist read access to a clinical note in the model.
   */
  CONSULTATION_READ: 'consultation:read',
  CONSULTATION_WRITE: 'consultation:write',
  VITALS_WRITE: 'vitals:write',

  /**
   * Clinical documents — X-rays, scanned reports, PDFs held in S3.
   *
   * Separate from `consultation:*` because the people who ATTACH a result are
   * not the people who write the note. A radiographer uploads a film and never
   * touches a diagnosis; a doctor reads the film and never operates the machine.
   */
  DOCUMENT_READ: 'document:read',
  DOCUMENT_WRITE: 'document:write',

  /**
   * Diagnostics — X-ray and pathology.
   *
   * Three, not one, because three different people are involved: the doctor who
   * ORDERS a test, everyone clinical who READS what came back, and the
   * technician who RESULTS it. A single `diagnostic:manage` would have let a
   * radiographer order their own work.
   */
  DIAGNOSTIC_ORDER: 'diagnostic:order',
  /**
   * Raise a test nobody prescribed (FR-DIA-10, FR-DIA-12).
   *
   * Separate from `diagnostic:order`, which is a clinical act: the doctor in
   * the room deciding a patient needs a scan, on any consultation. This is a
   * commercial act at a counter — somebody asks for a film, finance prices it
   * and takes the money. Folding the two together would hand the finance desk
   * the power to order tests on anybody's consultation, far more than the
   * requirement asked for, and the front desk was deliberately given neither.
   *
   * Same reasoning that split `visit:open` out of `appointment:write`.
   */
  DIAGNOSTIC_ORDER_WALKIN: 'diagnostic:order:walkin',
  DIAGNOSTIC_READ: 'diagnostic:read',
  DIAGNOSTIC_RESULT: 'diagnostic:result',
  PRESCRIPTION_WRITE: 'prescription:write',
  /** Editing the clinic's drug list is an administrative act, not a clinical one. */
  FORMULARY_MANAGE: 'formulary:manage',

  /**
   * Billing. Waiving, deferring and refunding are separated from ordinary
   * collection because each is a way for money to leave without a corresponding
   * service — the person at the desk should not be able to authorise their own
   * exception.
   */
  INVOICE_READ: 'invoice:read',
  INVOICE_WRITE: 'invoice:write',
  PAYMENT_COLLECT: 'payment:collect',
  INVOICE_WAIVE: 'invoice:waive',
  INVOICE_DEFER: 'invoice:defer',
  PAYMENT_REFUND: 'payment:refund',

  /**
   * Promotions — the clinic's discounts, set up in advance.
   *
   * Two permissions, not one, and the split is the control. The administrator
   * DEFINES what a discount may be; the finance desk and the front desk APPLY
   * one that already exists. A single `promotion:manage` would have let the person taking the
   * money invent the discount they were about to give, which is the failure mode
   * this whole feature is meant to replace — a verbal instruction and a
   * hand-written note.
   */
  PROMOTION_MANAGE: 'promotion:manage',
  PROMOTION_APPLY: 'promotion:apply',

  REPORT_REVENUE: 'report:revenue',

  /**
   * The follow-up board — docs/10.
   *
   * Two, because reading who is due and SENDING a patient a message are
   * different acts. The owner watches the return rate; the front desk and the
   * doctor are the ones who nudge a patient or call back about rising pain.
   */
  FOLLOWUP_READ: 'followup:read',
  FOLLOWUP_MANAGE: 'followup:manage',

  AUDIT_READ: 'audit:read',

  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  TENANT_CONFIGURE: 'tenant:configure',
  /**
   * Pair a screen with the waiting room.
   *
   * Administrator only, and not because the data is sensitive — the screen shows
   * tokens and nothing else. It is because pairing mints a credential that works
   * without a login, and handing those out is an administrative act.
   */
  DISPLAY_MANAGE: 'display:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export interface RoleSeed {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  /** FR-USR-02: mandatory for roles that can grant permissions. */
  requiresMfa: boolean;
}

/**
 * Seeded roles, mapped to the personas in BRD section 6.
 *
 * Only personas that current functionality actually serves are here. Seeding a
 * "Billing executive" with no billing permissions to hold would be theatre.
 */
export const SYSTEM_ROLES: RoleSeed[] = [
  {
    key: 'front_desk',
    name: 'Front desk',
    description: 'Registers patients, books appointments, runs the queue.',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_WRITE,
      PERMISSIONS.CONSENT_READ,
      PERMISSIONS.CONSENT_WRITE,
      PERMISSIONS.APPOINTMENT_READ,
      PERMISSIONS.APPOINTMENT_WRITE,
      PERMISSIONS.APPOINTMENT_CANCEL,
      // Held alongside APPOINTMENT_WRITE rather than instead of it. The front
      // desk always could open a walk-in; `visit:open` only names that power
      // separately so the finance desk can be given it on its own.
      PERMISSIONS.VISIT_OPEN,
      // Puts a patient back at the front after they return from an X-ray, and
      // handles the emergency who cannot wait. Recorded, never silent.
      PERMISSIONS.QUEUE_PRIORITISE,
      // Raises the bill and takes the money. Cannot waive, defer or refund —
      // those are the ways money leaves without a service behind it.
      PERMISSIONS.INVOICE_READ,
      PERMISSIONS.INVOICE_WRITE,
      PERMISSIONS.PAYMENT_COLLECT,
      // Applies a discount the administrator already defined, CUSTOM included,
      // from the queue's payment dialog — where this desk takes the fee.
      // Decision of 22 Sep 2026; existing clinics get it from migration
      // 20260922110000. Cannot define one, and must name who authorised it.
      PERMISSIONS.PROMOTION_APPLY,
      // Fields "are my X-ray results back yet". Reads; never attaches.
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DIAGNOSTIC_READ,
      // Works the follow-up board: reminds the overdue, calls back rising pain.
      PERMISSIONS.FOLLOWUP_READ,
      PERMISSIONS.FOLLOWUP_MANAGE,
    ],
    requiresMfa: false,
  },
  {
    key: 'doctor',
    name: 'Doctor',
    description: 'Sees the day list, reviews history, records consultations.',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_WRITE,
      PERMISSIONS.CONSENT_READ,
      PERMISSIONS.APPOINTMENT_READ,
      // Doctors call the next patient and mark a visit finished — both writes.
      PERMISSIONS.APPOINTMENT_WRITE,
      // Sends a patient for an X-ray and decides who comes in next. The doctor
      // can see the room; the software cannot.
      PERMISSIONS.QUEUE_PRIORITISE,
      PERMISSIONS.CONSULTATION_READ,
      PERMISSIONS.CONSULTATION_WRITE,
      PERMISSIONS.VITALS_WRITE,
      PERMISSIONS.PRESCRIPTION_WRITE,
      // Reads an X-ray during the consultation; does not attach one.
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DIAGNOSTIC_ORDER,
      PERMISSIONS.DIAGNOSTIC_READ,
      // Their own patients' recovery, and the callback when pain is rising.
      PERMISSIONS.FOLLOWUP_READ,
      PERMISSIONS.FOLLOWUP_MANAGE,
    ],
    requiresMfa: false,
  },
  {
    key: 'nurse',
    name: 'Nurse',
    description: 'Captures vitals, supports clinical workflow.',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.CONSENT_READ,
      // Read-only on the queue: a nurse sees who is waiting but does not book.
      PERMISSIONS.APPOINTMENT_READ,
      // Reads the note and records vitals; does not diagnose or prescribe.
      PERMISSIONS.CONSULTATION_READ,
      PERMISSIONS.VITALS_WRITE,
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DIAGNOSTIC_READ,
      PERMISSIONS.FOLLOWUP_READ,
    ],
    requiresMfa: false,
  },
  {
    key: 'diagnostics',
    name: 'Diagnostics',
    description: 'X-ray and pathology. Works the test list and attaches results.',
    permissions: [
      /**
       * The full patient record, read-only — Narveer's decision, 26 Aug 2026.
       *
       * The narrower option would have been the order and nothing else: name,
       * age, UHID, the test requested. He chose the wider one because a
       * technician who cannot see the history cannot spot that the wrong film
       * was requested, and in a small clinic the same person often does several
       * jobs. It does mean this role can open any patient's consultation notes.
       * docs/09 section 4 records the reasoning; narrowing it later is a change
       * to this list rather than a rewrite.
       */
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.CONSENT_READ,
      PERMISSIONS.APPOINTMENT_READ,
      PERMISSIONS.CONSULTATION_READ,

      // The job itself: see the list, open what is there, attach what comes off
      // the machine. Note what is absent — DIAGNOSTIC_ORDER. A department does
      // not order its own work.
      PERMISSIONS.DIAGNOSTIC_READ,
      PERMISSIONS.DIAGNOSTIC_RESULT,
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DOCUMENT_WRITE,
    ],
    requiresMfa: false,
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'Meets the patient first. Registers, bills, discounts and takes payment.',
    permissions: [
      // Finds whoever walked in, and registers them if this is their first
      // visit. A first-time patient sent to another desk to be created is the
      // thing this role exists to prevent.
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_WRITE,

      /**
       * No `consent:read` or `consent:write`, removed 5 Sep 2026.
       *
       * Registration does capture DPDP consent, but it does so inside the
       * registration transaction behind `patient:write` — no endpoint in this
       * API checks the consent permissions at all. Holding them gave finance
       * nothing today and pre-granted it whatever a standalone
       * consent-management endpoint might check tomorrow, with no review at the
       * moment that endpoint was written. Managing a patient's consent is not
       * this desk's job; registering them is.
       */

      // "Which doctors are consulting today, and do they have room?" — the
      // question answered before any money is taken.
      PERMISSIONS.APPOINTMENT_READ,
      // Opens today's visit so the bill has something real to attach to.
      // Deliberately NOT appointment:write or appointment:cancel: this desk
      // does not hold the diary. See the note on VISIT_OPEN.
      PERMISSIONS.VISIT_OPEN,

      // The bill itself, and the money.
      PERMISSIONS.INVOICE_READ,
      PERMISSIONS.INVOICE_WRITE,
      PERMISSIONS.PAYMENT_COLLECT,
      // Applies a discount the administrator already defined. Cannot define one.
      PERMISSIONS.PROMOTION_APPLY,

      // A walk-in test, priced and requested at this desk in one action
      // (decision 1). NOT `diagnostic:order`, which would let this desk order
      // tests on anybody's consultation. The administrator holds it through
      // ALL_PERMISSIONS; the front desk deliberately holds neither.
      PERMISSIONS.DIAGNOSTIC_ORDER_WALKIN,

      // Owns the numbers, and is who the owner asks where the day's money went.
      PERMISSIONS.REPORT_REVENUE,
    ],
    /**
     * Matched to the front desk, which is also false.
     *
     * This role moves money but does not authorise its exceptions — waive, defer
     * and refund stay with the administrator, whose role does require TOTP. If
     * MFA_ENABLED is ever turned on and this desk is judged to need it too, this
     * is the one line to change.
     */
    requiresMfa: false,
  },
  {
    key: 'administrator',
    name: 'Administrator',
    description: 'Configures the clinic, manages users, roles and schedules.',
    permissions: ALL_PERMISSIONS,
    requiresMfa: true,
  },
  {
    key: 'owner',
    name: 'Owner / management',
    description: 'Oversight and reporting. Read-only over clinical data.',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.CONSENT_READ,
      PERMISSIONS.APPOINTMENT_READ,
      PERMISSIONS.CONSULTATION_READ,
      // Oversight: sees the money and the day-end numbers, collects none of it.
      PERMISSIONS.INVOICE_READ,
      PERMISSIONS.REPORT_REVENUE,
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DIAGNOSTIC_READ,
      // The return rate is the owner's number. Watching it, not working it.
      PERMISSIONS.FOLLOWUP_READ,
    ],
    requiresMfa: true,
  },
];
