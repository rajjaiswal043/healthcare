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
  REPORT_REVENUE: 'report:revenue',

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
      // Puts a patient back at the front after they return from an X-ray, and
      // handles the emergency who cannot wait. Recorded, never silent.
      PERMISSIONS.QUEUE_PRIORITISE,
      // Raises the bill and takes the money. Cannot waive, defer or refund —
      // those are the ways money leaves without a service behind it.
      PERMISSIONS.INVOICE_READ,
      PERMISSIONS.INVOICE_WRITE,
      PERMISSIONS.PAYMENT_COLLECT,
      // Fields "are my X-ray results back yet". Reads; never attaches.
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DIAGNOSTIC_READ,
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
    ],
    requiresMfa: true,
  },
];
