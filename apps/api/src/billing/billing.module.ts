import { Module } from '@nestjs/common';
import { AuditService } from '../platform/audit/audit.service.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { FinanceReportService } from './finance-report.service.js';
import { ReceiptsService } from './receipts.service.js';
import { PromotionsController } from './promotions.controller.js';
import { PromotionsService } from './promotions.service.js';

/**
 * Exported because scheduling depends on it: booking raises the invoice, and
 * check-in asks it whether the visit may proceed. That is the pay-first rule,
 * and it means billing is a dependency of the queue rather than a screen beside
 * it.
 */
@Module({
  controllers: [BillingController, PromotionsController],
  providers: [
    BillingService,
    FinanceReportService,
    ReceiptsService,
    PromotionsService,
    AuditService,
  ],
  exports: [BillingService],
})
export class BillingModule {}
