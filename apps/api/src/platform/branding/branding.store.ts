import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Where a clinic's logo is kept.
 *
 * This interface exists for one reason: the bytes are in Postgres today, and
 * they will not be forever. Logos are one row per tenant, half a megabyte at
 * most, written almost never and served from HTTP cache almost always — which
 * makes a bucket, an IAM role and a second store to keep consistent with the
 * backup a poor trade at this phase. Patient documents will not be any of those
 * things, and the day they arrive there will be a real object store; on that
 * day this becomes `S3BrandingStore` and the call sites do not move.
 *
 * Keep it this narrow. The moment it grows a `list()` or a `getByTenantSlug()`
 * it stops being a storage seam and starts being a second branding service.
 */
export interface BrandingStore {
  put(tenantId: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(tenantId: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
  clear(tenantId: string): Promise<void>;
}

export const BRANDING_STORE = Symbol('BRANDING_STORE');

@Injectable()
export class PostgresBrandingStore implements BrandingStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Through a SECURITY DEFINER function, not a plain UPDATE.
   *
   * `healthcloud_app` may only SELECT from `tenant` — set in the very first
   * migration, and the same reason the platform tier writes tenant rows through
   * named functions rather than a table grant. Writing a tenant row is not
   * something the clinic-facing application should be able to do by accident.
   *
   * This was originally a `prisma.client.tenant.update(...)`, which worked
   * locally because the development database had drifted into holding INSERT,
   * UPDATE and DELETE that no migration grants. The integration suite, running
   * against a database built only from migrations, refused it with 42501.
   * 20260826130000_tenant_branding_writes adds these functions and revokes the
   * privileges that were never meant to be there.
   *
   * `$executeRaw` rather than `$queryRaw`: Prisma cannot deserialise a
   * PostgreSQL `void`, and the same trap has been hit before with the platform
   * functions. `tenant_set_logo` returns a timestamp, but the caller does not
   * need it — `BrandingService` reads the stored value back so there is one
   * source of truth for the version hash.
   */
  async put(tenantId: string, bytes: Buffer, mimeType: string): Promise<void> {
    await this.prisma.client.$executeRaw`
      SELECT tenant_set_logo(${tenantId}::uuid, ${bytes}::bytea, ${mimeType}::varchar)`;
  }

  async get(tenantId: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const row = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { logoBytes: true, logoMimeType: true },
    });

    // Both or neither — the database has a CHECK saying so, and this narrows
    // the pair for TypeScript at the same time.
    if (!row?.logoBytes || !row.logoMimeType) return null;

    return { bytes: Buffer.from(row.logoBytes), mimeType: row.logoMimeType };
  }

  async clear(tenantId: string): Promise<void> {
    await this.prisma.client.$executeRaw`SELECT tenant_clear_logo(${tenantId}::uuid)`;
  }
}
