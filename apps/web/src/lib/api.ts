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

export interface LoginResponse {
  user: SessionUser;
  tenant: { id: string; slug: string };
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

/**
 * The whole record, from `GET /patients/:id`.
 *
 * Deliberately a superset of `PatientSummary` rather than a replacement for it:
 * search results stay narrow so a live search does not pull addresses, consents
 * and visit history for twenty patients nobody has opened.
 */
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
  confirmedNotDuplicate?: boolean;
}

// --- scheduling -----------------------------------------------------------

export interface Department {
  id: string;
  name: string;
}

export interface Practitioner {
  id: string;
  fullName: string;
  prefix: string | null;
  specialty: string | null;
  qualification: string | null;
  registrationNumber: string | null;
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
  status: 'BOOKED' | 'ARRIVED' | 'IN_PROGRESS' | 'FULFILLED' | 'CANCELLED' | 'NO_SHOW';
  visitType: string;
  source: 'FRONT_DESK' | 'WALK_IN' | 'PORTAL';
  startAt: string;
  endAt: string;
  localTime: string;
  reasonForVisit: string | null;
  tokenNumber: number | null;
  checkedInAt: string | null;
  calledAt: string | null;
  completedAt: string | null;
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
  yetToArrive: Appointment[];
  completed: Appointment[];
  cancelled: Appointment[];
  stats: {
    total: number;
    waiting: number;
    completed: number;
    averageWaitMinutes: number | null;
  };
}

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
  followUpDate: string | null;
  followUpNote: string | null;
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
}

export interface PaymentRow {
  id: string;
  direction: 'IN' | 'REFUND';
  mode: string;
  amountPaise: number;
  reference: string | null;
  reason: string | null;
  collectedAt: string;
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
    practitioner: { fullName: string; prefix: string | null };
  } | null;
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

export const api = {
  departments: () => request<{ departments: Department[] }>('/departments'),

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

  refundPayment: (id: string, input: { mode: string; amountPaise: number; reason: string }) =>
    request<Invoice>(`/invoices/${id}/refunds`, { method: 'POST', body: JSON.stringify(input) }),

  waiveInvoice: (id: string, reason: string) =>
    request<Invoice>(`/invoices/${id}/waive`, { method: 'POST', body: JSON.stringify({ reason }) }),

  deferInvoice: (id: string, reason: string) =>
    request<Invoice>(`/invoices/${id}/defer`, { method: 'POST', body: JSON.stringify({ reason }) }),

  outstandingInvoices: () => request<{ invoices: OutstandingInvoice[] }>('/invoices'),

  dayCollection: (date?: string) =>
    request<DayCollection>(`/reports/day-collection${date ? `?date=${date}` : ''}`),

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
      followUpDate?: string;
      followUpNote?: string;
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

  me: () => request<{ userId: string; tenantId: string; permissions: string[] }>('/auth/me'),

  searchPatients: (q: string) =>
    request<{ patients: PatientSummary[] }>(`/patients?q=${encodeURIComponent(q)}`),

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
