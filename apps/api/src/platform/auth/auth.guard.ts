import { Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { verifyAccessToken } from './tokens.js';
import { PUBLIC_KEY, PERMISSIONS_KEY, ANY_PERMISSIONS_KEY } from './decorators.js';
import { loadEnv } from '../../config/env.js';
import { ACCESS_COOKIE } from './cookies.js';

/**
 * Authentication and authorisation, in that order.
 *
 * Registered globally, so every route requires a valid session unless it opts
 * out with @Public(). That default is the point: forgetting a decorator makes a
 * route *inaccessible* rather than *unprotected*.
 *
 * The tenant comes from the signed token, never from anything the caller
 * controls. This is what replaced the x-demo-tenant header, and it is the
 * difference between row-level security protecting against developer error and
 * protecting against an actual attacker.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const env = loadEnv();

    const token = readToken(req);
    if (!token) throw new UnauthorizedException('Not signed in');

    const claims = verifyAccessToken(token, env.JWT_ACCESS_SECRET);
    if (!claims) throw new UnauthorizedException('Session expired or invalid');

    req.user = {
      userId: claims.sub,
      tenantId: claims.tid,
      sessionId: claims.sid,
      permissions: claims.perms,
    };

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required && required.length > 0) {
      const missing = required.filter((p) => !claims.perms.includes(p));

      if (missing.length > 0) {
        // Name the missing permission. This is an authenticated user who is
        // already inside the tenant boundary, so "you need patient:write" tells
        // them nothing they could not learn by asking an administrator — and it
        // saves a support round trip.
        throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
      }
    }

    /**
     * ANY of these, rather than all. See `RequireAnyPermission` for when that
     * is the honest requirement — the two are read independently, so a route
     * may carry both and mean "all of these, and at least one of those".
     */
    const anyOf = this.reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (anyOf && anyOf.length > 0 && !anyOf.some((p) => claims.perms.includes(p))) {
      throw new ForbiddenException(`Missing permission: one of ${anyOf.join(', ')}`);
    }

    return true;
  }
}

/**
 * Prefers the cookie; falls back to a bearer header.
 *
 * The browser uses an httpOnly cookie, which JavaScript cannot read and so XSS
 * cannot exfiltrate. The bearer path exists for server-to-server callers and
 * tests, which have no cookie jar.
 */
function readToken(req: FastifyRequest): string | null {
  const cookieHeader = req.headers.cookie;

  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === ACCESS_COOKIE) return decodeURIComponent(rest.join('='));
    }
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length);
  }

  return null;
}
