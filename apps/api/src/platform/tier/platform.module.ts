import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { OnboardingService } from './onboarding.service.js';
import { PlatformGuard } from './platform.guard.js';

/**
 * doctorsdesk.in's own tier.
 *
 * Kept in one module so the answer to "what can the platform do" is one
 * directory listing. Nothing outside it imports these services.
 */
@Module({
  controllers: [PlatformController],
  providers: [PlatformAuthService, OnboardingService, PlatformGuard],
})
export class PlatformModule {}
