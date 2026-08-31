import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import {
  CLINICAL_DOCUMENT_STORE,
  SIGNED_URL_TTL_SECONDS,
  safeFileName,
  tenantPrefix,
  type ClinicalDocumentStore,
} from './document-store.js';
import { detectFileType } from './file-type.js';

/** 25MB. An X-ray export or a scanned report; not a DICOM study. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

interface RequestMeta {
  actorUserId: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

export interface DocumentView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  uploadedBy: { id: string; fullName: string };
}

/**
 * Clinical files against a patient.
 *
 * The one thing to hold in mind reading this: **the bucket is outside row-level
 * security.** Every other read in this system is protected by the database.
 * Here, Postgres protects the ROW and this service protects the BYTES, by never
 * letting a caller name an object key.
 *
 * So there is no method taking a key. `signedUrlFor` takes a document id, reads
 * the row inside the tenant's policy — which is what proves the document is
 * theirs — and signs the key it found. The check is not a comparison somebody
 * has to remember to write; it is the query returning nothing.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CLINICAL_DOCUMENT_STORE) private readonly store: ClinicalDocumentStore,
  ) {}

  async upload(
    tenantId: string,
    patientId: string,
    file: { bytes: Buffer; fileName: string },
    meta: RequestMeta,
    /**
     * The order this satisfies, when there is one.
     *
     * Passed by the caller that already resolved it inside the tenant's policy —
     * `DiagnosticsService.attachResult`. Never taken from a request here: a
     * document naming an order is a document claiming to answer it.
     */
    diagnosticOrderId?: string,
  ): Promise<DocumentView> {
    if (file.bytes.length === 0) throw new BadRequestException('That file is empty.');

    if (file.bytes.length > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException(
        `That file is ${Math.round(file.bytes.length / 1024 / 1024)}MB. The limit is ` +
          `${MAX_DOCUMENT_BYTES / 1024 / 1024}MB.`,
      );
    }

    // From the bytes. Never the filename, never the declared Content-Type.
    const detected = detectFileType(file.bytes);
    const fileName = safeFileName(file.fileName);

    return this.prisma.forTenant(tenantId, async (tx) => {
      /**
       * Confirm the patient first, inside the policy.
       *
       * This is what binds the object key to a patient this clinic actually
       * has. Without it a caller could post a patient id belonging to another
       * tenant and have a file written under a key naming it — the row would be
       * refused, but only after the bytes were already in the bucket.
       */
      const patient = await tx.patient.findUnique({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) throw new NotFoundException('No such patient.');

      const stored = await this.store.put({
        tenantId,
        patientId,
        bytes: file.bytes,
        contentType: detected.contentType,
        fileName,
      });

      const document = await tx.clinicalDocument.create({
        data: {
          tenantId,
          patientId,
          objectKey: stored.objectKey,
          fileName,
          contentType: detected.contentType,
          sizeBytes: stored.sizeBytes,
          uploadedByUserId: meta.actorUserId,
          ...(diagnosticOrderId ? { diagnosticOrderId } : {}),
        },
        select: DOCUMENT_SELECT,
      });

      await this.audit.record(tx, tenantId, {
        action: 'document.upload',
        resourceType: 'ClinicalDocument',
        resourceId: document.id,
        patientId,
        // Names, never values. The key is not written here on purpose: an audit
        // row that carries the object key hands a reader the one thing this
        // design works to keep out of requests.
        changedFields: ['objectKey', 'fileName'],
        ...meta,
      });

      return document;
    });
  }

  /** The files attached to one order. */
  async forOrder(tenantId: string, diagnosticOrderId: string): Promise<DocumentView[]> {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.clinicalDocument.findMany({
        where: { diagnosticOrderId },
        orderBy: { createdAt: 'asc' },
        select: DOCUMENT_SELECT,
      }),
    );
  }

  async list(tenantId: string, patientId: string): Promise<DocumentView[]> {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.clinicalDocument.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: DOCUMENT_SELECT,
      }),
    );
  }

  /**
   * A short-lived URL for one document.
   *
   * Every read is audited. A clinical image is the most sensitive thing here,
   * and "who looked at this X-ray" is a question a clinic may one day have to
   * answer — it cannot be answered retrospectively if it was never recorded.
   */
  async signedUrlFor(
    tenantId: string,
    documentId: string,
    meta: RequestMeta,
  ): Promise<{ url: string; expiresInSeconds: number; fileName: string; contentType: string }> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const document = await tx.clinicalDocument.findUnique({
        where: { id: documentId },
        select: { id: true, objectKey: true, fileName: true, contentType: true, patientId: true },
      });

      // Not found and belongs-to-another-clinic are the same answer, because
      // under the tenant policy they are the same query result.
      if (!document) throw new NotFoundException('No such document.');

      /**
       * Belt and braces on the isolation rule.
       *
       * The row came back under this tenant's policy, so its key is already
       * theirs, and the database CHECK on `object_key` says so too. Asserting it
       * again here costs a string comparison and means that if either of those
       * were ever weakened, this still refuses rather than signing a URL for
       * another clinic's file.
       */
      if (!document.objectKey.startsWith(tenantPrefix(tenantId))) {
        throw new NotFoundException('No such document.');
      }

      await this.audit.record(tx, tenantId, {
        action: 'document.read',
        resourceType: 'ClinicalDocument',
        resourceId: document.id,
        patientId: document.patientId,
        changedFields: [],
        ...meta,
      });

      return {
        url: await this.store.signedUrl(document.objectKey),
        expiresInSeconds: SIGNED_URL_TTL_SECONDS,
        fileName: document.fileName,
        contentType: document.contentType,
      };
    });
  }
}

/** Note what is absent: `objectKey`. It never leaves the server. */
const DOCUMENT_SELECT = {
  id: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  createdAt: true,
  uploadedBy: { select: { id: true, fullName: true } },
} as const;
