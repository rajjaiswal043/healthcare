import { Module } from '@nestjs/common';
import { AuditService } from '../platform/audit/audit.service.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

/**
 * Exported because scheduling depends on it: booking raises the invoice, and
 * check-in asks it whether the visit may proceed. That is the pay-first rule,
 * and it means billing is a dependency of the queue rather than a screen beside
 * it.
 */
@Module({
  controllers: [BillingController],
  providers: [BillingService, AuditService],
  exports: [BillingService],
})
export class BillingModule {}
