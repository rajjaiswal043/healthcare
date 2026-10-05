import { Module } from '@nestjs/common';
import { SchedulingController } from './scheduling.controller.js';
import { DisplayController } from './display.controller.js';
import { ClinicSetupController } from './setup/clinic-setup.controller.js';
import { ClinicSetupService } from './setup/clinic-setup.service.js';
import { AvailabilityService } from './availability.service.js';
import { AppointmentsService } from './appointments.service.js';
import { DisplayService } from './display.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';

// Scheduling depends on billing, not the other way round: booking raises the
// invoice and check-in refuses a place in the queue while money is outstanding.
//
// The waiting-room display lives here rather than in a module of its own: it is
// a second reader of the same queue, and the whole point is that it reads the
// clinic's real order rather than a parallel implementation of it.
@Module({
  // Engagement is told what happened (a booking, a queue that moved) and
  // decides what, if anything, the patient hears. It never reaches back in.
  imports: [BillingModule, EngagementModule],
  controllers: [SchedulingController, DisplayController, ClinicSetupController],
  providers: [
    AvailabilityService,
    AppointmentsService,
    DisplayService,
    ClinicSetupService,
    AuditService,
  ],
})
export class SchedulingModule {}
