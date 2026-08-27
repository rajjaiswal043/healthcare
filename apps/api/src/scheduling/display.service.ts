import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../platform/database/prisma.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { AppointmentsService, type RequestMeta } from './appointments.service.js';
import { generateDisplayKey, hashDisplayKey, tenantIdFromDisplayKey } from './display-key.js';
import { logoVersionOf } from '../platform/branding/logo-version.js';
import { publicPatientName } from './public-name.js';

/**
 * The waiting-room screen.
 *
 * One rule governs this whole file: **the board never carries a name a stranger
 * could act on.**
 *
 * Until 26 Aug 2026 that rule was absolute — tokens only. Narveer asked for
 * names, because a patient who cannot match themselves to a number gets missed,
 * and a receptionist ends up calling out the full name anyway. The rule was
 * narrowed rather than abandoned: the board carries "Kavita S." and never
 * "Kavita Sharma", masked in `publicPatientName` before the response is built.
 *
 * A screen on a waiting-room wall is a disclosure to everybody in that room.
 * "Kavita Sharma — Dr Nair, Dermatology, 11:15" tells a room full of strangers
 * who is being treated for what, by whom. Under the DPDP Act that is personal
 * data processed beyond the purpose it was collected for, and in a small clinic
 * where people know each other it is simply bad manners. A first name and an
 * initial are recognisable to their owner and close to useless to anybody else,
 * which is the trade this makes.
 *
 * What has NOT changed: the masking happens here, not on the television. A
 * payload that carries a full name to a public screen has already leaked it,
 * whatever the screen chooses to paint — so `board()` builds the shortened form
 * and the surname never leaves this process. The integration test asserts the
 * surname is absent from the RESPONSE, not from the markup.
 */
@Injectable()
export class DisplayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly appointments: AppointmentsService,
  ) {}

  /**
   * Pair a screen, returning its key ONCE.
   *
   * The plaintext is never stored and cannot be shown again — a screen that
   * loses its key gets a new one rather than a recovered one, which is the only
   * honest thing a hash lets us offer.
   */
  async pair(
    tenantId: string,
    input: { name: string; locationId?: string; practitionerIds?: string[] },
    meta: RequestMeta,
  ) {
    const key = generateDisplayKey(tenantId);

    return this.prisma.forTenant(tenantId, async (tx) => {
      const device = await tx.displayDevice.create({
        data: {
          tenantId,
          name: input.name,
          locationId: input.locationId ?? null,
          practitionerIds: input.practitionerIds ?? [],
          accessKeyHash: hashDisplayKey(key),
          createdByUserId: meta.actorUserId ?? null,
        },
        select: { id: true, name: true, createdAt: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'display.pair',
        resourceType: 'DisplayDevice',
        resourceId: device.id,
        changedFields: ['accessKeyHash'],
        ...meta,
      });

      return { ...device, accessKey: key };
    });
  }

  async list(tenantId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const devices = await tx.displayDevice.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          isActive: true,
          lastSeenAt: true,
          revokedAt: true,
          createdAt: true,
          practitionerIds: true,
          location: { select: { id: true, name: true } },
        },
      });

      // No key, not even a hash: an administrator listing screens has no use for
      // one, and a hash on a screen is a hash in a screenshot.
      return { devices };
    });
  }

  /** Turn a screen off. The row stays, so "when did it stop" has an answer. */
  async revoke(tenantId: string, id: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const device = await tx.displayDevice.findUnique({ where: { id }, select: { id: true } });
      if (!device) throw new NotFoundException('Screen not found');

      await tx.displayDevice.update({
        where: { id },
        data: { isActive: false, revokedAt: new Date() },
      });

      await this.audit.record(tx, tenantId, {
        action: 'display.revoke',
        resourceType: 'DisplayDevice',
        resourceId: id,
        changedFields: ['isActive', 'revokedAt'],
        ...meta,
      });

      return { id, isActive: false };
    });
  }

  /**
   * What the screen paints. No session — the key is the credential.
   *
   * Every failure here returns the same 401. A screen with a mistyped key and a
   * screen whose clinic was archived are indistinguishable to whoever is holding
   * the key, which is the point: this endpoint is reachable from the open
   * internet by anyone who can guess a URL.
   */
  async board(key: string) {
    const tenantId = tenantIdFromDisplayKey(key);
    if (!tenantId) throw new UnauthorizedException('Unknown screen');

    const keyHash = hashDisplayKey(key);

    const context = await this.prisma.forTenant(tenantId, async (tx) => {
      const device = await tx.displayDevice.findUnique({
        where: { accessKeyHash: keyHash },
        select: {
          id: true,
          isActive: true,
          locationId: true,
          practitionerIds: true,
          location: { select: { name: true } },
        },
      });

      if (!device || !device.isActive) return null;

      // Last seen, so an administrator can tell a dead screen from an idle one.
      // Written on every poll: it is one indexed update every five seconds per
      // screen, and a clinic has one or two.
      await tx.displayDevice.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      });

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        // slug and logo so the television wears the clinic's own mark. Still
        // nothing here that could carry a patient name.
        select: { name: true, timezone: true, slug: true, logoMimeType: true, logoUpdatedAt: true },
      });

      const practitioners = await tx.practitioner.findMany({
        where: {
          isActive: true,
          ...(device.practitionerIds.length > 0 ? { id: { in: device.practitionerIds } } : {}),
        },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true, prefix: true, specialty: true },
      });

      return { device, tenant, practitioners };
    });

    if (!context) throw new UnauthorizedException('Unknown screen');

    const { device, tenant, practitioners } = context;
    return this.paint(tenantId, device, tenant, practitioners);
  }

  // --- internals -----------------------------------------------------------

  /**
   * One queue read per doctor, reusing the staff board's own query.
   *
   * Sharing it is the point: the screen must show the order the clinic is
   * actually working to, and a second implementation of "who is next" would
   * disagree with the first the day one of them changed.
   */
  private async paint(
    tenantId: string,
    device: { locationId: string | null; location: { name: string } | null },
    tenant: {
      name: string;
      timezone: string;
      slug: string;
      logoMimeType: string | null;
      logoUpdatedAt: Date | null;
    },
    practitioners: Array<{
      id: string;
      fullName: string;
      prefix: string | null;
      specialty: string | null;
    }>,
  ) {
    const now = Date.now();

    const doctors = [];
    for (const p of practitioners) {
      const queue = await this.appointments.queue(tenantId, p.id);

      const lastCalledAt = queue.nowServing?.calledAt ?? null;

      doctors.push({
        // The name as the clinic typed it. `prefix` was folded into
        // full_name on 26 Aug 2026 and is no longer read — composing it here
        // gave "Dr Dr. Vivek Swarnkar" for any clinic that typed the honorific.
        name: p.fullName,
        specialty: p.specialty,
        /** The number being called. Null when the room is empty. */
        nowServing: queue.nowServing?.tokenNumber ?? null,
        /**
         * Who that number belongs to, shortened to "Kavita S.".
         *
         * Masked in `publicPatientName` before it reaches this object, so the
         * surname is never in the response at all. See that file for why the
         * masking cannot live in the television's markup.
         */
        nowServingName: queue.nowServing ? publicPatientName(queue.nowServing.patient.name) : null,
        /**
         * The next few, in the order the clinic will actually call them —
         * priority first, then readiness. Three, because a waiting room reads a
         * screen at a glance and a fourth number is one nobody acts on.
         */
        next: queue.waiting.slice(0, 3).map((a) => ({
          token: a.tokenNumber,
          name: publicPatientName(a.patient.name),
        })),
        waiting: queue.waiting.length,
        /**
         * Minutes since the last patient was called in, or null if none has
         * been. The screen decides what counts as late — deriving it here means
         * nobody has to remember to set a "delayed" flag, and a flag nobody
         * updates is a screen that lies to a waiting room.
         */
        minutesSinceLastCall:
          lastCalledAt === null ? null : Math.floor((now - lastCalledAt.getTime()) / 60000),
      });
    }

    return {
      clinic: tenant.name,
      /** The clinic's own mark, for a screen a waiting room looks at all day. */
      clinicSlug: tenant.slug,
      clinicLogoVersion: tenant.logoMimeType ? logoVersionOf(tenant.logoUpdatedAt) : null,
      location: device.location?.name ?? null,
      timezone: tenant.timezone,
      /** For the screen's own "showing data from…" line when the network drops. */
      generatedAt: new Date().toISOString(),
      doctors,
    };
  }
}
