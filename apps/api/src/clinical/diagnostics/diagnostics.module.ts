import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { DocumentsModule } from '../documents/documents.module.js';

/** Checkpoint 2 of docs/09-diagnostics-plan.md — departments, orders, worklist. */
@Module({
  // For DocumentsService: a result is a clinical document, and there is one
  // upload path with the size cap, the type sniffing and the tenant-scoped key
  // on it. A second one here would be a second place to get that wrong.
  imports: [DocumentsModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService, AuditService],
  exports: [DiagnosticsService],
})
export class DiagnosticsModule {}
