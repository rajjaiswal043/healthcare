import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { formatUhid } from './uhid-format.js';

export interface FormatChangeMeta {
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

function describeFormat(prefix: string, width: number): string {
  return `${prefix} · ${width} digits (${formatUhid(prefix, width, 1)})`;
}

/**
 * Changing a clinic's patient ID format after patients exist (FR-UID-03).
 *
 * Usually a fortnight in, usually because the format chosen at onboarding was
 * wrong. It is permanent in a way that does not look permanent: every ID
 * already issued stays exactly as printed on its card, file and X-ray envelope,
 * and the clinic has two formats in circulation from then on. That is correct
 * and must not be tidied away.
 *
 * Platform only (decision D3). A clinic that wants it changed has to say so out
 * loud to somebody — which is why a reason is required, and why the change and
 * its record commit in one transaction.
 *
 * What this never does is touch the counter. `platform_set_uhid_format` has no
 * way to: resetting it would issue a second patient whose ID differs from an
 * existing one only by prefix, the one thing the ID exists to prevent.
 */
@Injectable()
export class UhidFormatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async change(
    tenantId: string,
    input: { uhidPrefix: string; uhidPadding: number; reason: string },
    platformUserId: string,
    meta: FormatChangeMeta,
  ) {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { uhidPrefix: true, uhidPadding: true },
    });
    if (!tenant) throw new NotFoundException('Clinic not found');

    // A change that changes nothing would still write a permanent audit row
    // claiming the format was changed. Refused so the record only ever says
    // something that happened.
    if (tenant.uhidPrefix === input.uhidPrefix && tenant.uhidPadding === input.uhidPadding) {
      throw new ConflictException({
        code: 'FORMAT_UNCHANGED',
        message: 'That is already this clinic’s patient ID format.',
      });
    }

    const actor = await this.prisma.client.platformUser.findUnique({
      where: { id: platformUserId },
      select: { email: true },
    });

    return this.prisma.forTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ prefix: string; padding: number; issued: number }>>`
        SELECT prefix, padding, issued::int AS issued
          FROM platform_set_uhid_format(${tenantId}::uuid, ${input.uhidPrefix}::varchar, ${input.uhidPadding}::int)
      `;

      const changed = rows[0];
      if (!changed) {
        throw new Error('platform_set_uhid_format returned nothing — is the migration applied?');
      }

      /**
       * The record (decision D9): the clinic's own audit trail, so the clinic
       * can see who changed its numbering and when, with no new table.
       *
       * The old and new formats are written into the reason alongside the
       * operator's words. `audit_event` has no before/after columns, and a record
       * that says "the format changed" without saying from what is the one
       * question it will be asked. These are formats, not patient data, so the
       * rule against values in the audit log does not reach them.
       */
      const history =
        `was ${describeFormat(tenant.uhidPrefix, tenant.uhidPadding)}, ` +
        `now ${describeFormat(changed.prefix, changed.padding)}`;

      await this.audit.record(tx, tenantId, {
        action: 'tenant.uhid_format_change',
        resourceType: 'Tenant',
        resourceId: tenantId,
        changedFields: ['uhidPrefix', 'uhidPadding'],
        reason: `${input.reason} (${history})`.slice(0, 500),
        // A platform user is not an app_user, so there is no id to put in
        // actor_user_id. The label is the whole of who did it.
        actorLabel: `platform: ${actor?.email ?? platformUserId}`,
        ...meta,
      });

      return {
        uhidPrefix: changed.prefix,
        uhidPadding: changed.padding,
        uhidIssued: changed.issued,
        /** The ID the next registration will receive — numbering carries on. */
        nextUhid: formatUhid(changed.prefix, changed.padding, changed.issued + 1),
      };
    });
  }
}
