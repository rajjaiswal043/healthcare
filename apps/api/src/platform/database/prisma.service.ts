import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  createPrismaClient,
  withTenant,
  type PrismaClient,
  type TenantClient,
} from '@healthcloud/db';

/**
 * The application's database access point.
 *
 * Connects as `healthcloud_app`, so every query runs under row-level security.
 *
 * Note what is deliberately NOT exposed: a way to run a tenant-scoped query
 * without tenant context. Callers go through `forTenant`, which opens a
 * transaction and sets `app.tenant_id` on it. Anything that skips it hits the
 * policies with a NULL tenant and gets zero rows — visibly wrong rather than
 * quietly over-permissive.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor() {
    this.client = createPrismaClient();
  }

  async onModuleInit(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /**
   * Run `fn` against the database with tenant context applied.
   *
   * @param tenantId MUST come from the authenticated session. Never from a
   *                 request body, query parameter or header — that would let a
   *                 caller choose which tenant's data to operate on, which is
   *                 the whole thing RLS is here to prevent.
   */
  forTenant<T>(tenantId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return withTenant(this.client, tenantId, fn);
  }
}
