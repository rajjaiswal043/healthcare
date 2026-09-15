/**
 * The platform console's client.
 *
 * Deliberately a separate file from lib/api.ts rather than a section inside it.
 * The two realms authenticate differently, hold different cookies and can do
 * entirely different things — and the one mistake worth engineering against here
 * is a clinic screen quietly calling a platform endpoint because both were one
 * import away. They are not.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';

export interface PlatformError {
  code: string;
  message: string;
  correlationId: string;
  details?: { code?: string };
}

export class PlatformRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: PlatformError,
  ) {
    super(error.message);
    this.name = 'PlatformRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}/platform${path}`, {
    ...init,
    credentials: 'include',
    headers,
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: PlatformError } | null;
    throw new PlatformRequestError(
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

export interface PlatformUser {
  id: string;
  email: string;
  fullName: string;
  lastLoginAt?: string | null;
}

export interface PlatformMfaChallenge {
  mfaRequired: true;
  enrolmentSecret?: string;
  otpauthUrl?: string;
}

export interface Clinic {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  timezone: string;
  contactEmail: string | null;
  contactMobile: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
  activeUsers: number;
  patients: number;
  lastSignInAt: string | null;
  /** The patient ID format new registrations get. */
  uhidPrefix: string;
  uhidPadding: number;
  /** How many patient IDs have been issued — the next one is this plus one. */
  uhidIssued: number;
}

export interface OnboardResult {
  clinic: { id: string; slug: string; name: string; uhidPrefix: string; uhidPadding: number };
  admin: { email: string; temporaryPassword: string };
}

export const platformApi = {
  login: (input: { email: string; password: string; totpCode?: string }) =>
    request<{ user: PlatformUser } | PlatformMfaChallenge>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  confirmMfa: (input: { email: string; password: string; totpCode: string }) =>
    request<{ user: PlatformUser }>('/auth/mfa/confirm', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  me: () => request<PlatformUser>('/auth/me'),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  clinics: () => request<{ clinics: Clinic[] }>('/clinics'),

  onboard: (input: {
    name: string;
    slug: string;
    uhidPrefix?: string;
    /** Digits the patient number is padded to, 3–8. The server defaults to 5. */
    uhidPadding?: number;
    contactEmail?: string;
    contactMobile?: string;
    seatLimits?: Record<string, number>;
    admin: { email: string; fullName: string };
  }) => request<OnboardResult>('/clinics', { method: 'POST', body: JSON.stringify(input) }),

  suspend: (id: string, reason: string) =>
    request<Clinic>(`/clinics/${id}/suspend`, {
      method: 'PATCH',
      body: JSON.stringify({ reason }),
    }),

  reactivate: (id: string) => request<Clinic>(`/clinics/${id}/reactivate`, { method: 'PATCH' }),

  setSeatLimits: (id: string, seatLimits: Record<string, number>) =>
    request<unknown>(`/clinics/${id}/seat-limits`, {
      method: 'PATCH',
      body: JSON.stringify({ seatLimits }),
    }),

  /**
   * Change a clinic's patient ID format (FR-UID-03). Existing patients keep
   * their IDs; the counter carries on. Recorded in the clinic's audit trail.
   */
  changeUhidFormat: (
    id: string,
    input: { uhidPrefix: string; uhidPadding: number; reason: string },
  ) =>
    request<{ uhidPrefix: string; uhidPadding: number; uhidIssued: number; nextUhid: string }>(
      `/clinics/${id}/uhid-format`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),
};

/** Suggest a sign-in address from a clinic name. Mirrors the server's rule. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}
