import { Module } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service.js';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { ConsultationsController } from './consultations.controller.js';
import { ConsultationsService } from './consultations.service.js';

@Module({
  // Opening and signing move the queue; engagement decides who to tell.
  imports: [EngagementModule],
  controllers: [ConsultationsController],
  providers: [ConsultationsService, AuditService],
  exports: [ConsultationsService],
})
export class ConsultationsModule {}
