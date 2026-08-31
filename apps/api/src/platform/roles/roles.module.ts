import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { AuditService } from '../audit/audit.service.js';

/** Role and permission management for a clinic administrator. */
@Module({
  controllers: [RolesController],
  providers: [RolesService, AuditService],
})
export class RolesModule {}
