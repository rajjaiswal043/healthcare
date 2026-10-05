import { Module } from '@nestjs/common';
import { AuditService } from '../platform/audit/audit.service.js';
import { PublicRateLimitGuard } from '../common/public-rate-limit.guard.js';
import { EngagementController, PatientLinkController } from './engagement.controller.js';
import { EngagementService } from './engagement.service.js';
import { EngagementScheduler } from './engagement.scheduler.js';
import { FollowUpsService } from './follow-ups.service.js';
import { PatientLinkService } from './patient-link.service.js';
import { ConsoleMessageChannel, MESSAGE_CHANNEL } from './message-channel.js';

/**
 * The patient's journey outside the building — docs/10.
 *
 * Depends on nothing clinical. Scheduling and consultations import THIS module
 * to announce what happened (a booking, a queue that moved); this module never
 * imports theirs, so there is no cycle and no second implementation of the
 * queue — it reads the same table in the same order (queue-day.ts).
 */
@Module({
  controllers: [EngagementController, PatientLinkController],
  providers: [
    EngagementService,
    FollowUpsService,
    PatientLinkService,
    EngagementScheduler,
    AuditService,
    PublicRateLimitGuard,
    { provide: MESSAGE_CHANNEL, useClass: ConsoleMessageChannel },
  ],
  exports: [EngagementService],
})
export class EngagementModule {}
