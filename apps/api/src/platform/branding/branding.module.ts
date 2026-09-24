import { Module } from '@nestjs/common';
import { BrandingController } from './branding.controller.js';
import { BrandingService } from './branding.service.js';
import { BRANDING_STORE, PostgresBrandingStore } from './branding.store.js';
import { PublicRateLimitGuard } from '../../common/public-rate-limit.guard.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * White-label branding: a clinic's own name and logo, everywhere ours used to
 * be. See docs/07-white-label-branding-plan.md.
 *
 * The rate-limit guard is provided here rather than globally on purpose. It
 * holds per-IP counters in memory, and the routes that need it are the two
 * public ones — putting it in front of the clinic console would throttle a busy
 * front desk for no benefit.
 */
@Module({
  controllers: [BrandingController],
  providers: [
    BrandingService,
    AuditService,
    PublicRateLimitGuard,
    { provide: BRANDING_STORE, useClass: PostgresBrandingStore },
  ],
  exports: [BrandingService],
})
export class BrandingModule {}
