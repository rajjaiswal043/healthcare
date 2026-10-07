import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Access and refresh tokens.
 *
 * Access token: a compact signed token (HMAC-SHA256) carrying userId, tenantId,
 * sessionId and the user's permissions. Signed rather than looked up so the hot
 * path costs no database round trip.
 *
 * Refresh token: opaque random bytes. Only its SHA-256 hash is stored, so a
 * database dump yields no usable tokens.
 *
 * ---------------------------------------------------------------------------
 * SESSIONS DO NOT TIME OUT. Narveer's decision, 7 Oct 2026.
 *
 * These were 15 minutes and 7 days. The 15 minutes was the one people met: the
 * browser has no refresh loop — `POST /auth/refresh` exists and the web app
 * never calls it — so a quarter of an hour on one screen ended with the next
 * click landing on the sign-in page. A clinic that signs in at nine should stay
 * signed in until somebody signs out.
 *
 * WHAT THIS COSTS, so whoever reads this next does not have to work it out:
 *
 *   A permission change no longer takes effect until the person signs out. The
 *   access token carries `perms` and is verified by signature alone — no
 *   database lookup, which is what keeps the hot path free — so an edited role
 *   reaches somebody only when they next sign in.
 *
 *   The same applies to revoking a session. `revokeSessionsForRole` still
 *   writes `revoked_at`, and the refresh path still refuses a revoked session,
 *   but nothing refreshes, so a revoked session keeps working. The roles screen
 *   still says it signs people out; with this lifetime, it does not.
 *
 * Accepted because this clinic is not editing roles and the console runs on
 * staff machines inside the practice. If role editing starts being used, or a
 * console is ever reachable from outside the clinic, the fix is not to shorten
 * this again on its own — it is to add refresh-and-retry in the browser, which
 * gives unlimited sessions AND working revocation. The API half already exists.
 * ---------------------------------------------------------------------------
 */

/** One year. Not Infinity: a token has to carry some `exp`, and a date that
 *  cannot be represented is a different class of bug. Long enough that nobody
 *  meets it; short enough to be a real number. */
export const ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

export interface AccessTokenClaims {
  /** user id */
  sub: string;
  /** tenant id */
  tid: string;
  /** session id */
  sid: string;
  /** permissions */
  perms: string[];
  /** issued at (epoch seconds) */
  iat: number;
  /** expires at (epoch seconds) */
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenClaims = { ...claims, iat: now, exp: now + ttlSeconds };

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());

  return `${header}.${body}.${signature}`;
}

export function verifyAccessToken(token: string, secret: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts as [string, string, string];

  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const provided = fromBase64url(signature);

  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    // The HMAC signature is verified above, so these bytes are ours, not a
    // caller's. Every field is shape-checked immediately below, and a parse
    // failure is caught and treated as an invalid token. A zod schema here would
    // add work to the hot path of every authenticated request for no additional
    // guarantee.
    // eslint-disable-next-line no-restricted-syntax -- see comment above
    const claims = JSON.parse(fromBase64url(body).toString('utf8')) as AccessTokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (!claims.sub || !claims.tid || !claims.sid || !Array.isArray(claims.perms)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/**
 * Refresh token: `<tenantId>.<256 bits of randomness>`.
 *
 * The tenant id is a prefix, not a secret, and it is there for a specific
 * reason: every table is under FORCE ROW LEVEL SECURITY, so the `session` table
 * cannot be read at all without tenant context — and at refresh time there is no
 * session yet to derive that context from.
 *
 * The alternatives were worse. A privileged lookup function would need BYPASSRLS,
 * creating a role that can read every tenant's sessions. A side table mapping
 * token to tenant would duplicate the thing being protected. Carrying the tenant
 * in the token means we set context first and then read *inside* the policy,
 * exactly like every other query in the system.
 *
 * The secret half is unchanged: 32 random bytes, and only a SHA-256 hash of the
 * whole string is stored.
 */
export function generateRefreshToken(tenantId: string): string {
  return `${tenantId}.${base64url(randomBytes(32))}`;
}

/** Extracts the tenant id from a refresh token, or null if malformed. */
export function tenantIdFromRefreshToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const candidate = token.slice(0, dot);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : null;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
