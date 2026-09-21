import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../platform/auth/decorators.js';
import { PERMISSIONS } from '../../platform/auth/permissions.js';
import { PatientsService, type RequestMeta } from './patients.service.js';
import { RegisterPatientDto } from './dto/register-patient.dto.js';
import { ListPatientsQueryDto } from './dto/list-patients.dto.js';
import { CheckDuplicatesDto } from './dto/check-duplicates.dto.js';
import { CorrectPatientDto } from './correct-patient.dto.js';

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  /** Live duplicate check as the receptionist types (FR-P36-03). */
  @Post('check-duplicates')
  @RequirePermissions(PERMISSIONS.PATIENT_WRITE)
  async checkDuplicates(@CurrentTenant() tenantId: string, @Body() dto: CheckDuplicatesDto) {
    const duplicates = await this.patients.findDuplicates(tenantId, dto);
    return { duplicates };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PATIENT_WRITE)
  async register(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPatientDto,
    @Req() req: FastifyRequest,
  ) {
    return this.patients.register(tenantId, dto, metaFrom(req, user));
  }

  /**
   * Every active patient, newest first, thirty to a page.
   *
   * Declared before `@Get(':id')` on purpose. Fastify's router prefers a
   * static segment, so the order does not decide the match today — but a
   * later handler reading this controller top to bottom should not have to
   * know that to see why `/patients/all` is not treated as a patient id.
   */
  @Get('all')
  @RequirePermissions(PERMISSIONS.PATIENT_READ)
  async all(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPatientsQueryDto,
    @Req() req: FastifyRequest,
  ) {
    return this.patients.all(tenantId, query.page ?? 1, metaFrom(req, user));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.PATIENT_READ)
  async search(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const patients = await this.patients.search(tenantId, q ?? '', metaFrom(req, user));
    return { patients };
  }

  /**
   * Correct a patient registered earlier — FR-P36-20.
   *
   * Behind `patient:write`, the permission the front desk and doctors already
   * hold: the people who register patients and the people who notice the error
   * mid-consultation. Narveer's choice on 27 Aug 2026 over widening it to
   * everyone clinical.
   *
   * The DTO is where UHID and ABHA are refused — see `CorrectPatientDto`.
   */
  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PATIENT_WRITE)
  async correct(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CorrectPatientDto,
    @Req() req: FastifyRequest,
  ) {
    return this.patients.correct(tenantId, id, { ...dto }, metaFrom(req, user));
  }

  /** What this record used to say. Administrators only. */
  @Get(':id/corrections')
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  async corrections(
    @CurrentTenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.patients.corrections(tenantId, id);
  }

  /**
   * The full record, for the patient detail screen.
   *
   * Demographics, current consent position and recent visits in one response.
   * The alternative — four endpoints the client stitches together — gives the
   * screen four loading states and lets it render half a patient when one of
   * them fails.
   */
  @Get(':id')
  @RequirePermissions(PERMISSIONS.PATIENT_READ)
  async findOne(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.patients.detail(tenantId, id, metaFrom(req, user));
  }
}

/**
 * Request metadata for the audit trail.
 *
 * Assembled at the controller because this is the only layer that legitimately
 * knows about HTTP — services stay transport-agnostic. The actor comes from the
 * verified session, never from anything the client sent.
 */
function metaFrom(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const meta: RequestMeta = { correlationId: req.id, actorUserId: user.userId };

  if (req.ip) meta.ipAddress = req.ip;

  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua.slice(0, 500);

  return meta;
}
