import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/password.js';
import { generateTemporaryPassword } from '../users/users.service.js';

interface PlatformMeta {
  platformUserId: string;
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Unlocking a clinic that has locked itself out.
 *
 * The case, found on 13 Oct 2026: a clinic administrator forgets their password
 * and is the only account there holding `user:manage`. Nobody can help them —
 * there is no self-service reset, nothing in this system sends email, and until
 * now the platform console had no user management at all. The only route was
 * editing `app_user.password_hash` by hand.
 *
 * **Administrators only**, and the rule lives in the database function rather
 * than here. A rule the API enforces is a rule one new endpoint can forget; a
 * rule the function enforces is one every caller meets. See the
 * 20261013090000_platform_reset_clinic_password migration for why that matters
 * more than usual — a platform operator who could reset any clinic account
 * could take over a named DOCTOR, and that doctor's name prints on signed
 * prescriptions.
 *
 * **The clinic sees it happen.** The audit entry is written into the CLINIC's
 * own log, not a platform-side one, so an administrator with `audit:read` can
 * see that we reset an account and when. A platform operator reaching into a
 * clinic's accounts invisibly is a backdoor into every patient record they
 * hold; making it visible costs nothing and is the difference between a support
 * tool and one.
 */
@Injectable()
export class ClinicPasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Who at this clinic the platform may reset — administrators and owners. */
  async administrators(tenantId: string) {
    await this.assertClinicExists(tenantId);

    const rows = await this.prisma.client.$queryRaw<
      Array<{ user_id: string; email: string; full_name: string }>
    >`SELECT * FROM platform_clinic_administrators(${tenantId}::uuid)`;

    return {
      administrators: rows.map((r) => ({
        id: r.user_id,
        email: r.email,
        fullName: r.full_name,
      })),
    };
  }

  /**
   * A new temporary password for one clinic administrator, shown once.
   *
   * Generated and hashed HERE, exactly as the clinic's own reset does, so there
   * is one idea of what a temporary password is and one place that decides how
   * it is hashed. The database function is handed a finished hash.
   */
  async reset(tenantId: string, userId: string, meta: PlatformMeta) {
    await this.assertClinicExists(tenantId);

    // Who is doing this, by name, for the clinic's audit entry. Looked up here
    // rather than carried on the request: `PlatformActor` holds ids only, and a
    // label is worth one query on an operation this rare.
    const operator = await this.prisma.client.platformUser.findUnique({
      where: { id: meta.platformUserId },
      select: { fullName: true, email: true },
    });

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    const rows = await this.prisma.client.$queryRaw<
      Array<{ user_id: string; email: string; full_name: string }>
    >`
        SELECT * FROM platform_reset_clinic_password(
          ${tenantId}::uuid, ${userId}::uuid, ${passwordHash}::varchar
        )`.catch((err: unknown) => {
      // The function raises when the target is not an active account holding
      // `user:manage`. Translated here into something the console can show,
      // rather than a 500 with a Postgres message in it.
      if (String(err).includes('NOT_A_CLINIC_ADMINISTRATOR')) {
        throw new BadRequestException({
          code: 'NOT_A_CLINIC_ADMINISTRATOR',
          message:
            'The platform can only reset an account that manages users at this clinic. ' +
            'Anyone else should be reset by their own administrator.',
        });
      }
      throw err;
    });

    const user = rows[0];
    if (!user) throw new NotFoundException('That account is not at this clinic.');

    /**
     * Written into the CLINIC's audit log.
     *
     * `forTenant` rather than the platform's own trail, so the clinic can see
     * that we did this. The actor is recorded as the platform operator by name
     * — `actorUserId` stays null because they have no `app_user` row, and
     * inventing one would put a person in the clinic's staff list who is not
     * their staff.
     */
    await this.prisma.forTenant(tenantId, async (tx) => {
      await this.audit.record(tx, tenantId, {
        action: 'user.reset_password.platform',
        resourceType: 'User',
        resourceId: user.user_id,
        changedFields: ['passwordHash'],
        actorLabel: `Platform support · ${operator?.fullName ?? operator?.email ?? 'unknown'}`,
        ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
        ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
        ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
      });
    });

    return {
      id: user.user_id,
      email: user.email,
      fullName: user.full_name,
      temporaryPassword,
    };
  }

  private async assertClinicExists(tenantId: string): Promise<void> {
    const clinic = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!clinic) throw new NotFoundException('Clinic not found');
  }
}
