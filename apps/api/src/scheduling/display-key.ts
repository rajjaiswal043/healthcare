import { createHash, randomBytes } from 'node:crypto';

/**
 * The credential a waiting-room screen holds.
 *
 * Shape: `<tenantId>.<256 bits of randomness>` — the same construction as a
 * session refresh token, for the same reason. Every table is under FORCE row
 * level security, so `display_device` cannot be read at all before tenant
 * context exists, and a television has no session to derive that context from.
 * Carrying the tenant in the key means the API sets context first and then reads
 * INSIDE the policy, exactly like every other query in the system.
 *
 * The prefix is not a secret and grants nothing by itself: the secret half is 32
 * random bytes, and only the SHA-256 of the whole string is ever stored.
 *
 * Deliberately duplicated rather than imported from the auth module: these two
 * credentials happen to share a shape today, and a screen key that changed
 * because someone rotated the session token format would take every clinic's
 * waiting room dark.
 */
export function generateDisplayKey(tenantId: string): string {
  const secret = randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${tenantId}.${secret}`;
}

/** Extracts the tenant id from a display key, or null if malformed. */
export function tenantIdFromDisplayKey(key: string): string | null {
  const dot = key.indexOf('.');
  if (dot <= 0) return null;

  const candidate = key.slice(0, dot);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : null;
}

export function hashDisplayKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
