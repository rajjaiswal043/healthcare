import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../database/prisma.service.js';

/**
 * A suspended clinic is read-only, not locked out.
 *
 * Narveer's decision, 17 Aug 2026: staff keep signing in, keep reading their
 * patients, keep printing and exporting — they simply cannot write. The clinic
 * is the data fiduciary for those records and is obliged to produce them, so a
 * switch of ours that puts them out of reach makes us the reason they cannot.
 *
 * This guard exists for the SENTENCE. It refuses a mutating request with
 * something a receptionist can act on. What makes the promise actually true is
 * the read-only transaction underneath it — a route added next month and never
 * added to any list still cannot write, because the database will not let it.
 *
 * Enumerating mutating routes would go stale the first Friday somebody was in a
 * hurry. Enumerating the METHODS does not: there is no way to add a fifth
 * mutating HTTP verb to this API without noticing.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * What stays open while suspended.
 *
 * Signing in, signing out, and changing your own password. Locking somebody out
 * of a password change during a billing dispute has no upside for anyone.
 */
const ALWAYS_ALLOWED = [
  '/auth/login',
  '/auth/logout',
  '/auth/refresh',
  '/auth/mfa/confirm',
  '/auth/password',
  '/platform/',
  /**
   * Recording that a receipt was printed.
   *
   * A POST, so the method rule would refuse it — and the sentence this guard
   * returns says "you can still open, print and export everything already
   * here". A suspended clinic that cannot reprint a receipt for money it already
   * took makes that promise untrue, and leaves a patient unable to prove they
   * paid. Nothing new is recorded about the money; the log says a sheet came out
   * of a printer.
   */
  '/receipt/prints',
];

@Injectable()
export class SuspensionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: { tenantId: string } }>();

    if (!MUTATING.has(req.method)) return true;

    const url = req.url ?? '';
    if (ALWAYS_ALLOWED.some((path) => url.includes(path))) return true;

    const tenantId = req.user?.tenantId;
    // No session yet — the auth guard will deal with it. Nothing to check here.
    if (!tenantId) return true;

    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, suspendedReason: true },
    });

    if (tenant?.status !== 'SUSPENDED') return true;

    throw new ForbiddenException({
      code: 'CLINIC_SUSPENDED',
      message:
        'This clinic is suspended, so nothing new can be recorded. You can still open, print and export everything already here. Contact doctorsdesk.in to restore it.',
      reason: tenant.suspendedReason,
    });
  }
}
