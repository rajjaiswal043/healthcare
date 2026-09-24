import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { OnboardingService } from './onboarding.service.js';
import { PlatformGuard } from './platform.guard.js';
import { BrandingModule } from '../branding/branding.module.js';
import { AuditService } from '../audit/audit.service.js';
import { UhidFormatService } from './uhid-format.service.js';

/**
 * doctorsdesk.in's own tier.
 *
 * Kept in one module so the answer to "what can the platform do" is one
 * directory listing. Nothing outside it imports these services.
 */
@Module({
  // For BrandingService: the platform sets a clinic's logo at onboarding, so
  // the first sign-in already looks like theirs. Imported rather than
  // reimplemented — one path writes a logo, and it is the one with the
  // re-encode and the size cap on it.
  imports: [BrandingModule],
  controllers: [PlatformController],
  // AuditService because changing a clinic's patient ID format is written into
  // THAT clinic's audit trail (decision D9) — the first platform action that is.
  providers: [
    PlatformAuthService,
    OnboardingService,
    UhidFormatService,
    AuditService,
    PlatformGuard,
  ],
})
export class PlatformModule {}
