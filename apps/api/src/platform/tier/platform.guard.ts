import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { verifyPlatformToken } from './platform-tokens.js';
import { PLATFORM_ACCESS_COOKIE, readPlatformCookie } from './platform-cookies.js';
import { loadEnv } from '../../config/env.js';

export interface PlatformActor {
  platformUserId: string;
  sessionId: string;
}

/**
 * The platform realm's door.
 *
 * Applied per-controller rather than globally: the global AuthGuard is the
 * clinic's, and platform routes opt out of it with @Public() and into this one.
 * That reads backwards until you notice what it buys — @Public() is greppable,
 * so "which routes leave the clinic guard" is one search, and every one of them
 * is in this module.
 *
 * A clinic access token fails here because it carries no `realm`, and a platform
 * token fails the clinic guard because it carries no `tid`. Neither is a check
 * someone has to remember to write.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest & { platform?: PlatformActor }>();

    const token =
      readPlatformCookie(req.headers.cookie, PLATFORM_ACCESS_COOKIE) ??
      bearer(req.headers.authorization);

    if (!token) throw new UnauthorizedException('No platform session');

    const claims = verifyPlatformToken(token, loadEnv().JWT_ACCESS_SECRET);
    if (!claims) throw new UnauthorizedException('No platform session');

    req.platform = { platformUserId: claims.sub, sessionId: claims.psid };
    return true;
  }
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}
