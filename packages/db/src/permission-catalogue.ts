import { PERMISSIONS, SYSTEM_ROLES, type Permission } from './permissions.js';

/**
 * Every permission, in words a clinic administrator can act on.
 *
 * `PERMISSIONS` is a list of strings, and a screen offering `consent:write` as a
 * tickbox tells nobody anything. Each entry here gets a plain description and a
 * category, so the roles screen can group them the way a clinic thinks about its
 * work rather than the way the code is organised.
 *
 * **Typed as `Record<Permission, …>`, which is the point.** Add a permission to
 * `PERMISSIONS` without an entry here and this file stops compiling. Two lists
 * that must agree only stay in step if one of them refuses to build — the last
 * time something in this area drifted, a role gained a permission that newly
 * onboarded clinics did not have, and nothing noticed until a test asserted it.
 *
 * And note what this is NOT: an editable table. A permission absent from the
 * code guards nothing, so an administrator picks from this list and cannot
 * invent an entry. CIPCRM seeds its equivalent into a Mongo collection; ours is
 * compiled against by `@RequirePermissions`, so it has to stay code.
 */
export type PermissionCategory =
  | 'Patients'
  | 'Appointments and queue'
  | 'Consultation'
  | 'Diagnostics'
  | 'Billing'
  | 'Reports'
  | 'Administration';

export interface PermissionInfo {
  name: Permission;
  description: string;
  category: PermissionCategory;
}

export const PERMISSION_CATALOGUE: Record<Permission, PermissionInfo> = {
  [PERMISSIONS.PATIENT_READ]: {
    name: PERMISSIONS.PATIENT_READ,
    description: 'Search for patients and open their record',
    category: 'Patients',
  },
  [PERMISSIONS.PATIENT_WRITE]: {
    name: PERMISSIONS.PATIENT_WRITE,
    description: 'Register a patient, and correct details entered wrongly',
    category: 'Patients',
  },
  [PERMISSIONS.PATIENT_MERGE]: {
    name: PERMISSIONS.PATIENT_MERGE,
    description: 'Merge two records of the same person into one',
    category: 'Patients',
  },
  [PERMISSIONS.CONSENT_READ]: {
    name: PERMISSIONS.CONSENT_READ,
    description: 'See what a patient has consented to',
    category: 'Patients',
  },
  [PERMISSIONS.CONSENT_WRITE]: {
    name: PERMISSIONS.CONSENT_WRITE,
    description: 'Record or withdraw a patient consent',
    category: 'Patients',
  },

  [PERMISSIONS.APPOINTMENT_READ]: {
    name: PERMISSIONS.APPOINTMENT_READ,
    description: "See the day's queue and the appointment diary",
    category: 'Appointments and queue',
  },
  [PERMISSIONS.APPOINTMENT_WRITE]: {
    name: PERMISSIONS.APPOINTMENT_WRITE,
    description: 'Book, check in, call and complete a visit',
    category: 'Appointments and queue',
  },
  [PERMISSIONS.APPOINTMENT_CANCEL]: {
    name: PERMISSIONS.APPOINTMENT_CANCEL,
    description: 'Cancel or reschedule a booked appointment',
    category: 'Appointments and queue',
  },
  [PERMISSIONS.SCHEDULE_MANAGE]: {
    name: PERMISSIONS.SCHEDULE_MANAGE,
    description: 'Set up doctors, departments and weekly consulting hours',
    category: 'Appointments and queue',
  },
  [PERMISSIONS.VISIT_OPEN]: {
    name: PERMISSIONS.VISIT_OPEN,
    description: "Start today's visit for a doctor, without booking a future appointment",
    category: 'Appointments and queue',
  },
  [PERMISSIONS.QUEUE_PRIORITISE]: {
    name: PERMISSIONS.QUEUE_PRIORITISE,
    description: 'Move a patient up the queue, and bring back one sent for tests',
    category: 'Appointments and queue',
  },

  [PERMISSIONS.CONSULTATION_READ]: {
    name: PERMISSIONS.CONSULTATION_READ,
    description: 'Read consultation notes and previous visits',
    category: 'Consultation',
  },
  [PERMISSIONS.CONSULTATION_WRITE]: {
    name: PERMISSIONS.CONSULTATION_WRITE,
    description: 'Write and sign a consultation note',
    category: 'Consultation',
  },
  [PERMISSIONS.VITALS_WRITE]: {
    name: PERMISSIONS.VITALS_WRITE,
    description: 'Record height, weight, blood pressure and other vitals',
    category: 'Consultation',
  },
  [PERMISSIONS.PRESCRIPTION_WRITE]: {
    name: PERMISSIONS.PRESCRIPTION_WRITE,
    description: 'Prescribe medicines',
    category: 'Consultation',
  },
  [PERMISSIONS.FORMULARY_MANAGE]: {
    name: PERMISSIONS.FORMULARY_MANAGE,
    description: "Maintain the clinic's list of medicines",
    category: 'Consultation',
  },

  [PERMISSIONS.DOCUMENT_READ]: {
    name: PERMISSIONS.DOCUMENT_READ,
    description: 'Open X-rays, scans and reports held against a patient',
    category: 'Diagnostics',
  },
  [PERMISSIONS.DOCUMENT_WRITE]: {
    name: PERMISSIONS.DOCUMENT_WRITE,
    description: 'Attach a file to a patient record',
    category: 'Diagnostics',
  },
  [PERMISSIONS.DIAGNOSTIC_READ]: {
    name: PERMISSIONS.DIAGNOSTIC_READ,
    description: 'See the test list and what has come back',
    category: 'Diagnostics',
  },
  [PERMISSIONS.DIAGNOSTIC_ORDER]: {
    name: PERMISSIONS.DIAGNOSTIC_ORDER,
    description: 'Request a test during a consultation',
    category: 'Diagnostics',
  },
  [PERMISSIONS.DIAGNOSTIC_ORDER_WALKIN]: {
    name: PERMISSIONS.DIAGNOSTIC_ORDER_WALKIN,
    description: 'Price and request a walk-in test, with no consultation',
    category: 'Diagnostics',
  },
  [PERMISSIONS.DIAGNOSTIC_RESULT]: {
    name: PERMISSIONS.DIAGNOSTIC_RESULT,
    description: 'Attach a result and mark a test done',
    category: 'Diagnostics',
  },

  [PERMISSIONS.INVOICE_READ]: {
    name: PERMISSIONS.INVOICE_READ,
    description: 'View bills and what has been paid',
    category: 'Billing',
  },
  [PERMISSIONS.INVOICE_WRITE]: {
    name: PERMISSIONS.INVOICE_WRITE,
    description: 'Add or remove charges on a bill',
    category: 'Billing',
  },
  [PERMISSIONS.PAYMENT_COLLECT]: {
    name: PERMISSIONS.PAYMENT_COLLECT,
    description: 'Take a payment from a patient',
    category: 'Billing',
  },
  [PERMISSIONS.PAYMENT_REFUND]: {
    name: PERMISSIONS.PAYMENT_REFUND,
    description: 'Refund a patient, or reverse an entry recorded in error',
    category: 'Billing',
  },
  [PERMISSIONS.INVOICE_WAIVE]: {
    name: PERMISSIONS.INVOICE_WAIVE,
    description: 'Waive a charge, or cancel a bill raised by mistake',
    category: 'Billing',
  },
  [PERMISSIONS.INVOICE_DEFER]: {
    name: PERMISSIONS.INVOICE_DEFER,
    description: 'Let a patient pay later',
    category: 'Billing',
  },
  [PERMISSIONS.PROMOTION_MANAGE]: {
    name: PERMISSIONS.PROMOTION_MANAGE,
    description: 'Set up the clinic’s discounts, and switch one off',
    category: 'Billing',
  },
  [PERMISSIONS.PROMOTION_APPLY]: {
    name: PERMISSIONS.PROMOTION_APPLY,
    description: 'Apply an approved discount to a bill, naming who authorised it',
    category: 'Billing',
  },

  [PERMISSIONS.REPORT_REVENUE]: {
    name: PERMISSIONS.REPORT_REVENUE,
    description: "See the day's collections and how they were taken",
    category: 'Reports',
  },
  [PERMISSIONS.FOLLOWUP_READ]: {
    name: PERMISSIONS.FOLLOWUP_READ,
    description: 'See who is due back for review, who came back, and how recovery is going',
    category: 'Appointments and queue',
  },
  [PERMISSIONS.FOLLOWUP_MANAGE]: {
    name: PERMISSIONS.FOLLOWUP_MANAGE,
    description: 'Send patients reminders and check-ins, and clear a rising-pain flag',
    category: 'Appointments and queue',
  },
  [PERMISSIONS.AUDIT_READ]: {
    name: PERMISSIONS.AUDIT_READ,
    description: 'See who did what, and what a record used to say',
    category: 'Reports',
  },

  [PERMISSIONS.USER_MANAGE]: {
    name: PERMISSIONS.USER_MANAGE,
    description: 'Add staff, switch accounts off, and reset passwords',
    category: 'Administration',
  },
  [PERMISSIONS.ROLE_MANAGE]: {
    name: PERMISSIONS.ROLE_MANAGE,
    description: 'Change what each role is allowed to do',
    category: 'Administration',
  },
  [PERMISSIONS.TENANT_CONFIGURE]: {
    name: PERMISSIONS.TENANT_CONFIGURE,
    description: "Change the clinic's name, logo and settings",
    category: 'Administration',
  },
  [PERMISSIONS.DISPLAY_MANAGE]: {
    name: PERMISSIONS.DISPLAY_MANAGE,
    description: 'Pair and remove waiting-room screens',
    category: 'Administration',
  },
};

/** The order categories appear on the roles screen: clinic floor first. */
export const PERMISSION_CATEGORIES: PermissionCategory[] = [
  'Patients',
  'Appointments and queue',
  'Consultation',
  'Diagnostics',
  'Billing',
  'Reports',
  'Administration',
];

/**
 * The roles a clinic may adjust but not delete or rename — the seven we ship.
 *
 * The KEY is what matters. Onboarding, seat limits and four backfill migrations
 * all address roles by key, so a renamed or missing one breaks them with no
 * error anybody would see. Permissions on these roles are freely editable; the
 * key is not.
 */
export const SYSTEM_ROLE_KEYS: string[] = SYSTEM_ROLES.map((r) => r.key);

/**
 * The one role a clinic cannot edit at all.
 *
 * It is the way back from every other mistake on this screen. An administrator
 * who removed `role:manage` from Administrator would have locked their clinic
 * out of the screen that undoes it, and nobody at the clinic could fix it.
 */
export const LOCKED_ROLE_KEY = 'administrator';

/** The permissions a system role ships with — what "reset to default" restores. */
export function defaultPermissionsFor(key: string): string[] | null {
  return SYSTEM_ROLES.find((r) => r.key === key)?.permissions ?? null;
}
