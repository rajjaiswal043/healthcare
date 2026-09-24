import type { FastifyReply } from 'fastify';
import { PLATFORM_ACCESS_TTL_SECONDS, PLATFORM_REFRESH_TTL_SECONDS } from './platform-tokens.js';
import { loadEnv } from '../../config/env.js';

/**
 * Platform cookies, named apart from the clinic's on purpose.
 *
 * If both realms used `hc_at`, signing into the platform console in the same
 * browser as a clinic would silently overwrite the clinic session — and the
 * reverse. Different names mean somebody can hold both at once, which is exactly
 * what we do while onboarding: create a clinic in one tab, sign into it in the
 * next to check it works.
 */
export const PLATFORM_ACCESS_COOKIE = 'hc_pat';
export const PLATFORM_REFRESH_COOKIE = 'hc_prt';

function attrs(): string[] {
  const env = loadEnv();
  const base = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (env.NODE_ENV === 'production') base.push('Secure');
  return base;
}

export function setPlatformCookies(
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string,
): void {
  reply.header('set-cookie', [
    [
      `${PLATFORM_ACCESS_COOKIE}=${encodeURIComponent(accessToken)}`,
      ...attrs(),
      `Max-Age=${PLATFORM_ACCESS_TTL_SECONDS}`,
    ].join('; '),
    [
      `${PLATFORM_REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}`,
      ...attrs(),
      `Max-Age=${PLATFORM_REFRESH_TTL_SECONDS}`,
    ].join('; '),
  ]);
}

export function clearPlatformCookies(reply: FastifyReply): void {
  reply.header('set-cookie', [
    [`${PLATFORM_ACCESS_COOKIE}=`, ...attrs(), 'Max-Age=0'].join('; '),
    [`${PLATFORM_REFRESH_COOKIE}=`, ...attrs(), 'Max-Age=0'].join('; '),
  ]);
}

export function readPlatformCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }

  return null;
}
