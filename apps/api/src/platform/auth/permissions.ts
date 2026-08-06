/**
 * The permission vocabulary.
 *
 * Defined in code, not the database: permissions are a fixed set that the code
 * checks against, and letting tenants invent new strings would produce
 * permissions nothing ever enforces — worse than none, because they look like
 * they work.
 *
 * What IS tenant-editable is which permissions a role holds (FR-USR-01).
 */
export const PERMISSIONS = {
  PATIENT_READ: 'patient:read',
  PATIENT_WRITE: 'patient:write',
  PATIENT_MERGE: 'patient:merge',

  CONSENT_READ: 'consent:read',
  CONSENT_WRITE: 'consent:write',

  AUDIT_READ: 'audit:read',

  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  TENANT_CONFIGURE: 'tenant:configure',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/**
 * Seeded roles, mapped to the personas in BRD section 6.
 *
 * Only the personas that current functionality actually serves are here.
 * Seeding a "Billing executive" role with no billing permissions to hold would
 * be theatre — those arrive with the modules they belong to.
 *
 * `requiresMfa` follows FR-USR-02: mandatory for administrative roles, optional
 * elsewhere. Someone who can create users and change permissions is the account
 * worth stealing.
 */
export interface RoleSeed {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  requiresMfa: boolean;
}

export const SYSTEM_ROLES: RoleSeed[] = [
  {
    key: 'front_desk',
    name: 'Front desk',
    description: 'Registers patients, searches records, manages the queue.',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_WRITE,
      PERMISSIONS.CONSENT_READ,
      PERMISSIONS.CONSENT_WRITE,
    ],
    requiresMfa: false,
  },
  {
    key: 'doctor',
    name: 'Doctor',
    description: 'Sees the day list, reviews history, records consultations.',
    permissions: [PERMISSIONS.PATIENT_READ, PERMISSIONS.PATIENT_WRITE, PERMISSIONS.CONSENT_READ],
    requiresMfa: false,
  },
  {
    key: 'nurse',
    name: 'Nurse',
    description: 'Captures vitals, supports clinical workflow.',
    permissions: [PERMISSIONS.PATIENT_READ, PERMISSIONS.CONSENT_READ],
    requiresMfa: false,
  },
  {
    key: 'administrator',
    name: 'Administrator',
    description: 'Configures the clinic, manages users and roles.',
    permissions: ALL_PERMISSIONS,
    // Mandatory: this role can grant itself and others any permission.
    requiresMfa: true,
  },
  {
    key: 'owner',
    name: 'Owner / management',
    description: 'Oversight and reporting. Read-only over clinical data.',
    permissions: [PERMISSIONS.PATIENT_READ, PERMISSIONS.AUDIT_READ, PERMISSIONS.CONSENT_READ],
    requiresMfa: true,
  },
];
