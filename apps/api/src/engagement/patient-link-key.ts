import { createHash, randomBytes } from 'node:crypto';

/**
 * The credential a patient holds in a WhatsApp message.
 *
 * Shape: `<tenantId>.<256 bits of randomness>`, the same construction as a
 * waiting-room screen key and for the same reason: every table is under FORCE
 * row-level security, so `patient_link` cannot be read before tenant context
 * exists, and a patient on their phone has no session to derive it from. The
 * tenant in the key lets the API set context first and read inside the policy.
 *
 * Duplicated rather than imported from `display-key.ts`, deliberately: a
 * patient's link and a television's key share a shape today, and a change to
 * one must not quietly change the other.
 */
export function generatePatientLinkKey(tenantId: string): string {
  const secret = randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${tenantId}.${secret}`;
}

/** The tenant a key claims to belong to, or null if it is malformed. */
export function tenantIdFromPatientLinkKey(key: string): string | null {
  const dot = key.indexOf('.');
  if (dot <= 0) return null;

  const candidate = key.slice(0, dot);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : null;
}

export function hashPatientLinkKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
