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
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../platform/auth/decorators.js';
import { PERMISSIONS } from '../../platform/auth/permissions.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { MAX_DOCUMENT_BYTES } from '../documents/documents.service.js';

class CreateOrderDto {
  /**
   * The consultation, for an order from this clinic's own doctor.
   *
   * Optional since FR-DIA-10: a walk-in test has no consultation, and the
   * database refuses one on any order that is not INTERNAL.
   */
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  /** The patient, for a walk-in. Read off the visit when there is one. */
  @IsOptional()
  @IsUUID()
  patientId?: string;

  /**
   * Who decided the test was needed. Defaults to INTERNAL, which is what every
   * order raised before walk-ins existed was.
   */
  @IsOptional()
  @IsIn(['INTERNAL', 'EXTERNAL_DOCTOR', 'SELF'])
  referralSource?: 'INTERNAL' | 'EXTERNAL_DOCTOR' | 'SELF';

  /** The outside doctor who sent them. Required when the source is EXTERNAL_DOCTOR. */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  referrerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  referrerClinic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  referrerPhone?: string;

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

class WalkInOrderDto {
  @IsUUID()
  patientId!: string;

  /** Catalogue tests. Several on one bill is the point (FR-DIA-11). */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  // No version argument: ids here are uuidv7, and `IsUUID('4')` rejects them.
  @IsUUID(undefined, { each: true })
  serviceIds!: string[];

  /**
   * INTERNAL is absent on purpose: an order from this clinic's own doctor
   * belongs to a consultation, and that is `POST /diagnostics/orders`.
   */
  @IsIn(['EXTERNAL_DOCTOR', 'SELF'])
  referralSource!: 'EXTERNAL_DOCTOR' | 'SELF';

  @IsOptional()
  @IsString()
  @MaxLength(160)
  referrerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  referrerClinic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  referrerPhone?: string;
}

class HandoverDto {
  /** The patient, or the relative who collected it. Free text — see the column. */
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  handedOverTo!: string;
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
   * Either ordering permission, not `diagnostic:read`: this carries prices, and
   * the screens that need them are the ones deciding to spend the patient's
   * money. The doctor reaches it through `diagnostic:order` while choosing a
   * test in a consultation; the finance desk through `diagnostic:order:walkin`
   * while selling one at the counter. Requiring both would have meant giving
   * finance the power to order tests on anybody's consultation, which is the
   * thing splitting the permissions was for.
   */
  @Get('diagnostics/catalogue')
  @RequireAnyPermission(PERMISSIONS.DIAGNOSTIC_ORDER, PERMISSIONS.DIAGNOSTIC_ORDER_WALKIN)
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

  /**
   * A patient who walked in wanting tests (FR-DIA-10, FR-DIA-12).
   *
   * `diagnostic:order:walkin`, which finance holds and the front desk does
   * not. The flow the clinics described had finance price the test and the
   * front desk request it — the same information typed twice, by two people,
   * each with a patient in front of them. Finance does both (decision 1).
   */
  @Post('diagnostics/walk-in-orders')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_ORDER_WALKIN)
  async walkIn(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WalkInOrderDto,
    @Req() req: FastifyRequest,
  ) {
    return this.diagnostics.createWalkInOrders(tenantId, dto, meta(req, user));
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

  /**
   * Put a declined test back. Finance-only, the same hand that declined it.
   */
  @Post('diagnostics/orders/:id/undecline')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  async undecline(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.diagnostics.undeclineOrder(tenantId, id, meta(req, user));
  }

  /**
   * The report was given to the patient (FR-DIA-13).
   *
   * `diagnostic:result` — the department that did the work is the one that
   * hands it over, and is who the requirement names.
   */
  @Post('diagnostics/orders/:id/handover')
  @RequirePermissions(PERMISSIONS.DIAGNOSTIC_RESULT)
  async handover(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: HandoverDto,
    @Req() req: FastifyRequest,
  ) {
    return this.diagnostics.recordHandover(tenantId, id, dto.handedOverTo, meta(req, user));
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
