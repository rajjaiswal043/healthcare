import {
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
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../platform/auth/decorators.js';
import { PERMISSIONS } from '../../platform/auth/permissions.js';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { ConsultationsService, type RequestMeta } from './consultations.service.js';
import { searchDiagnosisCodes } from './icd10.js';
import {
  AddendumDto,
  FormularySearchDto,
  OpenEncounterDto,
  RecordVitalsDto,
  SetDiagnosesDto,
  SetPrescriptionsDto,
  UpdateEncounterDto,
} from './dto.js';

@Controller()
export class ConsultationsController {
  constructor(
    private readonly consultations: ConsultationsService,
    private readonly prisma: PrismaService,
  ) {}

  // --- the consultation ----------------------------------------------------

  /** Open, or resume, the consultation for an appointment. */
  @Post('encounters')
  @RequirePermissions(PERMISSIONS.CONSULTATION_WRITE)
  async open(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OpenEncounterDto,
    @Req() req: FastifyRequest,
  ) {
    return this.consultations.open(tenantId, dto.appointmentId, await this.meta(req, user));
  }

  @Get('encounters/:id')
  @RequirePermissions(PERMISSIONS.CONSULTATION_READ)
  async get(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.consultations.get(tenantId, id, await this.meta(req, user));
  }

  @Patch('encounters/:id')
  @RequirePermissions(PERMISSIONS.CONSULTATION_WRITE)
  async update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateEncounterDto,
    @Req() req: FastifyRequest,
  ) {
    return this.consultations.updateNarrative(tenantId, id, dto, await this.meta(req, user));
  }

  /**
   * Vitals sit behind their own permission, so a nurse can record them without
   * being able to write the note.
   */
  @Post('encounters/:id/vitals')
  @RequirePermissions(PERMISSIONS.VITALS_WRITE)
  async vitals(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RecordVitalsDto,
    @Req() req: FastifyRequest,
  ) {
    return this.consultations.recordVitals(tenantId, id, dto, await this.meta(req, user));
  }

  @Put('encounters/:id/diagnoses')
  @RequirePermissions(PERMISSIONS.CONSULTATION_WRITE)
  async diagnoses(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetDiagnosesDto,
    @Req() req: FastifyRequest,
  ) {
    return this.consultations.setDiagnoses(tenantId, id, dto.diagnoses, await this.meta(req, user));
  }

  @Put('encounters/:id/prescriptions')
  @RequirePermissions(PERMISSIONS.PRESCRIPTION_WRITE)
  async prescriptions(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetPrescriptionsDto,
    @Req() req: FastifyRequest,
  ) {
    return this.consultations.setPrescriptions(
      tenantId,
      id,
      dto.prescriptions,
      await this.meta(req, user),
    );
  }

  @Post('encounters/:id/sign')
  @RequirePermissions(PERMISSIONS.CONSULTATION_WRITE)
  async sign(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.consultations.sign(tenantId, id, await this.meta(req, user));
  }

  @Post('encounters/:id/addenda')
  @RequirePermissions(PERMISSIONS.CONSULTATION_WRITE)
  async addendum(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddendumDto,
    @Req() req: FastifyRequest,
  ) {
    return this.consultations.addAddendum(tenantId, id, dto, await this.meta(req, user));
  }

  /**
   * What happened last time, read from inside the current consultation.
   *
   * FR-P36-23. Addressed by ENCOUNTER rather than by patient so the server
   * decides which visits count as "previous" — a client passing a patient id and
   * a date could ask for visits after this one, which is not a question with a
   * sensible answer.
   */
  @Get('encounters/:id/previous-visits')
  @RequirePermissions(PERMISSIONS.CONSULTATION_READ)
  async previousVisits(
    @CurrentTenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) encounterId: string,
  ) {
    return this.consultations.previousVisits(tenantId, encounterId);
  }

  /** Past consultations, for Patient 360. */
  @Get('patients/:id/encounters')
  @RequirePermissions(PERMISSIONS.CONSULTATION_READ)
  async history(
    @CurrentTenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) patientId: string,
  ) {
    return this.consultations.historyForPatient(tenantId, patientId);
  }

  // --- reference data ------------------------------------------------------

  /**
   * ICD-10 search. Not tenant data — the classification is a published standard,
   * identical everywhere, so it is served from code rather than a table a clinic
   * could edit into disagreeing with the rest of the world.
   */
  @Get('diagnosis-codes')
  @RequirePermissions(PERMISSIONS.CONSULTATION_READ)
  codes(@Query('q') q?: string) {
    return { codes: searchDiagnosisCodes(q ?? '') };
  }

  /** The clinic's drug list, for prescription autocomplete. */
  @Get('formulary')
  @RequirePermissions(PERMISSIONS.CONSULTATION_READ)
  async formulary(@CurrentTenant() tenantId: string, @Query() query: FormularySearchDto) {
    const q = query.q?.trim() ?? '';

    const items = await this.prisma.forTenant(tenantId, (tx) =>
      tx.formularyItem.findMany({
        where: {
          isActive: true,
          ...(q.length > 0
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' as const } },
                  { genericName: { contains: q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: [{ name: 'asc' }],
        take: 20,
        select: { id: true, name: true, genericName: true, strength: true, form: true },
      }),
    );

    return { items };
  }

  // --- internals -----------------------------------------------------------

  /**
   * Request metadata for the audit trail.
   *
   * The actor's NAME is looked up rather than taken from the token: it goes onto
   * an addendum, which is a permanent part of a clinical record, and a name is
   * not something a client should be able to choose.
   */
  private async meta(req: FastifyRequest, user: AuthenticatedUser): Promise<RequestMeta> {
    const actor = await this.prisma.forTenant(user.tenantId, (tx) =>
      tx.user.findUnique({ where: { id: user.userId }, select: { fullName: true } }),
    );

    const meta: RequestMeta = {
      correlationId: req.id,
      actorUserId: user.userId,
      ...(actor?.fullName ? { actorLabel: actor.fullName } : {}),
    };

    if (req.ip) meta.ipAddress = req.ip;
    const ua = req.headers['user-agent'];
    if (typeof ua === 'string') meta.userAgent = ua.slice(0, 500);

    return meta;
  }
}
