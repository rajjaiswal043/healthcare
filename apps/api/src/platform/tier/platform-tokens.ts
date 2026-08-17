import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Platform credentials, deliberately not the clinic ones.
 *
 * A separate signer rather than a `realm` claim bolted onto the clinic token.
 * The two realms have different lifetimes, different tables and different
 * consequences, and the cheapest way to guarantee a token from one is useless in
 * the other is for the code paths never to meet. A clinic token has no `psid`;
 * a platform token has no `tid`. Neither verifier will accept the other's shape.
 *
 * Shorter access lifetime than the clinic's fifteen minutes: this session can
 * suspend a hospital, and it is used for minutes at a time, not all day.
 */
export const PLATFORM_ACCESS_TTL_SECONDS = 10 * 60;
export const PLATFORM_REFRESH_TTL_SECONDS = 12 * 60 * 60;

export interface PlatformClaims {
  /** platform user id */
  sub: string;
  /** platform session id */
  psid: string;
  /** Present and equal to 'platform'. A clinic token never carries it. */
  realm: 'platform';
  iat: number;
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

export function signPlatformToken(
  claims: Pick<PlatformClaims, 'sub' | 'psid'>,
  secret: string,
  ttlSeconds = PLATFORM_ACCESS_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: PlatformClaims = {
    ...claims,
    realm: 'platform',
    iat: now,
    exp: now + ttlSeconds,
  };

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());

  return `${header}.${body}.${signature}`;
}

export function verifyPlatformToken(token: string, secret: string): PlatformClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts as [string, string, string];

  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const provided = fromBase64url(signature);

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    // eslint-disable-next-line no-restricted-syntax -- signature verified above; every field is shape-checked below
    const claims = JSON.parse(fromBase64url(body).toString('utf8')) as PlatformClaims;

    // `realm` is what makes a clinic token unusable here even if it were signed
    // with the same secret.
    if (claims.realm !== 'platform') return null;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (!claims.sub || !claims.psid) return null;

    return claims;
  } catch {
    return null;
  }
}

/**
 * Refresh token: opaque random bytes, stored only as a SHA-256 hash.
 *
 * No tenant prefix, unlike the clinic's — `platform_session` is not
 * tenant-scoped, so there is no context to establish before it can be read.
 */
export function generatePlatformRefreshToken(): string {
  return base64url(randomBytes(32));
}

export function hashPlatformRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
