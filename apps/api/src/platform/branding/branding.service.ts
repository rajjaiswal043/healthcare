import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BRANDING_STORE, type BrandingStore } from './branding.store.js';
import { normaliseLogo } from './logo-image.js';
import { logoVersionOf } from './logo-version.js';
import { formatUhid } from '../tier/uhid-format.js';

/**
 * What a clinic looks like, to somebody who has not signed in yet.
 *
 * `name` is what the console shows in place of ours; `logoVersion` is null when
 * the clinic has no logo of its own, in which case the web app falls back to the
 * bundled default. Nothing else belongs in this shape — see `resolve()`.
 */
export interface PublicBranding {
  name: string;
  logoVersion: string | null;
}

/**
 * Branding for a clinic that does not exist, or has not chosen one.
 *
 * Deliberately not our product name: under full white-label a clinic never sees
 * "HealthCloud", and this value is what the login page wears before a slug has
 * been typed.
 */
const NEUTRAL_BRANDING: PublicBranding = { name: 'Clinic sign-in', logoVersion: null };

/**
 * The branding a clinic wears.
 *
 * The unusual thing about this service is `resolve()`: it is the only read in
 * the application that runs with no session and no tenant context, because the
 * login page needs a clinic's name and logo BEFORE anyone has authenticated.
 * Everything careful about this file is downstream of that.
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(BRANDING_STORE) private readonly store: BrandingStore,
  ) {}

  /**
   * Resolve a slug to a name and a logo version. Public, unauthenticated.
   *
   * **An unknown slug returns neutral branding, not a 404.** Be honest about
   * what that does and does not buy. It gives every caller one response shape,
   * so the sign-in page has no error path and a status-code scraper learns
   * nothing. It does NOT make a real clinic indistinguishable from an invented
   * one: a caller reading the BODY sees a real clinic's actual name, and no
   * design can hide that while the entire purpose of the endpoint is to display
   * that name. Confirming "this slug is in use" is inherent to white-labelling
   * a login page, and the honest mitigations are the per-IP rate limit and the
   * fact that a slug has to be guessed exactly before it confirms anything.
   *
   * A SUSPENDED clinic still resolves. Suspension is read-only, not lockout
   * (docs/06 section 2.6): its staff still sign in, so they still see their own
   * name over the door.
   *
   * The select list is the other half of the safety here. `tenant` has no
   * row-level security — it is the tenancy root — so this query is not
   * protected by the database, and what keeps it narrow is that it asks for
   * three columns by slug and could not return a fourth if it were asked to.
   */
  async resolve(slug: string): Promise<PublicBranding> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { slug: slug.trim().toLowerCase() },
      select: { name: true, logoUpdatedAt: true, logoMimeType: true },
    });

    if (!tenant) return NEUTRAL_BRANDING;

    return {
      name: tenant.name,
      logoVersion: tenant.logoMimeType ? logoVersionOf(tenant.logoUpdatedAt) : null,
    };
  }

  /**
   * The logo bytes for a slug. Public, unauthenticated.
   *
   * 404s when the clinic has no logo, and that leaks nothing the previous
   * method did not already say — `resolve()` returns `logoVersion: null` for
   * both an unknown clinic and a clinic without a logo, so the two remain
   * indistinguishable at the only place it matters.
   */
  async logoFor(slug: string): Promise<{ bytes: Buffer; mimeType: string; etag: string }> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { slug: slug.trim().toLowerCase() },
      select: { id: true, logoUpdatedAt: true },
    });

    const logo = tenant ? await this.store.get(tenant.id) : null;
    if (!tenant || !logo) throw new NotFoundException('No logo for that clinic.');

    return { ...logo, etag: `"${logoVersionOf(tenant.logoUpdatedAt)}"` };
  }

  /**
   * Replace a clinic's logo.
   *
   * `tenantId` comes from the caller's session or, for the platform tier, from
   * a clinic the platform has just created — never from a request body. See
   * `PostgresBrandingStore.put` for why that sentence is what protects the row
   * rather than RLS.
   */
  async setLogo(
    tenantId: string,
    input: Buffer,
    meta: { actorUserId?: string; ipAddress?: string; userAgent?: string; correlationId?: string },
  ): Promise<{ logoVersion: string; width: number; height: number }> {
    const logo = await normaliseLogo(input);

    await this.store.put(tenantId, logo.bytes, logo.mimeType);

    const updated = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { logoUpdatedAt: true },
    });

    await this.recordBrandingChange(tenantId, 'branding.logo.set', meta);

    return {
      logoVersion: logoVersionOf(updated.logoUpdatedAt),
      width: logo.width,
      height: logo.height,
    };
  }

  async clearLogo(
    tenantId: string,
    meta: { actorUserId?: string; ipAddress?: string; userAgent?: string; correlationId?: string },
  ): Promise<void> {
    await this.store.clear(tenantId);
    await this.recordBrandingChange(tenantId, 'branding.logo.clear', meta);
  }

  /** The clinic's own view of its branding — name included, unlike the public one. */
  async current(tenantId: string): Promise<{ name: string; logoVersion: string | null }> {
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, logoUpdatedAt: true, logoMimeType: true },
    });

    return {
      name: tenant.name,
      logoVersion: tenant.logoMimeType ? logoVersionOf(tenant.logoUpdatedAt) : null,
    };
  }

  /**
   * The clinic's patient ID format, for its own settings screen (FR-UID-02).
   *
   * Read-only by construction: this service has no method that writes the
   * format, and the platform's `platform_set_uhid_format` is the only thing
   * that can.
   *
   * `lastChanged` comes from the clinic's own audit trail, where a format change
   * is recorded (decision D9). It is shown because a clinic renumbered a
   * fortnight in has two formats on its cards, permanently — and this is the
   * screen somebody opens to find out why.
   *
   * WHO changed it is said as "Platform support", not as the operator's email.
   * Under white-label the clinic never sees the platform's staff by name; the
   * email stays in the audit row, where anybody who needs it will look.
   */
  async patientIdFormat(tenantId: string) {
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { uhidPrefix: true, uhidPadding: true, uhidCounter: true },
    });

    const issued = Number(tenant.uhidCounter);

    const change = await this.prisma.forTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { action: 'tenant.uhid_format_change' },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true, actorLabel: true, reason: true },
      }),
    );

    return {
      prefix: tenant.uhidPrefix,
      width: tenant.uhidPadding,
      issued,
      example: formatUhid(tenant.uhidPrefix, tenant.uhidPadding, 1),
      next: formatUhid(tenant.uhidPrefix, tenant.uhidPadding, issued + 1),
      lastChanged: change
        ? {
            at: change.occurredAt,
            by: change.actorLabel?.startsWith('platform:')
              ? 'Platform support'
              : (change.actorLabel ?? 'Unknown'),
            reason: change.reason,
          }
        : null,
    };
  }

  /**
   * Rename the clinic for display.
   *
   * Only `name`. `legalName` is what the clinic is registered as and appears on
   * documents that have to match a registration — changing it is a platform-side
   * operation with a paper trail, not something a settings screen does.
   */
  async rename(
    tenantId: string,
    name: string,
    meta: { actorUserId?: string; ipAddress?: string; userAgent?: string; correlationId?: string },
  ): Promise<{ name: string }> {
    await this.prisma.client
      .$executeRaw`SELECT tenant_set_display_name(${tenantId}::uuid, ${name}::varchar)`;

    await this.recordBrandingChange(tenantId, 'branding.name.set', meta, ['name']);

    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });

    return { name: tenant.name };
  }

  private async recordBrandingChange(
    tenantId: string,
    action: string,
    meta: { actorUserId?: string; ipAddress?: string; userAgent?: string; correlationId?: string },
    changedFields: string[] = ['logoBytes'],
  ): Promise<void> {
    await this.prisma.forTenant(tenantId, async (tx) => {
      await this.audit.record(tx, tenantId, {
        action,
        resourceType: 'Tenant',
        resourceId: tenantId,
        // Field names only, never values — the audit trail must not become a
        // second copy of the thing it is auditing.
        changedFields,
        ...meta,
      });
    });
  }
}
