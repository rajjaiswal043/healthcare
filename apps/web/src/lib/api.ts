/**
 * API client for the staff console.
 *
 * Session handling lives entirely in httpOnly cookies, so there is no token in
 * JavaScript for an XSS bug to steal — and correspondingly nothing here that
 * reads or stores one. Every request just sets `credentials: 'include'` and lets
 * the browser attach the cookie.
 *
 * The tenant is no longer sent by the client at all. It comes from the signed
 * session on the server, which is what makes row-level security a real boundary
 * rather than a convention.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';

export interface ApiError {
  code: string;
  message: string;
  correlationId: string;
  details?: {
    fieldErrors?: string[];
    code?: string;
    duplicates?: DuplicateCandidate[];
  };
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
    this.name = 'ApiRequestError';
  }
}

/** Set by the auth provider so a 401 anywhere can bounce the user to sign-in. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * Upload one file as multipart.
 *
 * Separate from `request` because the Content-Type must NOT be set by hand: the
 * browser writes `multipart/form-data; boundary=...` itself, and a header
 * without that boundary produces a body the server cannot parse. Everything
 * else — credentials, the 401 handler, the error shape — is shared.
 */
async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.set('file', file);

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  if (res.status === 401) onUnauthorized?.();

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: ApiError } | null;
    throw new ApiRequestError(
      res.status,
      body?.error ?? {
        code: 'UNKNOWN',
        message: `Upload failed (${res.status})`,
        correlationId: 'unknown',
      },
    );
  }

  return (await res.json()) as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content type when there IS a body. Fastify rejects a
  // request that claims `application/json` and then sends nothing, with a bare
  // 400 — which is what every bodyless PATCH (check-in, call, complete) hit.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body !== undefined && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    onUnauthorized?.();
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: ApiError } | null;
    throw new ApiRequestError(
      res.status,
      body?.error ?? {
        code: 'UNKNOWN',
        message: `Request failed (${res.status})`,
        correlationId: 'unknown',
      },
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface SessionUser {
  id: string;
  fullName: string;
  permissions: string[];
  mustChangePassword: boolean;
}

/** `GET /auth/me` — what the console restores itself from on load. */
export interface CurrentSession {
  userId: string;
  tenantId: string;
  permissions: string[];
  fullName: string;
  /** Every role held, in no particular order. The console picks one to wear. */
  roles: Array<{ key: string; name: string }>;
  /** While true, the console shows nothing but the change-password screen. */
  mustChangePassword: boolean;
  /** Whose clinic this is. The console wears this instead of a product name. */
  tenant: BrandedTenant;
  /**
   * Set when this user IS a bookable doctor; null for front desk, nurses and
   * administrators. What scopes the queue to one doctor's own list — though the
   * API enforces the same rule, so this is only what stops the console offering
   * a choice it would then refuse.
   */
  practitionerId: string | null;
}

/**
 * A clinic's own identity.
 *
 * `logoVersion` is null when the clinic has not uploaded one, in which case the
 * bundled default applies. When it is set, it is both the cache-busting query
 * parameter and the proof that `logoUrlFor` will resolve to something.
 */
export interface BrandedTenant {
  id: string;
  slug: string;
  name: string;
  logoVersion: string | null;
}

/** What the sign-in page can learn about a clinic before anybody signs in. */
export interface PublicBranding {
  name: string;
  logoVersion: string | null;
}

/**
 * Where a clinic's logo lives.
 *
 * Built here rather than returned by the API because it is a URL the browser
 * fetches directly — putting it in the JSON would mean the server guessing at
 * the origin the browser is using. The version makes it immutable: a replaced
 * logo is a different URL, so nothing has to be invalidated.
 */
export function logoUrlFor(slug: string, version: string): string {
  return `${API_BASE}/branding/${encodeURIComponent(slug)}/logo?v=${version}`;
}

/** A permission, described for somebody who is not a programmer. */
export interface PermissionInfo {
  name: string;
  description: string;
  category: string;
}

export interface ClinicRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  requiresMfa: boolean;
  /** False only for Administrator — the way back from every other change. */
  editable: boolean;
  /** A custom role nobody holds. */
  deletable: boolean;
  /** A built-in with shipped permissions to restore. */
  resettable: boolean;
  staffCount: number;
}

export interface StaffUser {
  id: string;
  email: string;
  fullName: string;
  mobile: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  /** Non-null only while a lockout is actually in force. */
  lockedUntil: string | null;
  mfaEnrolled: boolean;
  createdAt: string;
  roles: Array<{ key: string; name: string }>;
}

export interface WeeklySession {
  id: string;
  locationId: string;
  /** 0 = Sunday, matching JavaScript's getDay(). */
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  capacityPerSlot: number;
  validFrom: string;
  validTo: string | null;
}

export interface SetupPractitioner {
  id: string;
  fullName: string;
  prefix: string | null;
  registrationNumber: string | null;
  qualification: string | null;
  specialty: string | null;
  departmentId: string | null;
  userId: string | null;
  consultationFeePaise: number | null;
  followUpFeePaise: number | null;
  overbookPerSession: number;
  isActive: boolean;
  department: { id: string; name: string } | null;
  schedules: WeeklySession[];
  /**
   * What decides whether this doctor can be deleted: any appointment, of any
   * status, or any consultation means switch off instead. Counts rather than a
   * flag so the screen can say why.
   */
  history: { appointments: number; encounters: number };
  /** The login linked to this entry, if any. */
  login: LinkableUser | null;
  /**
   * Present only for an entry with no login and at least one consultation: the
   * one login that may be linked back (the one last unlinked from it), or null
   * when none may. Absent means any eligible login can be linked.
   */
  relinkOnly?: LinkableUser | null;
}

/** A doctor login not yet attached to a bookable practitioner. */
export interface LinkableUser {
  id: string;
  fullName: string;
  email: string;
}

export interface SeatUsage {
  key: string;
  name: string;
  description: string | null;
  requiresMfa: boolean;
  used: number;
  /** Null means unlimited — a clinic nobody has priced yet. */
  limit: number | null;
}

export interface LoginResponse {
  user: SessionUser;
  tenant: BrandedTenant;
}

export interface MfaChallenge {
  mfaRequired: true;
  enrolmentSecret?: string;
  otpauthUrl?: string;
}

export interface PatientSummary {
  id: string;
  uhid: string;
  name: string;
  mobile: string;
  gender: string;
  ageYears: number | null;
  birthDate: string | null;
  city: string | null;
  abhaNumber: string | null;
  createdAt: string;
}

/** One page of `GET /patients/all`. */
export interface PatientPage {
  patients: PatientSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The whole record, from `GET /patients/:id`.
 *
 * Deliberately a superset of `PatientSummary` rather than a replacement for it:
 * search results stay narrow so a live search does not pull addresses, consents
 * and visit history for twenty patients nobody has opened.
 */
/** What a patient's record used to say — FR-P36-22. Administrators only. */
export interface PatientCorrection {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  correctedBy: { id: string; fullName: string };
}

/**
 * The fields a correction may touch.
 *
 * UHID and ABHA are absent, and that absence is the contract: the API refuses
 * them outright, so a form that offered them would be building a request the
 * server declines.
 */
export interface PatientCorrectionInput {
  name?: string;
  gender?: string;
  birthDate?: string;
  ageYears?: number;
  mobile?: string;
  email?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  bloodGroup?: string;
  emergencyContactName?: string;
  emergencyContactMobile?: string;
}

export interface PatientDetail extends PatientSummary {
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  addressLine: string | null;
  state: string | null;
  postalCode: string | null;
  bloodGroup: string;
  emergencyContactName: string | null;
  emergencyContactMobile: string | null;
  abhaAddress: string | null;
  isActive: boolean;
  updatedAt: string;
  consents: Array<{
    purpose: string;
    granted: boolean;
    noticeVersion: string;
    grantedAt: string;
    withdrawnAt: string | null;
  }>;
  appointments: Array<{
    id: string;
    startAt: string;
    status: string;
    visitType: string;
    source: string;
    tokenNumber: number | null;
    reasonForVisit: string | null;
    practitioner: { id: string; fullName: string; prefix: string | null };
    encounterId: string | null;
  }>;
  stats: {
    totalVisits: number;
    completedVisits: number;
    lastVisitAt: string | null;
  };
}

export interface DuplicateCandidate {
  id: string;
  uhid: string;
  name: string;
  mobile: string;
  gender: string;
  ageYears: number | null;
  birthDate: string | null;
  matchReason: 'SAME_MOBILE' | 'SIMILAR_NAME';
  nameSimilarity: number;
  confidence: 'STRONG' | 'WEAK';
}

export interface RegisterPatientInput {
  name: string;
  gender: string;
  ageYears?: number;
  birthDate?: string;
  mobile: string;
  city?: string;
  state?: string;
  postalCode?: string;
  addressLine?: string;
  bloodGroup?: string;
  emergencyContactName?: string;
  emergencyContactMobile?: string;
  consentCareDelivery: boolean;
  consentMarketing?: boolean;
  /** WhatsApp about their own care — docs/10. */
  consentCommunications?: boolean;
  confirmedNotDuplicate?: boolean;
}

// --- scheduling -----------------------------------------------------------

/**
 * A previous visit, as the consultation shows it.
 *
 * Richer than `EncounterSummary`, which the patient record uses: that one counts
 * medicines, this one names them with their dose, because a count is not
 * something a doctor can act on.
 */
export interface PreviousVisit {
  id: string;
  startedAt: string;
  signedAt: string | null;
  chiefComplaint: string | null;
  advice: string | null;
  prescriptionNote: string | null;
  practitioner: { id: string; fullName: string };
  diagnoses: Array<{ code: string | null; display: string; isPrimary: boolean }>;
  prescriptions: Array<{
    drugName: string;
    strength: string | null;
    form: string | null;
    dose: string;
    frequency: string;
    durationDays: number | null;
  }>;
  vitals: {
    systolicMmHg: number | null;
    diastolicMmHg: number | null;
    pulseBpm: number | null;
    temperatureC: number | null;
    spo2Percent: number | null;
    weightKg: number | null;
  } | null;
  tests: Array<{
    id: string;
    description: string;
    resultNote: string | null;
    department: { name: string };
    documents: Array<{ id: string; fileName: string }>;
  }>;
}

/** A test a doctor asked for. */
export interface DiagnosticOrder {
  id: string;
  description: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'DECLINED';
  createdAt: string;
  completedAt: string | null;
  resultNote: string | null;
  /** Null for a walk-in test — it came out of no consultation (FR-DIA-10). */
  appointmentId: string | null;
  /** Who decided the test was needed. Distinct from who keyed the order in. */
  referralSource: 'INTERNAL' | 'EXTERNAL_DOCTOR' | 'SELF';
  referrerName: string | null;
  referrerClinic: string | null;
  referrerPhone: string | null;
  department: { id: string; name: string };
  /** The catalogue test, when the order named one. No price — see `DiagnosticTest`. */
  service: { id: string; code: string; name: string } | null;
  /** The charge raised for it. Null for a free-text order and for legacy ones. */
  invoiceLineId: string | null;
  /**
   * Where this test stands with the money. UNPAID and VOID block the result;
   * LEGACY and NOT_BILLED are shown for information and never block.
   */
  billing: DiagnosticBillingState;
  patient: { id: string; name: string; uhid: string; gender: string; ageYears: number | null };
  orderedBy: { id: string; fullName: string };
  completedBy: { id: string; fullName: string } | null;
  /** Set once the patient has actually been given the report (FR-DIA-13). */
  handedOverAt: string | null;
  handedOverTo: string | null;
  handedOverBy: { id: string; fullName: string } | null;
  _count: { documents: number };
}

/**
 * Where a test stands with the money.
 *
 * The server sends the state, never the payments behind it: the diagnostics
 * room holds no billing permission and has no business seeing a bill's takings.
 */
export type DiagnosticBillingState =
  | { status: 'LEGACY' }
  | { status: 'NOT_BILLED' }
  | { status: 'UNPAID'; invoiceNumber: string; balancePaise: number }
  | { status: 'SETTLED'; invoiceNumber: string }
  | { status: 'VOID'; invoiceNumber: string };

/** One completed test in a patient's history. No billing here — this is clinical. */
export interface PastTest {
  id: string;
  description: string;
  resultNote: string | null;
  completedAt: string;
  appointmentId: string | null;
  department: { name: string };
  service: { name: string } | null;
  documents: Array<{ id: string; fileName: string }>;
}

/**
 * The finance desk's report — FR-FIN-03, as amended by FR-DIA-15.
 *
 * `byDoctor` and `byDepartment` are two answers to two questions, not one
 * answer twice: a walk-in test patient never meets a doctor, so the first
 * cannot see them at all.
 */
export interface FinanceReport {
  from: string;
  to: string;
  timezone: string;
  collections: {
    collectedPaise: number;
    refundedPaise: number;
    netPaise: number;
    transactionCount: number;
    byMode: Array<{
      mode: string;
      collectedPaise: number;
      refundedPaise: number;
      netPaise: number;
    }>;
  };
  byDoctor: Array<{
    practitionerId: string | null;
    name: string;
    patientsSeen: number;
    visits: number;
    grossPaise: number;
    discountPaise: number;
    netBilledPaise: number;
    netCollectedPaise: number;
  }>;
  /**
   * Optional, and not because the server may omit it.
   *
   * A browser can hold a bundle newer than the API it is talking to — a
   * rolling deploy guarantees a window of exactly that, and a dev machine
   * running a stale build makes it a daily occurrence. These two sections are
   * the newest in the payload, so they are the ones that go missing. Declared
   * optional so the page degrades to the sections it did get instead of
   * white-screening on a property read.
   */
  byDepartment?: {
    rows: Array<{
      departmentId: string | null;
      name: string;
      patientsSeen: number;
      items: number;
      grossPaise: number;
      discountPaise: number;
      netBilledPaise: number;
    }>;
    totalBilledPaise: number;
    /** At invoice level. Deliberately NOT split per department — see the service. */
    collectedPaise: number;
  };
  byReferralSource?: Array<{
    source: string;
    patients: number;
    tests: number;
    netBilledPaise: number;
    referrers: Array<{ name: string; tests: number; netBilledPaise: number }>;
  }>;
  discounts: {
    givenCount: number;
    givenPaise: number;
    reversedCount: number;
    reversedPaise: number;
    byPromotion: Array<{ code: string; count: number; discountPaise: number }>;
  };
  outstanding: {
    count: number;
    totalPaise: number;
    deferred: { count: number; totalPaise: number };
  };
  refundsAndReversals: {
    patientRefundedPaise: number;
    recordedInErrorPaise: number;
    totalPaise: number;
  };
}

/** An orderable test with its fee. Only reaches screens that may order. */
export interface DiagnosticTest {
  id: string;
  code: string;
  name: string;
  pricePaise: number;
  department: { id: string; name: string };
}

/** A file held against a patient. Note the absence of an object key. */
export interface ClinicalDocument {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: { id: string; fullName: string };
}

export interface Department {
  id: string;
  name: string;
  /**
   * X-ray, pathology. Absent from the booking list entirely, so this is only
   * ever set on departments read through `setupDepartments`.
   */
  isDiagnostic?: boolean;
}

/**
 * The clinic's patient ID format, as the clinic sees it (FR-UID-02).
 *
 * Read-only: the platform sets it at onboarding and changes it on request.
 */
export interface PatientIdFormat {
  prefix: string;
  width: number;
  /** How many patient IDs this clinic has issued. */
  issued: number;
  /** What the very first ID in this format looks like. */
  example: string;
  /** The ID the next registration will receive. */
  next: string;
  /**
   * The most recent format change, when there has been one — which is also
   * why some older cards may carry a different format.
   */
  lastChanged: { at: string; by: string; reason: string | null } | null;
}

export interface Practitioner {
  id: string;
  fullName: string;
  prefix: string | null;
  specialty: string | null;
  qualification: string | null;
  registrationNumber: string | null;
  /**
   * This doctor's own consultation fee, in paise. Null when they have none, in
   * which case the clinic's CONS-NEW catalogue price applies instead — see
   * `consultationPrice` on the finance desk.
   */
  consultationFeePaise: number | null;
  department: { id: string; name: string } | null;
}

export interface ClinicLocation {
  id: string;
  name: string;
  city: string | null;
}

export interface Slot {
  time: string;
  startAt: string;
  endAt: string;
  capacity: number;
  booked: number;
  available: number;
  overbooking: boolean;
}

export interface DayAvailability {
  date: string;
  timezone: string;
  practitionerId: string;
  slots: Slot[];
  unavailableReason: string | null;
}

export interface Appointment {
  id: string;
  status:
    | 'BOOKED'
    | 'ARRIVED'
    | 'IN_PROGRESS'
    /** Out for an X-ray or a test. Still the same visit. */
    | 'AWAITING_TESTS'
    | 'FULFILLED'
    | 'CANCELLED'
    | 'NO_SHOW';
  visitType: string;
  source: 'FRONT_DESK' | 'WALK_IN' | 'PORTAL';
  startAt: string;
  endAt: string;
  localTime: string;
  reasonForVisit: string | null;
  /** Held from booking onwards. Identity, not position in the queue. */
  tokenNumber: number | null;
  /** When they joined the waiting list. Null until they are checked in. */
  readyAt: string | null;
  /** Set when the visit has been flagged to be seen next. */
  priority: { reasonCode: string; note: string | null; setAt: string } | null;
  /** Set while the patient is out for an investigation. */
  sentOut: { at: string; reason: string } | null;
  returnedAt: string | null;
  checkedInAt: string | null;
  calledAt: string | null;
  completedAt: string | null;
  /** What the patient said from their phone. Informational: it moves nobody. */
  arrivalIntent: 'ON_THE_WAY' | 'RUNNING_LATE' | null;
  arrivalIntentAt: string | null;
  /** When the "time to leave" message went, if it has. */
  leaveNowSentAt: string | null;
  patient: {
    id: string;
    uhid: string;
    name: string;
    mobile: string;
    gender: string;
    ageYears: number | null;
    birthDate: string | null;
  };
  practitioner: { id: string; fullName: string; prefix: string | null; specialty: string | null };
}

export interface QueueView {
  date: string;
  timezone: string;
  nowServing: Appointment | null;
  waiting: Appointment[];
  /** Out for an X-ray or a test — same visit, still open, not in the queue. */
  awayForTests: Appointment[];
  yetToArrive: Appointment[];
  completed: Appointment[];
  cancelled: Appointment[];
  stats: {
    /**
     * Visits not over yet: yet to arrive, waiting, in the room, out for tests.
     * Finished, cancelled and no-show visits are not counted.
     */
    inQueue: number;
    waiting: number;
    awayForTests: number;
    completed: number;
    averageWaitMinutes: number | null;
  };
}

export interface DisplayDevice {
  id: string;
  name: string;
  isActive: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  practitionerIds: string[];
  location: { id: string; name: string } | null;
}

export type QueuePriorityReason =
  'BACK_FROM_TESTS' | 'EMERGENCY' | 'FRAIL_OR_DISTRESSED' | 'DOCTOR_REQUESTED' | 'CLINIC_ERROR';

// --- the consultation -------------------------------------------------------

export interface Vitals {
  id: string;
  recordedAt: string;
  recordedByUserId: string | null;
  heightCm: number | null;
  weightKg: number | null;
  systolicMmHg: number | null;
  diastolicMmHg: number | null;
  pulseBpm: number | null;
  temperatureC: number | null;
  spo2Percent: number | null;
  respiratoryRate: number | null;
  notes: string | null;
  /** Derived by the server from height and weight — never stored, never sent up. */
  bmi: number | null;
}

export interface DiagnosisEntry {
  id?: string;
  codeSystem?: string;
  code: string | null;
  display: string;
  isPrimary: boolean;
  notes?: string | null;
}

export interface PrescriptionEntry {
  id?: string;
  formularyItemId?: string | null;
  drugName: string;
  strength: string | null;
  form: string | null;
  dose: string;
  frequency: string;
  route: string;
  durationDays: number | null;
  quantity: number | null;
  instructions: string | null;
}

export interface Addendum {
  id: string;
  text: string;
  authorLabel: string;
  createdAt: string;
}

export interface Encounter {
  id: string;
  status: 'IN_PROGRESS' | 'SIGNED';
  startedAt: string;
  signedAt: string | null;
  signedByUserId: string | null;
  chiefComplaint: string | null;
  historyOfPresentIllness: string | null;
  examinationFindings: string | null;
  advice: string | null;
  /** FR-CON-11. Prints under its own heading, below Advice. */
  prescriptionNote: string | null;
  followUpDate: string | null;
  followUpNote: string | null;
  /** Ask how they are every N days until the review. Null is off. docs/10. */
  checkInIntervalDays: number | null;
  patient: {
    id: string;
    uhid: string;
    name: string;
    mobile: string;
    gender: string;
    ageYears: number | null;
    birthDate: string | null;
    bloodGroup: string;
  };
  practitioner: {
    id: string;
    fullName: string;
    prefix: string | null;
    qualification: string | null;
    specialty: string | null;
    registrationNumber: string | null;
  };
  appointment: {
    id: string;
    startAt: string;
    tokenNumber: number | null;
    status: string;
    visitType: string;
    /** Tests this centre does not do. Printed on the slip (decision (b)). */
    externalTestNote: string | null;
  };
  vitals: Vitals[];
  latestVitals: Vitals | null;
  diagnoses: DiagnosisEntry[];
  prescriptions: PrescriptionEntry[];
  addenda: Addendum[];
}

export interface EncounterSummary {
  id: string;
  status: 'IN_PROGRESS' | 'SIGNED';
  startedAt: string;
  signedAt: string | null;
  chiefComplaint: string | null;
  practitioner: { id: string; fullName: string; prefix: string | null };
  diagnoses: Array<{ code: string | null; display: string; isPrimary: boolean }>;
  prescriptionCount: number;
}

export interface DiagnosisCode {
  code: string;
  display: string;
}

export interface FormularyItem {
  id: string;
  name: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
}

// --- billing ----------------------------------------------------------------

/**
 * Every amount below is in PAISE, as an integer. ₹350.00 is 35000.
 *
 * Nothing in this file divides by 100 — formatting happens in one helper at the
 * point of display, because a stray float in the middle of a money calculation
 * is a bug nobody notices until the drawer disagrees.
 */
export interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPricePaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  /** Set when this charge is a diagnostic test. Such a line is declined, never deleted. */
  diagnosticOrder: { id: string; status: DiagnosticOrder['status'] } | null;
}

/** Why a compensating entry exists — null on money-in. */
export type PaymentCorrectionKind = 'PATIENT_REFUND' | 'RECORDED_IN_ERROR';

export interface PaymentRow {
  id: string;
  direction: 'IN' | 'REFUND';
  /**
   * Money that LEFT the drawer versus money that was never in it. They net to
   * the same figure and are completely different problems.
   */
  correctionKind: PaymentCorrectionKind | null;
  mode: string;
  amountPaise: number;
  reference: string | null;
  reason: string | null;
  collectedAt: string;
  /** FR-BIL-13. Null only if the author's account has since been removed. */
  collectedBy: { id: string; fullName: string | null };
}

export interface Invoice {
  id: string;
  number: string;
  status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'WAIVED' | 'DEFERRED' | 'CANCELLED';
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  paidPaise: number;
  refundedPaise: number;
  balancePaise: number;
  /** True when the visit may proceed to the queue. */
  settled: boolean;
  reason: string | null;
  issuedAt: string;
  patient: { id: string; uhid: string; name: string; mobile: string };
  lines: InvoiceLine[];
  payments: PaymentRow[];
  appointment: {
    id: string;
    startAt: string;
    status: string;
    externalTestNote: string | null;
    practitioner: { fullName: string; prefix: string | null };
  } | null;
  /**
   * Set while a promotion is on this bill.
   *
   * The signal for "a discount was granted" — NOT `discountPaise`, which also
   * moves when charges change and once had decline write-offs folded into it.
   */
  activePromotionApplicationId: string | null;
  /** Tests taken off this visit's bills, which the desk may put back. */
  removedTests: Array<{
    id: string;
    description: string;
    service: { name: string; pricePaise: number } | null;
  }>;
  /** The visit a test bill came out of — its only link, since `appointment` is the consultation's. */
  visitAppointment: {
    id: string;
    startAt: string;
    status: string;
    externalTestNote: string | null;
    practitioner: { fullName: string; prefix: string | null };
  } | null;
}

/**
 * A discount the administrator has set up (FR-PRO-01).
 *
 * `value` means three different things — 1–100 for PERCENTAGE, paise for FLAT,
 * and nothing at all for CUSTOM — which is why the type travels with it and
 * nothing here does the arithmetic. What a promotion is actually worth against a
 * given bill is worked out on the server, so the screen never shows a figure the
 * invoice will disagree with. A CUSTOM promotion has no worth until somebody
 * types one, which is the whole point of it.
 */
export interface Promotion {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: 'PERCENTAGE' | 'FLAT' | 'CUSTOM';
  /** Null for CUSTOM — the amount is entered when the discount is applied. */
  value: number | null;
  maxDiscountPaise: number | null;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
  timesApplied: number;
  editable: boolean;
}

export interface AppliedPromotion {
  applicationId: string;
  promotion: Promotion;
  discountPaise: number;
  authorisedBy: { id: string; fullName: string };
}

/** A row on the administrator's price list (FR-PRC-01). */
export interface PricedService {
  id: string;
  code: string;
  name: string;
  category: string;
  /** In paise. Rupees exist only on screen. */
  pricePaise: number;
  /** Basis points — 500 is 5%. Zero for almost every clinic. */
  taxRateBasisPoints: number;
  isActive: boolean;
  updatedAt: string;
  department: { id: string; name: string } | null;
}

export interface PriceListInput {
  code: string;
  name: string;
  category: string;
  pricePaise: number;
  taxRateBasisPoints?: number;
  departmentId?: string | null;
  isActive?: boolean;
}

/** Everything the printed receipt needs — FR-RCP-02. */
export interface ReceiptPayload {
  receiptNumber: string;
  issuedAt: string;
  invoiceNumber: string;
  clinic: {
    name: string;
    phone: string | null;
    addressLine: string | null;
    city: string | null;
    logoUpdatedAt: string | null;
  };
  patient: {
    uhid: string;
    name: string;
    mobile: string;
    gender: string;
    ageYears: number | null;
    birthDate: string | null;
  };
  /** Null for a walk-in with no doctor. The sheet does not invent one. */
  doctor: { fullName: string; prefix: string | null } | null;
  lines: Array<{
    description: string;
    quantity: number;
    unitPricePaise: number;
    amountPaise: number;
  }>;
  /** In this order, never collapsed. */
  money: {
    totalChargedPaise: number;
    discountPaise: number;
    discountLabel: string | null;
    taxPaise: number;
    payablePaise: number;
    paidNowPaise: number;
    mode: string;
    reference: string | null;
    balancePaise: number;
  };
  /** True only when something actually carries tax. */
  showTax: boolean;
  receivedBy: string;
  /** Present only on the response that RECORDED a print. */
  print?: {
    printCount: number;
    isDuplicate: boolean;
    printedAt: string;
    printedBy: string;
  };
}

export interface ChargeableService {
  id: string;
  code: string;
  name: string;
  category: string;
  pricePaise: number;
  taxRateBasisPoints: number;
}

export interface DayCollection {
  date: string;
  timezone: string;
  collectedPaise: number;
  refundedPaise: number;
  netPaise: number;
  transactionCount: number;
  byMode: Array<{
    mode: string;
    collectedPaise: number;
    refundedPaise: number;
    netPaise: number;
  }>;
  byCollector: Array<{
    userId: string;
    name: string;
    collectedPaise: number;
    refundedPaise: number;
    netPaise: number;
  }>;
  transactions: Array<{
    direction: 'IN' | 'REFUND';
    mode: string;
    amountPaise: number;
    collectedAt: string;
    collectedBy: string;
    invoiceNumber: string;
    patient: { name: string; uhid: string };
  }>;
}

export interface OutstandingInvoice {
  id: string;
  number: string;
  status: string;
  totalPaise: number;
  balancePaise: number;
  issuedAt: string;
  reason: string | null;
  patient: { id: string; name: string; uhid: string; mobile: string };
}

export type MessageStatus = 'SENT' | 'FAILED' | 'SKIPPED_NO_CONSENT';

export interface PatientMessage {
  id: string;
  kind: 'TOKEN_ISSUED' | 'LEAVE_NOW' | 'CHECKIN_REQUEST' | 'REVIEW_REMINDER' | 'PRESCRIPTION';
  channel: string;
  status: MessageStatus;
  /** As sent, with "[patient link]" where the link was. The link is never stored. */
  body: string;
  createdAt: string;
  appointmentId: string | null;
  encounterId: string | null;
}

export interface RecoveryCheckin {
  id: string;
  dueOn: string;
  sent: boolean;
  answeredAt: string | null;
  painScore: number | null;
  exercisesDone: boolean | null;
  note: string | null;
  flagReason: string | null;
  flagOpen: boolean;
}

export interface Recovery {
  sinceEncounterId: string;
  since: string;
  reviewDate: string | null;
  intervalDays: number | null;
  checkins: RecoveryCheckin[];
  summary: {
    answered: number;
    missed: number;
    firstPain: number | null;
    lastPain: number | null;
    exercisesDone: number;
    exercisesAnswered: number;
  };
}

export type FollowUpStatus = 'FLAGGED' | 'OVERDUE' | 'DUE' | 'BOOKED' | 'CAME_BACK';

export interface FollowUpRow {
  encounterId: string;
  status: FollowUpStatus;
  reviewDate: string | null;
  daysOverdue: number | null;
  visitDate: string;
  patient: { id: string; name: string; uhid: string; mobile: string };
  practitioner: { id: string; fullName: string };
  cameBackAt: string | null;
  valuePaise: number;
  bookedFor: string | null;
  checkins: {
    intervalDays: number | null;
    answered: number;
    missed: number;
    firstPain: number | null;
    lastPain: number | null;
    lastAnsweredAt: string | null;
    exercisesDone: number;
    exercisesAnswered: number;
  };
  flag: { checkinId: string; reason: string | null; at: string | null } | null;
  lastRemindedAt: string | null;
}

export interface FollowUpBoard {
  today: string;
  weekStart: string;
  weekEnd: string;
  scopedToPractitionerId: string | null;
  stats: {
    dueThisWeek: number;
    cameBack: number;
    booked: number;
    overdue: number;
    flagged: number;
    valueKeptPaise: number;
    waitedFromHome: { opened: number; total: number };
  };
  trend: Array<{ weekStart: string; due: number; cameBack: number; rate: number | null }>;
  rows: FollowUpRow[];
}

export const api = {
  departments: () => request<{ departments: Department[] }>('/departments'),

  /** Setup's view — includes diagnostic departments, which booking hides. */
  setupDepartments: () => request<{ departments: Department[] }>('/setup/departments'),

  /** The clinic's patient ID format. Read-only — changing it is the platform's job. */
  patientIdFormat: () => request<PatientIdFormat>('/settings/patient-ids'),

  /**
   * Correct a patient registered earlier — FR-P36-20.
   *
   * Returns the updated record plus any duplicates the change created. A
   * duplicate is a WARNING, never a refusal: blocking would leave the clinic
   * holding both the typo and the duplicate.
   */
  correctPatient: (id: string, input: PatientCorrectionInput) =>
    request<{ patient: PatientSummary; duplicatesWarned: DuplicateCandidate[] }>(
      `/patients/${id}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),

  patientCorrections: (id: string) =>
    request<{ corrections: PatientCorrection[] }>(`/patients/${id}/corrections`),

  /** What happened last time — FR-P36-23. Signed visits only, most recent first. */
  previousVisits: (encounterId: string) =>
    request<{ visits: PreviousVisit[] }>(`/encounters/${encounterId}/previous-visits`),

  // --- diagnostics ----------------------------------------------------------

  diagnosticDepartments: () => request<{ departments: Department[] }>('/diagnostics/departments'),

  /** What can be ordered, and what it costs. Behind `diagnostic:order`. */
  diagnosticCatalogue: (departmentId?: string) =>
    request<{ tests: DiagnosticTest[] }>(
      `/diagnostics/catalogue${departmentId ? `?departmentId=${departmentId}` : ''}`,
    ),

  diagnosticWorklist: (
    params: { departmentId?: string; status?: 'PENDING' | 'COMPLETED' | 'DECLINED' } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.departmentId) query.set('departmentId', params.departmentId);
    if (params.status) query.set('status', params.status);
    const suffix = query.toString();
    return request<{ orders: DiagnosticOrder[] }>(
      `/diagnostics/orders${suffix ? `?${suffix}` : ''}`,
    );
  },

  diagnosticOrder: (id: string) =>
    request<DiagnosticOrder & { documents: ClinicalDocument[] }>(`/diagnostics/orders/${id}`),

  ordersForVisit: (appointmentId: string) =>
    request<{ orders: DiagnosticOrder[] }>(`/appointments/${appointmentId}/diagnostic-orders`),

  raiseDiagnosticOrder: (input: {
    /** A consultation, for a doctor's order. Omitted for a walk-in. */
    appointmentId?: string;
    /** The patient, for a walk-in. Read off the visit when there is one. */
    patientId?: string;
    departmentId: string;
    serviceId?: string;
    description?: string;
    referralSource?: 'INTERNAL' | 'EXTERNAL_DOCTOR' | 'SELF';
    referrerName?: string;
    referrerClinic?: string;
    referrerPhone?: string;
  }) =>
    request<DiagnosticOrder>('/diagnostics/orders', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  cancelDiagnosticOrder: (id: string) =>
    request<DiagnosticOrder>(`/diagnostics/orders/${id}/cancel`, { method: 'PATCH' }),

  /**
   * Every completed test this patient has had, for the doctor seeing them now.
   *
   * 403 unless the caller is this encounter's own doctor and it is still that
   * visit's day — the gate is the point, so callers should expect the refusal
   * and not treat it as an error worth surfacing loudly.
   */
  patientTestHistory: (encounterId: string) =>
    request<{ orders: PastTest[] }>(`/encounters/${encounterId}/patient-test-history`),

  /** Tests this centre does not perform. Goes on the slip, never on a worklist. */
  setExternalTestNote: (appointmentId: string, note: string | null) =>
    request<{ externalTestNote: string | null }>(
      `/appointments/${appointmentId}/external-test-note`,
      { method: 'PUT', body: JSON.stringify({ note }) },
    ),

  /** The patient refused it: charge off the bill, department stood down. */
  declineDiagnosticOrder: (id: string) =>
    request<DiagnosticOrder>(`/diagnostics/orders/${id}/decline`, { method: 'POST' }),

  /**
   * A patient who walked in wanting tests (FR-DIA-10).
   *
   * Several tests, one invoice, one transaction — behind
   * `diagnostic:order:walkin`, which finance holds and the front desk does not.
   */
  raiseWalkInTests: (input: {
    patientId: string;
    serviceIds: string[];
    referralSource: 'EXTERNAL_DOCTOR' | 'SELF';
    referrerName?: string;
    referrerClinic?: string;
    referrerPhone?: string;
  }) =>
    request<{ invoiceId: string; orders: DiagnosticOrder[] }>('/diagnostics/walk-in-orders', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** The patient has been given their report. Recorded once, not a flag. */
  recordHandover: (id: string, handedOverTo: string) =>
    request<DiagnosticOrder>(`/diagnostics/orders/${id}/handover`, {
      method: 'POST',
      body: JSON.stringify({ handedOverTo }),
    }),

  /** Declined by mistake — raise the charge again and put it back on the worklist. */
  undeclineDiagnosticOrder: (id: string) =>
    request<DiagnosticOrder>(`/diagnostics/orders/${id}/undecline`, { method: 'POST' }),

  attachResult: (orderId: string, file: File) =>
    upload<ClinicalDocument>(`/diagnostics/orders/${orderId}/documents`, file),

  completeDiagnosticOrder: (id: string, resultNote: string) =>
    request<DiagnosticOrder>(`/diagnostics/orders/${id}/complete`, {
      method: 'PATCH',
      body: JSON.stringify({ resultNote }),
    }),

  /**
   * A short-lived URL to open a file. Expires in five minutes.
   *
   * The server returns an absolute S3 URL in normal use, and a path relative to
   * the API when the clinic is running without a bucket — resolved here so all
   * four callers can just `window.open` what they are handed.
   */
  documentUrl: async (id: string) => {
    const res = await api.documentUrlRaw(id);
    return res.url.startsWith('/') ? { ...res, url: `${API_BASE}${res.url}` } : res;
  },

  /** The server's answer, unresolved. */
  documentUrlRaw: (id: string) =>
    request<{ url: string; expiresInSeconds: number; fileName: string; contentType: string }>(
      `/documents/${id}/url`,
    ),

  practitioners: (departmentId?: string) =>
    request<{ practitioners: Practitioner[] }>(
      `/practitioners${departmentId ? `?departmentId=${departmentId}` : ''}`,
    ),

  locations: () => request<{ locations: ClinicLocation[] }>('/locations'),

  availability: (practitionerId: string, date: string) =>
    request<DayAvailability>(`/availability?practitionerId=${practitionerId}&date=${date}`),

  bookAppointment: (input: {
    patientId: string;
    practitionerId: string;
    locationId: string;
    departmentId?: string;
    startAt: string;
    visitType?: string;
    reasonForVisit?: string;
  }) => request<Appointment>('/appointments', { method: 'POST', body: JSON.stringify(input) }),

  walkIn: (input: {
    patientId: string;
    practitionerId: string;
    locationId: string;
    departmentId?: string;
    reasonForVisit?: string;
  }) =>
    request<Appointment>('/appointments/walk-in', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  queue: (practitionerId: string, date?: string) =>
    request<QueueView>(`/queue?practitionerId=${practitionerId}${date ? `&date=${date}` : ''}`),

  checkIn: (id: string) =>
    request<Appointment>(`/appointments/${id}/check-in`, { method: 'PATCH' }),
  callPatient: (id: string) =>
    request<Appointment>(`/appointments/${id}/call`, { method: 'PATCH' }),
  completeVisit: (id: string) =>
    request<Appointment>(`/appointments/${id}/complete`, { method: 'PATCH' }),
  markNoShow: (id: string) =>
    request<Appointment>(`/appointments/${id}/no-show`, { method: 'PATCH' }),

  /** Out for an X-ray. The visit stays open and the note stays a draft. */
  sendForTests: (id: string, reason: string) =>
    request<Appointment>(`/appointments/${id}/send-for-tests`, {
      method: 'PATCH',
      body: JSON.stringify({ reason }),
    }),
  /** Back at the desk. `seeNext` decides whether they go to the front. */
  returnFromTests: (id: string, seeNext: boolean, note?: string) =>
    request<Appointment>(`/appointments/${id}/return`, {
      method: 'PATCH',
      body: JSON.stringify({ seeNext, ...(note ? { note } : {}) }),
    }),
  prioritise: (id: string, reasonCode: QueuePriorityReason, note?: string) =>
    request<Appointment>(`/appointments/${id}/priority`, {
      method: 'PATCH',
      body: JSON.stringify({ reasonCode, ...(note ? { note } : {}) }),
    }),
  clearPriority: (id: string) =>
    request<Appointment>(`/appointments/${id}/priority`, { method: 'DELETE' }),

  // --- waiting-room screens -------------------------------------------------

  displayDevices: () => request<{ devices: DisplayDevice[] }>('/display-devices'),
  /** The key comes back ONCE. It is a hash in the database from here on. */
  pairDisplay: (input: { name: string; locationId?: string; practitionerIds?: string[] }) =>
    request<{ id: string; name: string; createdAt: string; accessKey: string }>(
      '/display-devices',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  revokeDisplay: (id: string) =>
    request<{ id: string; isActive: boolean }>(`/display-devices/${id}`, { method: 'DELETE' }),
  rescheduleAppointment: (id: string, startAt: string, reason: string) =>
    request<Appointment>(`/appointments/${id}/reschedule`, {
      method: 'PATCH',
      body: JSON.stringify({ startAt, reason }),
    }),

  cancelAppointment: (id: string, reason: string) =>
    request<Appointment>(`/appointments/${id}/cancel`, {
      method: 'PATCH',
      body: JSON.stringify({ reason }),
    }),

  // --- billing --------------------------------------------------------------

  invoiceForAppointment: (appointmentId: string) =>
    request<Invoice>(`/appointments/${appointmentId}/invoice`),

  invoice: (id: string) => request<Invoice>(`/invoices/${id}`),

  services: () => request<{ services: ChargeableService[] }>('/services'),

  addInvoiceLine: (
    id: string,
    input: { serviceId?: string; description?: string; quantity?: number; unitPricePaise?: number },
  ) => request<Invoice>(`/invoices/${id}/lines`, { method: 'POST', body: JSON.stringify(input) }),

  removeInvoiceLine: (id: string, lineId: string) =>
    request<Invoice>(`/invoices/${id}/lines/${lineId}`, { method: 'DELETE' }),

  collectPayment: (id: string, input: { mode: string; amountPaise: number; reference?: string }) =>
    request<Invoice>(`/invoices/${id}/payments`, { method: 'POST', body: JSON.stringify(input) }),

  refundPayment: (
    id: string,
    input: {
      mode: string;
      amountPaise: number;
      reason: string;
      /** Required by the API — there is deliberately no default. */
      kind: PaymentCorrectionKind;
    },
  ) => request<Invoice>(`/invoices/${id}/refunds`, { method: 'POST', body: JSON.stringify(input) }),

  waiveInvoice: (id: string, reason: string) =>
    request<Invoice>(`/invoices/${id}/waive`, { method: 'POST', body: JSON.stringify({ reason }) }),

  deferInvoice: (id: string, reason: string) =>
    request<Invoice>(`/invoices/${id}/defer`, { method: 'POST', body: JSON.stringify({ reason }) }),

  outstandingInvoices: () => request<{ invoices: OutstandingInvoice[] }>('/invoices'),

  /** FR-FIN-03. A range, defaulting to today when neither end is given. */
  financeReport: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const suffix = q.toString();
    return request<FinanceReport>(`/reports/finance${suffix ? `?${suffix}` : ''}`);
  },

  dayCollection: (date?: string) =>
    request<DayCollection>(`/reports/day-collection${date ? `?date=${date}` : ''}`),

  // --- receipts -------------------------------------------------------------

  /** Read a receipt without recording a print. */
  receipt: (paymentId: string) => request<ReceiptPayload>(`/payments/${paymentId}/receipt`),

  /**
   * Record that the receipt went on paper, and get it back.
   *
   * One call rather than two, so the screen cannot render a sheet it forgot to
   * log — the log is the only thing that can mark a second copy DUPLICATE.
   */
  printReceipt: (paymentId: string) =>
    request<ReceiptPayload>(`/payments/${paymentId}/receipt/prints`, { method: 'POST' }),

  receiptPrints: (paymentId: string) =>
    request<{
      number: string;
      prints: Array<{ printedAt: string; printedBy: string; isDuplicate: boolean }>;
    }>(`/payments/${paymentId}/receipt/prints`),

  // --- promotions -----------------------------------------------------------

  /**
   * `applicableOnly` narrows to what can be used right now — switched on and
   * inside its dates. The finance desk wants that list; an administrator
   * managing them wants all of it.
   */
  promotions: (applicableOnly = false) =>
    request<{ promotions: Promotion[] }>(`/promotions${applicableOnly ? '?applicable=true' : ''}`),

  createPromotion: (input: {
    code: string;
    name: string;
    description?: string;
    type: 'PERCENTAGE' | 'FLAT' | 'CUSTOM';
    /** 1-100 for a percentage, paise for a flat amount. Omitted for CUSTOM. */
    value?: number;
    /** Not allowed on CUSTOM — the server and the CHECK constraint both refuse it. */
    maxDiscountPaise?: number;
    validFrom: string;
    validTo?: string;
  }) => request<Promotion>('/promotions', { method: 'POST', body: JSON.stringify(input) }),

  /**
   * Edit a promotion nobody has used yet.
   *
   * `code` and `type` are absent on purpose — the API refuses to change either,
   * because both turn the promotion into a different thing under the same row
   * and every report that grouped by it would silently re-group. A used
   * promotion is refused entirely with `PROMOTION_IN_USE`.
   */
  updatePromotion: (
    id: string,
    input: {
      name?: string;
      description?: string;
      value?: number;
      maxDiscountPaise?: number;
      validFrom?: string;
      validTo?: string;
    },
  ) => request<Promotion>(`/promotions/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),

  /** Switch off, or back on. This is the delete — there is no DELETE endpoint. */
  setPromotionActive: (id: string, isActive: boolean) =>
    request<Promotion>(`/promotions/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    }),

  /**
   * `customDiscountPaise` belongs to CUSTOM promotions and to no other kind.
   *
   * The server refuses it on a PERCENTAGE or FLAT rather than ignoring it, and
   * refuses a CUSTOM without it — so this is not a field the caller may send
   * "just in case". It is also refused when larger than the bill, which is the
   * check the client cannot make authoritatively: the bill can change between
   * the screen rendering and the request arriving.
   */
  applyPromotion: (
    invoiceId: string,
    input: {
      code?: string;
      promotionId?: string;
      authorisedByUserId: string;
      customDiscountPaise?: number;
    },
  ) =>
    request<AppliedPromotion>(`/invoices/${invoiceId}/promotion`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * Undo, before any payment. A DELETE by shape; the server writes a
   * compensating row and removes nothing.
   */
  removePromotion: (invoiceId: string, reversalKind?: string) =>
    request<{ discountRemovedPaise: number }>(`/invoices/${invoiceId}/promotion`, {
      method: 'DELETE',
      ...(reversalKind ? { body: JSON.stringify({ reversalKind }) } : {}),
    }),

  // --- the consultation ----------------------------------------------------

  /** Opens the note, or resumes the draft. Also calls the patient in. */
  openEncounter: (appointmentId: string) =>
    request<Encounter>('/encounters', {
      method: 'POST',
      body: JSON.stringify({ appointmentId }),
    }),

  getEncounter: (id: string) => request<Encounter>(`/encounters/${id}`),

  updateEncounter: (
    id: string,
    input: {
      chiefComplaint?: string;
      historyOfPresentIllness?: string;
      examinationFindings?: string;
      advice?: string;
      prescriptionNote?: string;
      followUpDate?: string;
      followUpNote?: string;
      checkInIntervalDays?: number | null;
    },
  ) => request<Encounter>(`/encounters/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),

  recordVitals: (
    id: string,
    input: Partial<
      Pick<
        Vitals,
        | 'heightCm'
        | 'weightKg'
        | 'systolicMmHg'
        | 'diastolicMmHg'
        | 'pulseBpm'
        | 'temperatureC'
        | 'spo2Percent'
        | 'respiratoryRate'
      >
    > & { notes?: string },
  ) =>
    request<Encounter>(`/encounters/${id}/vitals`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  setDiagnoses: (
    id: string,
    diagnoses: Array<{ code?: string; display: string; isPrimary?: boolean }>,
  ) =>
    request<Encounter>(`/encounters/${id}/diagnoses`, {
      method: 'PUT',
      body: JSON.stringify({ diagnoses }),
    }),

  setPrescriptions: (
    id: string,
    prescriptions: Array<{
      formularyItemId?: string;
      drugName: string;
      strength?: string;
      form?: string;
      dose: string;
      frequency: string;
      route?: string;
      durationDays?: number;
      quantity?: number;
      instructions?: string;
    }>,
  ) =>
    request<Encounter>(`/encounters/${id}/prescriptions`, {
      method: 'PUT',
      body: JSON.stringify({ prescriptions }),
    }),

  signEncounter: (id: string) => request<Encounter>(`/encounters/${id}/sign`, { method: 'POST' }),

  // --- the patient's journey (docs/10) --------------------------------------

  /** The signed prescription to the patient's WhatsApp, with the check-in link. */
  sendToPatient: (encounterId: string) =>
    request<{ status: MessageStatus }>(`/encounters/${encounterId}/send-to-patient`, {
      method: 'POST',
    }),

  /** Check-ins since the previous visit. Null on a first visit or with none. */
  recovery: (encounterId: string) =>
    request<{ recovery: Recovery | null }>(`/encounters/${encounterId}/recovery`),

  followUps: (week?: string) => request<FollowUpBoard>(`/follow-ups${week ? `?week=${week}` : ''}`),
  remindReview: (encounterId: string) =>
    request<{ status: MessageStatus }>(`/follow-ups/${encounterId}/remind`, { method: 'POST' }),
  remindAllOverdue: () =>
    request<{ sent: number; skipped: number }>('/follow-ups/remind-overdue', { method: 'POST' }),
  dispatchCheckins: () =>
    request<{ sent: number }>('/follow-ups/dispatch-checkins', { method: 'POST' }),
  clearFlag: (checkinId: string) =>
    request<{ id: string; cleared: boolean }>(`/follow-ups/checkins/${checkinId}/clear-flag`, {
      method: 'POST',
    }),

  setCommunicationsConsent: (patientId: string, granted: boolean) =>
    request<{ patientId: string; communications: boolean }>(
      `/patients/${patientId}/communications-consent`,
      { method: 'PUT', body: JSON.stringify({ granted }) },
    ),
  patientMessages: (patientId: string) =>
    request<{ messages: PatientMessage[]; communicationsConsent: boolean }>(
      `/patients/${patientId}/messages`,
    ),

  addAddendum: (id: string, text: string) =>
    request<Encounter>(`/encounters/${id}/addenda`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  patientEncounters: (patientId: string) =>
    request<{ encounters: EncounterSummary[] }>(`/patients/${patientId}/encounters`),

  diagnosisCodes: (q: string) =>
    request<{ codes: DiagnosisCode[] }>(`/diagnosis-codes?q=${encodeURIComponent(q)}`),

  formulary: (q: string) =>
    request<{ items: FormularyItem[] }>(`/formulary?q=${encodeURIComponent(q)}`),

  login: (input: { tenantSlug: string; email: string; password: string; totpCode?: string }) =>
    request<LoginResponse | MfaChallenge>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  confirmMfa: (input: { tenantSlug: string; email: string; password: string; totpCode: string }) =>
    request<LoginResponse | MfaChallenge>('/auth/mfa/confirm', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  me: () => request<CurrentSession>('/auth/me'),

  /**
   * A clinic's name and logo, by slug, with no session.
   *
   * The one call in this client that works before sign-in. An unknown slug is
   * answered in the same shape as a known one — the API returns neutral
   * branding rather than a 404 — so this call has no "no such clinic" case to
   * handle. That is a convenience, not a secrecy guarantee: a real clinic's
   * actual name comes back in the body, and nothing can hide that while the
   * point of the call is to display it.
   */
  branding: (slug: string) => request<PublicBranding>(`/branding/${encodeURIComponent(slug)}`),

  /** The signed-in clinic's own branding, for the settings screen. */
  myBranding: () => request<PublicBranding>('/branding'),

  renameClinic: (name: string) =>
    request<{ name: string }>('/branding', { method: 'PATCH', body: JSON.stringify({ name }) }),

  /**
   * Replace the logo.
   *
   * Takes base64 rather than a File, so the caller decides how the bytes were
   * obtained — a file picker today, a drag-and-drop or a crop tool later —
   * without this module growing a dependency on the DOM.
   */
  setClinicLogo: (base64: string) =>
    request<{ logoVersion: string; width: number; height: number }>('/branding/logo', {
      method: 'PUT',
      body: JSON.stringify({ logo: base64 }),
    }),

  clearClinicLogo: () => request<void>('/branding/logo', { method: 'DELETE' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // --- roles and permissions ------------------------------------------------

  permissionCatalogue: () =>
    request<{ categories: Array<{ category: string; permissions: PermissionInfo[] }> }>(
      '/permissions',
    ),

  clinicRoles: () => request<{ roles: ClinicRole[] }>('/roles'),

  createRole: (input: { name: string; description?: string; permissions: string[] }) =>
    request<ClinicRole>('/roles', { method: 'POST', body: JSON.stringify(input) }),

  /** Returns `signedOut` — how many people this change just signed out. */
  updateRole: (
    id: string,
    input: { name?: string; description?: string; permissions?: string[] },
  ) =>
    request<ClinicRole & { signedOut: number }>(`/roles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  resetRole: (id: string) =>
    request<ClinicRole & { signedOut: number }>(`/roles/${id}/reset`, { method: 'POST' }),

  deleteRole: (id: string) => request<{ id: string }>(`/roles/${id}`, { method: 'DELETE' }),

  // --- staff accounts -------------------------------------------------------

  staff: () => request<{ users: StaffUser[]; seats: SeatUsage[] }>('/users'),

  /**
   * Id and display name of active staff, for naming who authorised a discount.
   *
   * Deliberately NOT `staff()`. That one is behind `user:manage` and returns
   * emails, roles and lockout state; this returns two columns and is behind
   * `promotion:apply`, so the finance desk can fill its approver dropdown
   * without being handed the power to create accounts.
   */
  approvers: () =>
    request<{ approvers: Array<{ id: string; fullName: string }> }>('/users/approvers'),

  /** The temporary password comes back ONCE. */
  createStaff: (input: { email: string; fullName: string; mobile?: string; roleKeys: string[] }) =>
    request<{ id: string; email: string; fullName: string; temporaryPassword: string }>('/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * Who somebody is — their name and their number, and nothing else.
   *
   * No `email`: it is the login identifier, and the server does not merely
   * ignore an email sent here, it rejects the whole request. No `roleKeys`
   * either. The endpoint accepts them, and deciding what somebody may do is a
   * heavier question than fixing a typo in their name — it belongs to its own
   * screen, not to this form.
   *
   * `mobile: null` clears a stored number. The form sends '' for that and the
   * server maps it; see `UpdateUserDto`.
   */
  updateStaff: (id: string, input: { fullName?: string; mobile?: string | null }) =>
    request<StaffUser>(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  setStaffActive: (id: string, isActive: boolean) =>
    request<StaffUser>(`/users/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    }),

  // --- clinic setup ---------------------------------------------------------

  setupPractitioners: () =>
    request<{ practitioners: SetupPractitioner[]; linkableUsers: LinkableUser[] }>(
      '/setup/practitioners',
    ),

  createDepartment: (name: string, isDiagnostic = false) =>
    request<Department>('/departments', {
      method: 'POST',
      body: JSON.stringify({ name, isDiagnostic }),
    }),

  createPractitioner: (input: {
    fullName: string;
    prefix?: string;
    registrationNumber?: string;
    qualification?: string;
    specialty?: string;
    departmentId?: string;
    userId?: string;
    consultationFeePaise?: number;
    followUpFeePaise?: number;
  }) =>
    request<{ id: string; fullName: string }>('/setup/practitioners', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * A doctor's profile — and the type is the point.
   *
   * This was `Record<string, unknown>`, which accepts anything and warns about
   * nothing. `departmentId` is not on this shape because the server refuses it
   * with a 400: a doctor's department anchors the finance report's revenue
   * split and walk-in diagnostics, and moving it would change what past reports
   * mean rather than re-file them. `userId` is off it too — linking a login is
   * a real feature, just not this form.
   *
   * A `null` fee clears the override and puts the doctor back on the service
   * catalogue's price. Zero is a different answer and stays available.
   */
  updatePractitioner: (
    id: string,
    input: {
      fullName?: string;
      prefix?: string;
      registrationNumber?: string;
      qualification?: string;
      specialty?: string;
      consultationFeePaise?: number | null;
      followUpFeePaise?: number | null;
      isActive?: boolean;
    },
  ) =>
    request<{ id: string; fullName: string; isActive: boolean }>(`/setup/practitioners/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  addSchedule: (
    practitionerId: string,
    input: {
      locationId: string;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      slotMinutes?: number;
      capacityPerSlot?: number;
    },
  ) =>
    request<{ id: string }>(`/setup/practitioners/${practitionerId}/schedules`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * Delete a doctor added by mistake. The server refuses with a 409 and the
   * counts if the doctor has any appointment or consultation.
   */
  deletePractitioner: (id: string) =>
    request<{ id: string; deleted: true }>(`/setup/practitioners/${id}`, { method: 'DELETE' }),

  /** Administrator only. The entry and its history stay; only the link goes. */
  unlinkLogin: (id: string, reason: string) =>
    request<{ id: string; userId: null }>(`/setup/practitioners/${id}/unlink-login`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /** Administrator only, to an entry with no login. */
  linkLogin: (id: string, userId: string, reason: string) =>
    request<{ id: string; userId: string }>(`/setup/practitioners/${id}/link-login`, {
      method: 'POST',
      body: JSON.stringify({ userId, reason }),
    }),

  removeSchedule: (id: string) =>
    request<{ id: string }>(`/setup/schedules/${id}`, { method: 'DELETE' }),

  upsertService: (input: PriceListInput) =>
    request<PricedService>('/setup/services', { method: 'POST', body: JSON.stringify(input) }),

  /**
   * The administrator's price list — everything, switched-off included.
   *
   * Not `services()`. That one is what may go on a bill: active only, behind
   * `invoice:read`. This is what the clinic charges for, behind
   * `tenant:configure`, and it has to show the withdrawn ones so one can be
   * brought back.
   */
  priceList: () =>
    request<{ services: PricedService[]; departments: Array<{ id: string; name: string }> }>(
      '/setup/services',
    ),

  /** Switch a service off, or back on. There is no delete — FR-PRC-03. */
  setServiceActive: (id: string, isActive: boolean) =>
    request<PricedService>(`/setup/services/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    }),

  resetStaffPassword: (id: string) =>
    request<{ id: string; fullName: string; email: string; temporaryPassword: string }>(
      `/users/${id}/reset-password`,
      { method: 'POST' },
    ),

  searchPatients: (q: string) =>
    request<{ patients: PatientSummary[] }>(`/patients?q=${encodeURIComponent(q)}`),

  /**
   * One page of every active patient, newest registration first.
   *
   * `pageSize` and `total` come back with the rows, so the screen can say
   * "showing 31–60 of 242" and draw its page numbers without holding its own
   * copy of either. A page past the last one is not an error: it comes back
   * empty, with the real total, so the screen can point at the last page.
   */
  allPatients: (page: number) =>
    request<PatientPage>(`/patients/all?page=${encodeURIComponent(String(page))}`),

  getPatient: (id: string) => request<PatientDetail>(`/patients/${id}`),

  checkDuplicates: (input: { name: string; mobile: string }) =>
    request<{ duplicates: DuplicateCandidate[] }>('/patients/check-duplicates', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  registerPatient: (input: RegisterPatientInput) =>
    request<{ patient: PatientSummary; duplicatesWarned: DuplicateCandidate[] }>('/patients', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
