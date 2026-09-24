import { SetMetadata, createParamDecorator, InternalServerErrorException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Permission } from './permissions.js';

export const PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_PERMISSIONS_KEY = 'requiredAnyPermission';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is the DEFAULT — opting out is explicit and greppable. The
 * inverse (opt-in auth) means a forgotten decorator silently exposes patient
 * data, which is not a failure mode worth having.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Requires ALL listed permissions. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Requires ANY ONE of the listed permissions.
 *
 * For a route two different jobs legitimately reach by different routes. The
 * priced test catalogue is the case it was added for: a doctor reaches it
 * through `diagnostic:order` while choosing a test in a consultation, and the
 * finance desk through `diagnostic:order:walkin` while selling one at the
 * counter. Neither role should be given the other's permission to get there —
 * that was the whole point of splitting them.
 *
 * Use it sparingly. `RequirePermissions` says one clear thing, and a route
 * that needs an OR is usually a route doing two jobs. This one is not: it
 * answers exactly one question — what can be ordered, and for how much.
 */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  sessionId: string;
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/** The authenticated user. Throws if the route is not behind the auth guard. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();

  if (!req.user) {
    throw new InternalServerErrorException(
      'No authenticated user on this request. Is the route marked @Public() by mistake?',
    );
  }

  return req.user;
});

/**
 * The current tenant id, taken from the authenticated session.
 *
 * Note what changed: this used to come from a request header. It now comes from
 * the session and nothing else, so a caller can no longer name the tenant it
 * wants to act on.
 */
export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();

  if (!req.user?.tenantId) {
    throw new InternalServerErrorException(
      'No tenant on this request — route is not authenticated.',
    );
  }

  return req.user.tenantId;
});
