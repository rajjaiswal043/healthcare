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
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
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

export const api = {
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

  getPatient: (id: string) => request<PatientSummary>(`/patients/${id}`),

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
