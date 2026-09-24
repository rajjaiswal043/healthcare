import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/password.js';

export interface RequestMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
  actorLabel?: string;
}

/**
 * Staff accounts, managed by a clinic's own administrator.
 *
 * Two rules shape this file.
 *
 * **Nobody is ever deleted.** A user's name is on signed consultations, issued
 * receipts and every audit entry they generated, and those have to keep
 * resolving for as long as the records are retained. So the verb is deactivate,
 * and a deactivated user cannot sign in but still renders wherever they are
 * referenced.
 *
 * **A password we generate is temporary by construction.** It is shown once,
 * travels to the person over WhatsApp or across a desk, and is useless for
 * anything but setting a real one — `mustChangePassword` is set, and login
 * refuses to go anywhere else until it is cleared.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Everyone in the clinic, with what they can do and when they were last here. */
  /**
   * Names and ids of active staff, and nothing else.
   *
   * Exists because applying a promotion requires naming the person who
   * authorised it (FR-PRO-02, decision 3), and the finance desk had no way to
   * get a list of people to name: `list()` is behind `user:manage`, which
   * finance deliberately does not hold. Giving finance `user:manage` to fill a
   * dropdown would have handed it the power to create accounts and reset
   * passwords — the exact trade least privilege exists to refuse.
   *
   * SO THE SELECT IS THE SECURITY BOUNDARY, and it is deliberately two columns.
   * No email, no mobile, no roles, no login history, no lockout state. A
   * dropdown needs a name and an id; anything more would be a staff directory
   * handed to a desk that was never meant to have one. If a caller ever needs a
   * third field, that is a decision somebody makes on purpose — not a field
   * quietly added here because it was already loaded.
   *
   * Inactive accounts are excluded rather than flagged: a switched-off member of
   * staff cannot authorise anything, and the apply endpoint refuses them anyway.
   * Offering a name that will be rejected is a worse experience than not
   * offering it.
   */
  async approvers(tenantId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const approvers = await tx.user.findMany({
        where: { isActive: true },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true },
      });

      return { approvers };
    });
  }

  async list(tenantId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const users = await tx.user.findMany({
        orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
        select: {
          id: true,
          email: true,
          fullName: true,
          mobile: true,
          isActive: true,
          mustChangePassword: true,
          lastLoginAt: true,
          lockedUntil: true,
          mfaEnabledAt: true,
          createdAt: true,
          roles: { select: { role: { select: { key: true, name: true } } } },
        },
      });

      return {
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          fullName: u.fullName,
          mobile: u.mobile,
          isActive: u.isActive,
          mustChangePassword: u.mustChangePassword,
          lastLoginAt: u.lastLoginAt,
          /** Null unless a lockout is currently in force — a past one is history. */
          lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil : null,
          mfaEnrolled: u.mfaEnabledAt !== null,
          createdAt: u.createdAt,
          roles: u.roles.map((r) => r.role),
        })),
        seats: await this.seats(tx),
      };
    });
  }

  /**
   * Roles this clinic can assign, and how many seats are left in each.
   *
   * Returned with the user list rather than from its own endpoint: the screen
   * that shows people is the screen that needs to know whether another one can
   * be added, and two round trips to draw one page is two loading states.
   */
  async seats(tx: TenantClient) {
    const [roles, limits, counts] = await Promise.all([
      tx.role.findMany({
        orderBy: { name: 'asc' },
        select: { key: true, name: true, description: true, requiresMfa: true },
      }),
      tx.tenantSeatLimit.findMany({ select: { roleKey: true, maxUsers: true } }),
      tx.userRole.findMany({
        where: { user: { isActive: true } },
        select: { role: { select: { key: true } } },
      }),
    ]);

    const used = new Map<string, number>();
    for (const row of counts) {
      used.set(row.role.key, (used.get(row.role.key) ?? 0) + 1);
    }

    const limitOf = new Map(limits.map((l) => [l.roleKey, l.maxUsers]));

    return roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      requiresMfa: r.requiresMfa,
      used: used.get(r.key) ?? 0,
      /** Null means unlimited — a clinic nobody has priced yet. */
      limit: limitOf.get(r.key) ?? null,
    }));
  }

  /**
   * Add someone to the clinic.
   *
   * Returns the temporary password ONCE. We store a hash, so there is no second
   * chance to read it — the screen has to get it to the person before it is
   * dismissed, and the UI is built around that.
   */
  async create(
    tenantId: string,
    input: { email: string; fullName: string; mobile?: string; roleKeys: string[] },
    meta: RequestMeta,
  ) {
    const email = input.email.trim().toLowerCase();

    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: { id: true, isActive: true },
      });

      if (existing) {
        throw new ConflictException({
          code: 'EMAIL_IN_USE',
          message: existing.isActive
            ? 'Somebody in this clinic already uses that email address.'
            : 'A deactivated account already uses that email address. Reactivate it instead of creating a second one.',
        });
      }

      const roles = await this.rolesByKey(tx, input.roleKeys);
      await this.assertSeatsAvailable(tx, roles);

      const temporaryPassword = generateTemporaryPassword();

      const user = await tx.user.create({
        data: {
          tenantId,
          email,
          fullName: input.fullName.trim(),
          mobile: input.mobile ?? null,
          passwordHash: await hashPassword(temporaryPassword),
          // The point of the whole flow: what we hand over cannot be kept.
          mustChangePassword: true,
          roles: {
            create: roles.map((r) => ({ tenantId, roleId: r.id })),
          },
        },
        select: { id: true, email: true, fullName: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'user.create',
        resourceType: 'User',
        resourceId: user.id,
        changedFields: ['email', 'fullName', 'roles'],
        reason: roles.map((r) => r.key).join(', '),
        ...meta,
      });

      return { ...user, temporaryPassword };
    });
  }

  /** Change who someone is, or which roles they hold. */
  async update(
    tenantId: string,
    id: string,
    input: { fullName?: string; mobile?: string | null; roleKeys?: string[] },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const user = await this.load(tx, id);

      if (input.roleKeys) {
        const roles = await this.rolesByKey(tx, input.roleKeys);

        // Only the roles they are GAINING consume a seat. Re-saving a user
        // without changing their roles must not fail because the clinic is at
        // its limit — they are already counted in it.
        const held = new Set(user.roles.map((r) => r.role.key));
        await this.assertSeatsAvailable(
          tx,
          roles.filter((r) => !held.has(r.key)),
          user.isActive ? 0 : 1,
        );

        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({
          data: roles.map((r) => ({ tenantId, userId: id, roleId: r.id })),
        });
      }

      await tx.user.update({
        where: { id },
        data: {
          ...(input.fullName === undefined ? {} : { fullName: input.fullName.trim() }),
          ...(input.mobile === undefined ? {} : { mobile: input.mobile }),
        },
      });

      await this.audit.record(tx, tenantId, {
        action: 'user.update',
        resourceType: 'User',
        resourceId: id,
        changedFields: Object.keys(input),
        ...meta,
      });

      return this.one(tx, id);
    });
  }

  /**
   * Turn an account off, or back on.
   *
   * Reactivating takes a seat, so it is checked the same way creating one is —
   * otherwise a clinic at its limit could exceed it simply by turning old
   * accounts back on.
   */
  async setActive(tenantId: string, id: string, isActive: boolean, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const user = await this.load(tx, id);

      /**
       * An administrator cannot switch themselves off.
       *
       * Not paternalism: a clinic whose only administrator deactivates their own
       * account has locked itself out of its own administration, and the only
       * way back is us. Cheap guard, expensive omission.
       */
      if (!isActive && id === meta.actorUserId) {
        throw new ForbiddenException({
          code: 'CANNOT_DEACTIVATE_SELF',
          message: 'You cannot deactivate your own account. Ask another administrator.',
        });
      }

      if (isActive && !user.isActive) {
        await this.assertSeatsAvailable(
          tx,
          user.roles.map((r) => ({ id: '', key: r.role.key, name: r.role.name })),
        );
      }

      await tx.user.update({
        where: { id },
        data: {
          isActive,
          // Turning an account off ends its sessions. Leaving them alive means a
          // deactivated user keeps working until their token expires, which is
          // not what anybody means by deactivate.
          ...(isActive ? { failedLoginCount: 0, lockedUntil: null } : {}),
        },
      });

      if (!isActive) {
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      await this.audit.record(tx, tenantId, {
        action: isActive ? 'user.reactivate' : 'user.deactivate',
        resourceType: 'User',
        resourceId: id,
        changedFields: ['isActive'],
        ...meta,
      });

      return this.one(tx, id);
    });
  }

  /**
   * Issue a new temporary password.
   *
   * Also ends every session the user has: whoever asked for this reset may be
   * doing it because the account is compromised, and a reset that leaves the
   * attacker's session alive has achieved nothing.
   */
  async resetPassword(tenantId: string, id: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const user = await this.load(tx, id);
      const temporaryPassword = generateTemporaryPassword();

      await tx.user.update({
        where: { id },
        data: {
          passwordHash: await hashPassword(temporaryPassword),
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });

      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await this.audit.record(tx, tenantId, {
        action: 'user.reset_password',
        resourceType: 'User',
        resourceId: id,
        changedFields: ['passwordHash'],
        ...meta,
      });

      return { id: user.id, fullName: user.fullName, email: user.email, temporaryPassword };
    });
  }

  // --- internals -----------------------------------------------------------

  private async load(tx: TenantClient, id: string) {
    const user = await tx.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        roles: { select: { role: { select: { key: true, name: true } } } },
      },
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async one(tx: TenantClient, id: string) {
    const user = await tx.user.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        mobile: true,
        isActive: true,
        mustChangePassword: true,
        lastLoginAt: true,
        createdAt: true,
        roles: { select: { role: { select: { key: true, name: true } } } },
      },
    });

    return { ...user, roles: user.roles.map((r) => r.role) };
  }

  private async rolesByKey(tx: TenantClient, keys: string[]) {
    const unique = [...new Set(keys)];
    if (unique.length === 0) {
      throw new BadRequestException('Give the user at least one role.');
    }

    const roles = await tx.role.findMany({
      where: { key: { in: unique } },
      select: { id: true, key: true, name: true },
    });

    if (roles.length !== unique.length) {
      const found = new Set(roles.map((r) => r.key));
      throw new BadRequestException(
        `Unknown role: ${unique.filter((k) => !found.has(k)).join(', ')}`,
      );
    }

    return roles;
  }

  /**
   * The seat check.
   *
   * Counts ACTIVE holders of each role and compares with the limit. A missing
   * limit is unlimited, so a clinic nobody has priced is unaffected.
   *
   * The refusal names the way out, because the alternative is a receptionist at
   * 9am on a Monday reading "forbidden" and calling us. Lowering a limit below
   * current usage deactivates nobody — it only blocks the next addition, which
   * is why this is checked on the way in rather than enforced as a constraint.
   */
  private async assertSeatsAvailable(
    tx: TenantClient,
    roles: Array<{ key: string; name: string }>,
    extra = 0,
  ): Promise<void> {
    if (roles.length === 0) return;

    const limits = await tx.tenantSeatLimit.findMany({
      where: { roleKey: { in: roles.map((r) => r.key) } },
      select: { roleKey: true, maxUsers: true },
    });

    if (limits.length === 0) return;

    for (const limit of limits) {
      const role = roles.find((r) => r.key === limit.roleKey);
      if (!role) continue;

      const used = await tx.userRole.count({
        where: { role: { key: limit.roleKey }, user: { isActive: true } },
      });

      if (used + 1 + extra > limit.maxUsers) {
        throw new ConflictException({
          code: 'SEAT_LIMIT_REACHED',
          message:
            limit.maxUsers === 0
              ? `This clinic has no ${role.name.toLowerCase()} seats. Ask doctorsdesk.in to add some.`
              : `All ${limit.maxUsers} ${role.name.toLowerCase()} seats are in use. Deactivate one, or ask doctorsdesk.in to raise the limit.`,
          roleKey: limit.roleKey,
          used,
          limit: limit.maxUsers,
        });
      }
    }
  }
}

/**
 * A temporary password that survives being read aloud down a phone line.
 *
 * No I/l/1/O/0 — this gets dictated, written on paper, and typed by somebody who
 * did not choose it. Four groups of four with dashes for the same reason: a
 * human reading it back needs somewhere to pause.
 *
 * randomInt, not Math.random: it is a credential, however briefly.
 */
const SAFE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateTemporaryPassword(): string {
  const groups: string[] = [];

  for (let g = 0; g < 4; g += 1) {
    let group = '';
    for (let i = 0; i < 4; i += 1) group += SAFE[randomInt(SAFE.length)];
    groups.push(group);
  }

  return groups.join('-');
}
