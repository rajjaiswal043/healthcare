import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { AuditService } from '../audit/audit.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AuditService],
})
export class UsersModule {}
