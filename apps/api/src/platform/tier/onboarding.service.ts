import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { SYSTEM_ROLES } from '../auth/permissions.js';
import { hashPassword } from '../auth/password.js';
import { generateTemporaryPassword } from '../users/users.service.js';

export interface OnboardInput {
  name: string;
  slug: string;
  timezone?: string;
  uhidPrefix?: string;
  /**
   * How many digits the patient number is padded to. 3–8, enforced by a CHECK
   * on `tenant`. Defaults to 5, which is what every clinic onboarded so far was
   * given. Validated in the DTO (`IsUhidWidth`) before it gets here.
   */
  uhidPadding?: number;
  contactEmail?: string;
  contactMobile?: string;
  /** role key → how many people may hold it. Omit a role for unlimited. */
  seatLimits?: Record<string, number>;
  admin: { email: string; fullName: string };
}

/**
 * Onboarding a clinic.
 *
 * The single place in the system where code crosses a tenant boundary — it
 * creates a tenant and then writes into that tenant's own tables. It does that
 * through `prisma.forTenant(newTenantId, ...)`, one named tenant at a time,
 * rather than through any general-purpose "act as tenant" helper. There is no
 * such helper on purpose: the moment one exists it gets reused somewhere it
 * should not be.
 *
 * What comes out is a clinic that WORKS, not a row. Roles seeded, seat limits
 * applied, one location so the first appointment has somewhere to happen, and an
 * administrator holding a temporary password. A clinic that is created but
 * cannot be signed into is an onboarding that has not finished.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every clinic, with enough to tell a live one from a dormant one. */
  async listClinics() {
    const tenants = await this.prisma.client.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        timezone: true,
        contactEmail: true,
        contactMobile: true,
        suspendedAt: true,
        suspendedReason: true,
        createdAt: true,
        // The format, and how many IDs it has issued — what a platform user
        // needs in front of them before changing it (FR-UID-03).
        uhidPrefix: true,
        uhidPadding: true,
        uhidCounter: true,
      },
    });

    /**
     * Counts, not contents.
     *
     * Through a SECURITY DEFINER function that returns integers by construction,
     * because the ordinary path cannot do this at all: every clinical table is
     * under row-level security, and reading across tenants without context
     * returns zero rows. The alternative — relaxing that so the console could
     * count — would have relaxed it for everything else too.
     */
    const stats = await this.prisma.client.$queryRaw<
      Array<{
        tenant_id: string;
        active_users: bigint;
        patient_count: bigint;
        last_sign_in: Date | null;
      }>
    >`SELECT * FROM platform_clinic_stats()`;

    const byTenant = new Map(stats.map((s) => [s.tenant_id, s]));

    return {
      clinics: tenants.map(({ uhidCounter, ...t }) => {
        const s = byTenant.get(t.id);
        return {
          ...t,
          // Pulled out of the spread: a bigint cannot be serialised to JSON at
          // all, so leaving it in would fail the whole list, not just this field.
          uhidIssued: Number(uhidCounter),
          // bigint over the wire is a string in JSON; the console wants numbers.
          activeUsers: Number(s?.active_users ?? 0),
          patients: Number(s?.patient_count ?? 0),
          lastSignInAt: s?.last_sign_in ?? null,
        };
      }),
    };
  }

  /** Suggest a slug from a clinic name. The caller may edit it before saving. */
  static slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);
  }

  async onboard(input: OnboardInput, platformUserId: string) {
    const slug = input.slug.trim().toLowerCase();

    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      throw new BadRequestException(
        'The clinic address may use lowercase letters, numbers and hyphens only.',
      );
    }

    const clash = await this.prisma.client.tenant.findUnique({ where: { slug } });
    if (clash) {
      throw new ConflictException({
        code: 'SLUG_IN_USE',
        message: `Another clinic already signs in with “${slug}”. Try something more specific.`,
      });
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    /**
     * The tenant row first — everything else needs its id to exist.
     *
     * Through platform_create_tenant rather than an ordinary insert: the
     * application role holds no INSERT on `tenant`, and granting it one would
     * have handed the same power to every clinic-facing screen that shares this
     * connection. The function is the whole of the platform's write access to
     * that table.
     */
    const created = await this.prisma.client.$queryRaw<Array<{ platform_create_tenant: string }>>`
      SELECT platform_create_tenant(
        ${slug}::varchar,
        ${input.name.trim()}::varchar,
        ${input.timezone ?? 'Asia/Kolkata'}::varchar,
        ${(input.uhidPrefix ?? defaultPrefix(input.name)).toUpperCase()}::varchar,
        ${input.uhidPadding ?? 5}::int,
        ${input.contactEmail ?? null}::varchar,
        ${input.contactMobile ?? null}::varchar,
        ${platformUserId}::uuid
      )
    `;

    const tenantId = created[0]?.platform_create_tenant;
    if (!tenantId)
      throw new Error('Clinic creation returned nothing — is the platform migration applied?');

    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      // The width too, so the console can show the format the clinic was given
      // straight after creating it — "your first patient will be DRVIV-0001".
      select: { id: true, slug: true, name: true, uhidPrefix: true, uhidPadding: true },
    });

    await this.prisma.forTenant(tenant.id, async (tx) => {
      // Roles come from the one definition in code. A clinic never invents them.
      const roleIds = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const created = await tx.role.create({
          data: {
            tenantId: tenant.id,
            key: role.key,
            name: role.name,
            description: role.description,
            permissions: role.permissions,
            isSystem: true,
            requiresMfa: role.requiresMfa,
          },
          select: { id: true },
        });
        roleIds.set(role.key, created.id);
      }

      // Seat limits, if the deal has any. Through the function for the same
      // reason as the tenant row: the clinic keeps SELECT on this table and
      // nothing else, or it could raise its own limit.
      for (const [roleKey, maxUsers] of Object.entries(input.seatLimits ?? {})) {
        if (!roleIds.has(roleKey)) {
          throw new BadRequestException(`Unknown role in seat limits: ${roleKey}`);
        }
        // $executeRaw, not $queryRaw: these functions return void, and Prisma
        // cannot deserialise a void column.
        await tx.$executeRaw`
          SELECT platform_set_seat_limit(${tenant.id}::uuid, ${roleKey}::varchar, ${maxUsers}::int)
        `;
      }

      /**
       * One location, named after the clinic.
       *
       * Not decoration: booking an appointment requires a location id, so a
       * clinic without one cannot take its first patient. A single-site clinic
       * should never have to visit a settings screen before it can work.
       */
      await tx.location.create({
        data: { tenantId: tenant.id, name: tenant.name },
      });

      const adminRoleId = roleIds.get('administrator');
      if (!adminRoleId) throw new Error('administrator role missing from SYSTEM_ROLES');

      await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.admin.email.trim().toLowerCase(),
          fullName: input.admin.fullName.trim(),
          passwordHash,
          // Handed over on WhatsApp or across a desk. Temporary by construction.
          mustChangePassword: true,
          roles: { create: [{ tenantId: tenant.id, roleId: adminRoleId }] },
        },
      });
    });

    return {
      clinic: tenant,
      admin: { email: input.admin.email.trim().toLowerCase(), temporaryPassword },
    };
  }

  /**
   * Suspend a clinic, or bring it back.
   *
   * Suspension is READ-ONLY, not lockout: staff keep signing in, keep reading
   * their patients, keep printing and exporting — and cannot write. The clinic
   * is the data fiduciary for those records and is obliged to produce them, so a
   * switch of ours that puts them out of reach makes us the reason they cannot.
   */
  async setSuspended(tenantId: string, suspended: boolean, reason: string | null) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Clinic not found');

    if (suspended && !reason?.trim()) {
      throw new BadRequestException(
        'Say why. A suspension nobody can explain is one nobody can undo.',
      );
    }

    await this.prisma.client.$executeRaw`
      SELECT platform_set_tenant_status(
        ${tenantId}::uuid,
        ${suspended ? 'SUSPENDED' : 'ACTIVE'}::varchar,
        ${suspended ? reason : null}::varchar
      )
    `;

    return this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, status: true, suspendedReason: true },
    });
  }

  /** Change what a clinic is allowed, after the fact. */
  async setSeatLimits(tenantId: string, seatLimits: Record<string, number>) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Clinic not found');

    return this.prisma.forTenant(tenantId, async (tx) => {
      for (const [roleKey, maxUsers] of Object.entries(seatLimits)) {
        const role = await tx.role.findFirst({ where: { key: roleKey }, select: { id: true } });
        if (!role) throw new BadRequestException(`Unknown role: ${roleKey}`);

        await tx.$executeRaw`
          SELECT platform_set_seat_limit(${tenantId}::uuid, ${roleKey}::varchar, ${maxUsers}::int)
        `;
      }

      /**
       * Nobody is deactivated by this, whatever the new numbers say.
       *
       * Lowering a limit below current usage blocks the NEXT addition and
       * nothing else. Software that logs a working doctor out because a plan
       * changed is software a clinic stops trusting — and it would be us doing
       * it, silently, from another building.
       */
      return tx.tenantSeatLimit.findMany({ select: { roleKey: true, maxUsers: true } });
    });
  }
}

/** "Sunrise Clinic" → "SUN". Editable at onboarding; this is only the suggestion. */
function defaultPrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, '');
  return (letters.slice(0, 3) || 'HC').toUpperCase();
}
