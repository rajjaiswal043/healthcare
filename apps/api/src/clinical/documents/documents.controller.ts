import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../platform/auth/decorators.js';
import { PERMISSIONS } from '../../platform/auth/permissions.js';
import { DocumentsService, MAX_DOCUMENT_BYTES } from './documents.service.js';

/**
 * Clinical documents over HTTP.
 *
 * **There is no route here that accepts an object key**, and that absence is the
 * design. A caller names a patient (to upload) or a document id (to read); the
 * server decides where bytes go and which key gets signed. See
 * docs/09-diagnostics-plan.md section 1.
 */
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /**
   * Attach a file to a patient.
   *
   * Multipart rather than base64-in-JSON — the opposite of the choice made for
   * the clinic logo, and for a reason that flipped with the size. A 512KB logo
   * base64s to 700KB and fits comfortably in a JSON body; a 25MB X-ray base64s
   * to 34MB, which means holding both the encoded string and the decoded buffer
   * in memory for every concurrent upload.
   */
  @Post('patients/:id/documents')
  @RequirePermissions(PERMISSIONS.DOCUMENT_WRITE)
  async upload(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) patientId: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart()) {
      throw new BadRequestException('Send the file as multipart/form-data, field name "file".');
    }

    const part = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
    if (!part) throw new BadRequestException('No file in the request.');

    const bytes = await part.toBuffer().catch(() => {
      // Thrown by @fastify/multipart when the stream exceeds `fileSize`. Caught
      // here so the clinic gets a sentence rather than a stack trace, and so the
      // limit is reported in the same units they think in.
      throw new BadRequestException(
        `That file is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB.`,
      );
    });

    return this.documents.upload(
      tenantId,
      patientId,
      { bytes, fileName: part.filename },
      meta(req, user),
    );
  }

  @Get('patients/:id/documents')
  @RequirePermissions(PERMISSIONS.DOCUMENT_READ)
  async list(
    @CurrentTenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) patientId: string,
  ) {
    return { documents: await this.documents.list(tenantId, patientId) };
  }

  /**
   * A short-lived URL to fetch the file.
   *
   * The API hands back a URL rather than streaming the bytes so a 25MB image
   * comes straight from S3 rather than through this process. Every issue is
   * audited — "who looked at this X-ray" is a question that cannot be answered
   * later if it was not recorded at the time.
   */
  /**
   * The bytes themselves, for a local store with no bucket behind it.
   *
   * Not a way around the signed URL — on S3 this refuses, because the point of
   * signing one is that a 25MB scan goes from the bucket to the browser and
   * not through this process. It exists so a clinic running without AWS
   * credentials can still open the report it just uploaded.
   */
  @Get('documents/:id/raw')
  @RequirePermissions(PERMISSIONS.DOCUMENT_READ)
  async raw(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) documentId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.documents.rawBytes(tenantId, documentId, meta(req, user));

    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`)
      .header('cache-control', 'private, no-store')
      .send(file.bytes);
  }

  @Get('documents/:id/url')
  @RequirePermissions(PERMISSIONS.DOCUMENT_READ)
  async url(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) documentId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.documents.signedUrlFor(tenantId, documentId, meta(req, user));
  }
}

interface RequestMeta {
  actorUserId: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

function meta(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const out: RequestMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) out.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') out.userAgent = ua.slice(0, 500);
  return out;
}
