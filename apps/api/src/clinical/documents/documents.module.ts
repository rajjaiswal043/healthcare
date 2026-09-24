import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import {
  CLINICAL_DOCUMENT_STORE,
  InMemoryClinicalDocumentStore,
  S3ClinicalDocumentStore,
} from './document-store.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { loadEnv } from '../../config/env.js';

/**
 * Clinical documents — checkpoint 1 of docs/09-diagnostics-plan.md.
 *
 * The store is bound here and nowhere else, which is what lets the integration
 * suite swap in the in-memory implementation with `overrideProvider`. Tests that
 * needed AWS credentials would be tests nobody runs.
 */
@Module({
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    AuditService,
    {
      provide: CLINICAL_DOCUMENT_STORE,
      // Chosen by CLINICAL_STORAGE_DRIVER, which refuses to be `memory` in
      // production. See the note on it in config/env.ts.
      useFactory: () =>
        loadEnv().CLINICAL_STORAGE_DRIVER === 'memory'
          ? new InMemoryClinicalDocumentStore()
          : new S3ClinicalDocumentStore(),
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
