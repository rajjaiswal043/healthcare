import type { FastifyReply } from 'fastify';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './tokens.js';
import { loadEnv } from '../../config/env.js';

export const ACCESS_COOKIE = 'hc_at';
export const REFRESH_COOKIE = 'hc_rt';

/**
 * Session cookies.
 *
 * httpOnly    — JavaScript cannot read them, so an XSS bug cannot steal the
 *               session. This is the single reason tokens are not in
 *               localStorage, which both checklists call out explicitly.
 * SameSite    — Strict. The browser never sends these on a cross-site request,
 *               which is CSRF protection at the transport level rather than
 *               bolted on with tokens. Workable because the console and API are
 *               same-site (localhost:3000 / :3001 differ only by port, and ports
 *               do not affect site).
 * Secure      — always in production. Omitted on localhost only because there is
 *               no TLS there; the environment check below is deliberate rather
 *               than a blanket `secure: true` that would silently break dev.
 *
 * The refresh cookie is scoped to the refresh path, so it is not sent on every
 * ordinary API call — a token that travels less is exposed less.
 */
function baseCookie(): string[] {
  const env = loadEnv();
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (env.NODE_ENV === 'production') attrs.push('Secure');
  return attrs;
}

export function setAuthCookies(
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string,
): void {
  const access = [
    `${ACCESS_COOKIE}=${encodeURIComponent(accessToken)}`,
    ...baseCookie(),
    `Max-Age=${ACCESS_TOKEN_TTL_SECONDS}`,
  ].join('; ');

  const refresh = [
    `${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}`,
    'Path=/api/v1/auth',
    'HttpOnly',
    'SameSite=Strict',
    ...(loadEnv().NODE_ENV === 'production' ? ['Secure'] : []),
    `Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`,
  ].join('; ');

  void reply.header('set-cookie', [access, refresh]);
}

export function clearAuthCookies(reply: FastifyReply): void {
  void reply.header('set-cookie', [
    `${ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    `${REFRESH_COOKIE}=; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=0`,
  ]);
}

export function readRefreshCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return decodeURIComponent(rest.join('='));
  }

  return null;
}
