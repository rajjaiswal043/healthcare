import { Module } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ConsultationsController } from './consultations.controller.js';
import { ConsultationsService } from './consultations.service.js';

@Module({
  controllers: [ConsultationsController],
  providers: [ConsultationsService, AuditService],
  exports: [ConsultationsService],
})
export class ConsultationsModule {}
