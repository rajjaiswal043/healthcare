import { Module } from '@nestjs/common';
import { PatientsController } from './patients.controller.js';
import { PatientsService } from './patients.service.js';
import { Patient360Service } from './patient-360.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';

@Module({
  controllers: [PatientsController],
  providers: [PatientsService, Patient360Service, AuditService],
})
export class PatientsModule {}
