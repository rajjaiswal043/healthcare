import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  ALL_PERMISSIONS,
  LOCKED_ROLE_KEY,
  PERMISSION_CATALOGUE,
  PERMISSION_CATEGORIES,
  SYSTEM_ROLE_KEYS,
  defaultPermissionsFor,
} from '../auth/permissions.js';

interface RequestMeta {
  actorUserId: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

/**
 * What each role in a clinic is allowed to do.
 *
 * Modelled on the role management in Narveer's CIPCRM at his request: a
 * catalogue of permissions grouped into categories, roles holding a list of
 * them, and an administrator ticking boxes. Three things differ, and each is
 * because of something this system has that CIPCRM does not.
 *
 * **Roles are per clinic.** Every read and write goes through the tenant policy,
 * so one clinic's roles are invisible to another even though they share keys.
 *
 * **The catalogue is code, not data.** CIPCRM seeds permissions into a
 * collection; ours is compiled against by `@RequirePermissions`, so a permission
 * absent from `PERMISSION_CATALOGUE` guards nothing and cannot be granted.
 *
 * **Changing a role signs its holders out.** Permissions live in the signed
 * token, so without this a permission you removed stays usable until that person
 * next happens to log out. See `revokeSessionsForRole`.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The catalogue, grouped the way the screen shows it. */
  catalogue() {
    return {
      categories: PERMISSION_CATEGORIES.map((category) => ({
        category,
        permissions: Object.values(PERMISSION_CATALOGUE).filter((p) => p.category === category),
      })),
    };
  }

  async list(tenantId: string) {
    const roles = await this.prisma.forTenant(tenantId, (tx) =>
      tx.role.findMany({
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          permissions: true,
          isSystem: true,
          requiresMfa: true,
          _count: { select: { users: true } },
        },
      }),
    );

    return {
      roles: roles.map((r) => ({
        ...r,
        /** Editable at all — false only for the administrator. */
        editable: r.key !== LOCKED_ROLE_KEY,
        /** Deletable — a custom role nobody holds. */
        deletable: !SYSTEM_ROLE_KEYS.includes(r.key) && r._count.users === 0,
        /** Has a shipped default to restore. */
        resettable: SYSTEM_ROLE_KEYS.includes(r.key) && r.key !== LOCKED_ROLE_KEY,
        staffCount: r._count.users,
      })),
    };
  }

  async create(
    tenantId: string,
    input: { name: string; description?: string; permissions: string[] },
    meta: RequestMeta,
  ) {
    this.assertPermissionsExist(input.permissions);

    /**
     * The key is derived from the name and then fixed forever.
     *
     * Everything that addresses a role addresses it by key — onboarding, seat
     * limits, three backfill migrations — so a key that can change is a key that
     * silently breaks them.
     */
    const key = slugifyRoleKey(input.name);
    if (!key) throw new BadRequestException('That name has no letters or digits in it.');

    return this.prisma.forTenant(tenantId, async (tx) => {
      const clash = await tx.role.findFirst({ where: { key } });
      if (clash) {
        throw new ConflictException({
          code: 'ROLE_EXISTS',
          message: `There is already a role called “${clash.name}”.`,
        });
      }

      const role = await tx.role.create({
        data: {
          tenantId,
          key,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          permissions: input.permissions,
          isSystem: false,
        },
        select: { id: true, key: true, name: true, permissions: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'role.create',
        resourceType: 'Role',
        resourceId: role.id,
        changedFields: ['name', 'permissions'],
        ...meta,
      });

      return role;
    });
  }

  /**
   * Change a role, and sign out everybody holding it.
   *
   * Returns how many sessions were ended so the screen can say so — an
   * administrator who removes a permission should know they have just
   * interrupted three people, rather than discover it from a complaint.
   */
  async update(
    tenantId: string,
    roleId: string,
    input: { name?: string; description?: string; permissions?: string[] },
    meta: RequestMeta,
  ) {
    if (input.permissions) this.assertPermissionsExist(input.permissions);

    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.role.findUnique({
        where: { id: roleId },
        select: { id: true, key: true, isSystem: true },
      });
      if (!existing) throw new NotFoundException('Role not found');

      this.assertEditable(existing.key);

      // A system role keeps its name as well as its key: clinics recognise
      // "Front desk", and support conversations get much harder when one
      // clinic's Front desk is called something else.
      const renaming = input.name !== undefined && !existing.isSystem;

      const role = await tx.role.update({
        where: { id: roleId },
        data: {
          ...(renaming ? { name: input.name!.trim() } : {}),
          ...(input.description === undefined
            ? {}
            : { description: input.description.trim() || null }),
          ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
        },
        select: { id: true, key: true, name: true, permissions: true },
      });

      const signedOut = await this.revokeSessionsForRole(tx, roleId, meta.actorUserId);

      await this.audit.record(tx, tenantId, {
        action: 'role.update',
        resourceType: 'Role',
        resourceId: roleId,
        changedFields: [
          ...(renaming ? ['name'] : []),
          ...(input.permissions ? ['permissions'] : []),
        ],
        ...meta,
      });

      return { ...role, signedOut };
    });
  }

  /** Put a shipped role back to the permissions it came with. */
  async reset(tenantId: string, roleId: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.role.findUnique({
        where: { id: roleId },
        select: { id: true, key: true },
      });
      if (!existing) throw new NotFoundException('Role not found');

      this.assertEditable(existing.key);

      const defaults = defaultPermissionsFor(existing.key);
      if (!defaults) {
        throw new BadRequestException({
          code: 'NO_DEFAULT',
          message: 'That role was created by this clinic, so it has no default to go back to.',
        });
      }

      const role = await tx.role.update({
        where: { id: roleId },
        data: { permissions: defaults },
        select: { id: true, key: true, name: true, permissions: true },
      });

      const signedOut = await this.revokeSessionsForRole(tx, roleId, meta.actorUserId);

      await this.audit.record(tx, tenantId, {
        action: 'role.reset',
        resourceType: 'Role',
        resourceId: roleId,
        changedFields: ['permissions'],
        ...meta,
      });

      return { ...role, signedOut };
    });
  }

  async remove(tenantId: string, roleId: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.role.findUnique({
        where: { id: roleId },
        select: { id: true, key: true, name: true, _count: { select: { users: true } } },
      });
      if (!existing) throw new NotFoundException('Role not found');

      if (SYSTEM_ROLE_KEYS.includes(existing.key)) {
        throw new ForbiddenException({
          code: 'ROLE_IS_BUILT_IN',
          message: `“${existing.name}” is a built-in role. You can change what it does, but not remove it.`,
        });
      }

      // Deleting a role somebody holds would leave them signed in with
      // permissions from a role that no longer exists, and signed out of an
      // account nobody can put back together.
      if (existing._count.users > 0) {
        throw new ConflictException({
          code: 'ROLE_IN_USE',
          message: `${existing._count.users} member${existing._count.users === 1 ? '' : 's'} of staff still hold “${existing.name}”. Move them to another role first.`,
        });
      }

      await tx.role.delete({ where: { id: roleId } });

      await this.audit.record(tx, tenantId, {
        action: 'role.delete',
        resourceType: 'Role',
        resourceId: roleId,
        changedFields: [],
        ...meta,
      });

      return { id: roleId };
    });
  }

  // --- internals -----------------------------------------------------------

  private assertEditable(key: string): void {
    if (key === LOCKED_ROLE_KEY) {
      throw new ForbiddenException({
        code: 'ROLE_IS_LOCKED',
        message:
          'The Administrator role cannot be changed. It is the way back from every other ' +
          'change on this screen — a clinic that removed the wrong permission from it could ' +
          'not undo that itself.',
      });
    }
  }

  /**
   * Only permissions the code actually enforces.
   *
   * A role holding `patient:delete` would look meaningful on screen and guard
   * nothing, because no route checks for it. Refusing here keeps the roles
   * screen honest about what it can promise.
   */
  private assertPermissionsExist(permissions: string[]): void {
    const unknown = permissions.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p));

    if (unknown.length > 0) {
      throw new BadRequestException({
        code: 'UNKNOWN_PERMISSION',
        message: `Not a permission this system has: ${unknown.join(', ')}.`,
      });
    }
  }

  /**
   * End the sessions of everybody holding this role.
   *
   * Permissions are carried in the signed access token, which is what lets a
   * request be authorised without a database lookup. The cost is that a token
   * keeps saying what it said when it was issued — so a permission removed here
   * would remain usable for hours. Revoking the sessions is what makes the
   * change mean something now.
   *
   * The actor is skipped: an administrator who signs themselves out mid-edit
   * cannot see whether the change worked, and they hold every permission anyway.
   */
  private async revokeSessionsForRole(
    tx: Parameters<Parameters<PrismaService['forTenant']>[1]>[0],
    roleId: string,
    actorUserId: string,
  ): Promise<number> {
    const holders = await tx.userRole.findMany({
      where: { roleId },
      select: { userId: true },
    });

    const userIds = holders.map((h) => h.userId).filter((id) => id !== actorUserId);
    if (userIds.length === 0) return 0;

    const { count } = await tx.session.updateMany({
      where: { userId: { in: userIds }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'role_changed' },
    });

    return count;
  }
}

/**
 * A role name to a stable key: "Ward sister" → `ward_sister`.
 *
 * Prefixed nowhere and never regenerated. Once a role exists its key is the
 * thing seat limits, onboarding and migrations use to find it, so the name can
 * change and the key cannot.
 */
function slugifyRoleKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}
