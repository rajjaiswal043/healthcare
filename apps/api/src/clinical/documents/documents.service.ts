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
  /**
   * The bytes, for a store that has no bucket to point at.
   *
   * Same tenant checks as `signedUrlFor`, and the same prefix assertion —
   * this hands over file contents, so it gets the belt and braces too. Refuses
   * outright on a store that CAN sign a URL: on S3 the whole design is that
   * bytes never travel through this process.
   */
  async rawBytes(
    tenantId: string,
    documentId: string,
    meta: RequestMeta,
  ): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
    if (!this.store.fetch) {
      throw new NotFoundException('This document is served by a signed URL, not by the API.');
    }

    return this.prisma.forTenant(tenantId, async (tx) => {
      const document = await tx.clinicalDocument.findUnique({
        where: { id: documentId },
        select: { id: true, objectKey: true, fileName: true, contentType: true, patientId: true },
      });
      if (!document) throw new NotFoundException('No such document.');

      if (!document.objectKey.startsWith(tenantPrefix(tenantId))) {
        throw new NotFoundException('No such document.');
      }

      const object = await this.store.fetch!(document.objectKey);
      if (!object) throw new NotFoundException('No such document.');

      await this.audit.record(tx, tenantId, {
        action: 'document.read',
        resourceType: 'ClinicalDocument',
        resourceId: document.id,
        patientId: document.patientId,
        changedFields: [],
        ...meta,
      });

      return {
        bytes: object.bytes,
        contentType: document.contentType,
        fileName: document.fileName,
      };
    });
  }

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

      /**
       * A store with no bucket serves its own bytes.
       *
       * `signedUrl` is meant to hand back something a browser can follow, and
       * the in-memory store cannot — it has no host. Pointing at this API's own
       * `raw` route keeps the contract true for local work without a bucket,
       * and S3 is untouched: its URL still goes straight to the bucket, which
       * is the point of signing one at all.
       */
      const signed = await this.store.signedUrl(document.objectKey);
      const url = signed.startsWith('memory:') ? `/documents/${document.id}/raw` : signed;

      return {
        url,
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
