import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../platform/auth/decorators.js';
import { PERMISSIONS } from '../../platform/auth/permissions.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { MAX_DOCUMENT_BYTES } from '../documents/documents.service.js';

class CreateOrderDto {
  @IsUUID()
  appointmentId!: string;

  @IsUUID()
  departmentId!: string;

  /**
   * The catalogue test being ordered, when the clinic offers it.
   *
   * Optional so a clinic that has priced nothing yet can still raise orders the
   * way it always has. The service checks it against `departmentId`.
   */
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  /**
   * "X-ray, left knee, AP and lateral".
   *
   * Optional only when `serviceId` is given — the service falls back to the
   * catalogue name, and refuses an order that would say nothing at all. Kept as
   * free text on top of the picker because laterality and view are the part a
   * catalogue entry cannot carry.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  description?: string;
}

class ExternalTestNoteDto {
  /**
   * Null or blank clears it. A doctor who deletes the line meant to delete it,
   * and there is no "unsay" for something already printed.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

class CatalogueQueryDto {
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

class CompleteOrderDto {
  /**
   * The report. Optional only because some results are an image and nothing
   * else — but an order with neither a file nor a note is refused by the
   * service, since it tells the doctor the test happened and nothing about what
   * it found.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resultNote?: string;
}

class WorklistQueryDto {
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  /**
   * DECLINED is a filter value, not part of the PENDING list.
   *
   * A declined test is not work, so it does not belong on the queue of work —
   * but it must be findable, because the question the department actually asks
   * is "what happened to the X-ray I was expecting". Left on the pending list
   * it would accumulate forever; unreachable it would just vanish.
   */
  @IsOptional()
  @IsIn(['PENDING', 'COMPLETED', 'DECLINED'])
  status?: 'PENDING' | 'COMPLETED' | 'DECLINED';
}

@Controller()
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  /** Departments that do tests. Distinct from `/departments`, which is booking. */
  @Get('diagnostics/departments')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_READ)
  async departments(@CurrentTenant() tenantId: string) {
    return this.diagnostics.departments(tenantId);
  }

  /**
   * The orderable tests and their fees.
   *
   * `diagnostic:order`, not `diagnostic:read`: this carries prices, and the one
   * screen that needs them is the one deciding to spend the patient's money.
   */
  @Get('diagnostics/catalogue')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_ORDER)
  async catalogue(@CurrentTenant() tenantId: string, @Query() query: CatalogueQueryDto) {
    return this.diagnostics.catalogue(tenantId, query.departmentId);
  }

  /**
   * The worklist.
   *
   * Behind `diagnostic:read`, which the diagnostics role holds along with
   * everyone clinical — the front desk fields "are my results back yet" and
   * should not have to ask the doctor.
   */
  @Get('diagnostics/orders')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_READ)
  async worklist(@CurrentTenant() tenantId: string, @Query() query: WorklistQueryDto) {
    return this.diagnostics.worklist(tenantId, query);
  }

  /**
   * Tests this centre does not perform, for the slip (decision (b)).
   *
   * `diagnostic:order`: it is the same act as ordering a test — the doctor
   * deciding the patient needs one — and only the destination differs. Written
   * to the appointment, which is why the finance desk can read it back without
   * being handed the consultation.
   */
  @Put('appointments/:id/external-test-note')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_ORDER)
  async setExternalTestNote(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) appointmentId: string,
    @Body() dto: ExternalTestNoteDto,
    @Req() req: FastifyRequest,
  ) {
    return this.diagnostics.setExternalTestNote(
      tenantId,
      appointmentId,
      dto.note ?? null,
      meta(req, user),
    );
  }

  /**
   * This patient's completed tests, for the doctor seeing them right now.
   *
   * `consultation:read` gets you to the door; the service decides whether it
   * opens. The permission cannot express the rule — "the doctor with this
   * patient in front of them, today" is about a relationship between three
   * rows, not about a role — so the gate lives in `patientTestHistory` and is
   * checked on every call. See decision (e).
   */
  @Get('encounters/:id/patient-test-history')
  @RequirePermissions(PERMISSIONS.CONSULTATION_READ)
  async patientTestHistory(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) encounterId: string,
  ) {
    return this.diagnostics.patientTestHistory(tenantId, encounterId, user);
  }

  /** What was ordered on one visit. The consultation reads this. */
  @Get('appointments/:id/diagnostic-orders')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_READ)
  async forVisit(
    @CurrentTenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) appointmentId: string,
  ) {
    return this.diagnostics.forVisit(tenantId, appointmentId);
  }

  /**
   * Raise one.
   *
   * `diagnostic:order`, which the diagnostics role deliberately does NOT hold:
   * a department does not order its own work.
   */
  @Post('diagnostics/orders')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_ORDER)
  async create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrderDto,
    @Req() req: FastifyRequest,
  ) {
    return this.diagnostics.createOrder(tenantId, dto, meta(req, user));
  }

  /** One order with everything attached to it. */
  @Get('diagnostics/orders/:id')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_READ)
  async one(@CurrentTenant() tenantId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.diagnostics.order(tenantId, id);
  }

  /**
   * Attach a file to an order.
   *
   * Addressed by ORDER rather than by patient, deliberately: the order names the
   * patient, so a technician cannot file one person's film against another's
   * request. Behind `diagnostic:result`, which the doctor does not hold — the
   * department results its own work, and only its own.
   */
  @Post('diagnostics/orders/:id/documents')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_RESULT)
  async attach(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart()) {
      throw new BadRequestException('Send the file as multipart/form-data, field name "file".');
    }

    const part = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
    if (!part) throw new BadRequestException('No file in the request.');

    const bytes = await part.toBuffer().catch(() => {
      throw new BadRequestException(
        `That file is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB.`,
      );
    });

    return this.diagnostics.attachResult(
      tenantId,
      id,
      { bytes, fileName: part.filename },
      meta(req, user),
    );
  }

  /** Mark the test done. Separate from attaching, because a study is often several files. */
  @Patch('diagnostics/orders/:id/complete')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_RESULT)
  async complete(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CompleteOrderDto,
    @Req() req: FastifyRequest,
  ) {
    return this.diagnostics.completeOrder(tenantId, id, dto.resultNote, meta(req, user));
  }

  /**
   * The patient refused the test at the desk.
   *
   * `invoice:write`, not `diagnostic:order`. This is a money action wearing a
   * clinical hat: it takes a charge to zero, and the person who has that
   * conversation with the patient is at the finance desk, not in the room. The
   * doctor's equivalent is `cancel` below, which withdraws the request.
   */
  @Post('diagnostics/orders/:id/decline')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  async decline(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.diagnostics.declineOrder(tenantId, id, meta(req, user));
  }

  @Patch('diagnostics/orders/:id/cancel')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_ORDER)
  async cancel(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.diagnostics.cancelOrder(tenantId, id, meta(req, user));
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
