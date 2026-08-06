import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuditService } from '../audit/audit.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuditService],
  exports: [AuthService],
})
export class AuthModule {}
