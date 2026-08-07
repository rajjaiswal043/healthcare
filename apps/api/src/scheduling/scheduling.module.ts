import { Module } from '@nestjs/common';
import { SchedulingController } from './scheduling.controller.js';
import { AvailabilityService } from './availability.service.js';
import { AppointmentsService } from './appointments.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { BillingModule } from '../billing/billing.module.js';

// Scheduling depends on billing, not the other way round: booking raises the
// invoice and check-in refuses to issue a token while money is outstanding.
@Module({
  imports: [BillingModule],
  controllers: [SchedulingController],
  providers: [AvailabilityService, AppointmentsService, AuditService],
})
export class SchedulingModule {}
