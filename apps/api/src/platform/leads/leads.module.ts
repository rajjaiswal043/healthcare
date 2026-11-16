import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller.js';
import { LeadsService } from './leads.service.js';
import { PublicRateLimitGuard } from '../../common/public-rate-limit.guard.js';

/**
 * Demo and website requests from the marketing page, emailed to the company
 * inbox (LEADS_EMAIL_TO). Nothing is stored: the email is the record.
 */
@Module({
  controllers: [LeadsController],
  providers: [LeadsService, PublicRateLimitGuard],
})
export class LeadsModule {}
