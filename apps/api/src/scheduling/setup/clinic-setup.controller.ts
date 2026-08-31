import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../platform/auth/decorators.js';
import { PERMISSIONS } from '../../platform/auth/permissions.js';
import { ClinicSetupService, type RequestMeta } from './clinic-setup.service.js';

class DepartmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /**
   * X-ray, pathology. A diagnostic department has no appointment slots and does
   * not appear at the first step of booking — a doctor sends a patient there
   * mid-visit rather than anyone booking it.
   */
  @IsOptional()
  @IsBoolean()
  isDiagnostic?: boolean;
}

class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isDiagnostic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class PractitionerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  prefix?: string;

  /**
   * Optional here, and required on a printed prescription.
   *
   * Not enforced at creation on purpose: a clinic setting up on a Sunday
   * evening should not be blocked because the certificate is at the practice.
   * The print refuses loudly instead — see PrescriptionPrint — which puts the
   * refusal where the consequence is.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  registrationNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  qualification?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  specialty?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  /** The doctor's own login, when they have one. */
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  consultationFeePaise?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  followUpFeePaise?: number;
}

class UpdatePractitionerDto extends PractitionerDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  declare fullName: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class ScheduleDto {
  @IsUUID()
  locationId!: string;

  /** 0 = Sunday, matching JavaScript's getDay(). */
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'endTime must be HH:mm' })
  endTime!: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(120)
  slotMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  capacityPerSlot?: number;
}

class ServiceDto {
  @IsString()
  @MaxLength(40)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @IsIn(['CONSULTATION', 'PROCEDURE', 'DIAGNOSTIC', 'CONSUMABLE', 'OTHER'])
  category!: string;

  @IsInt()
  @Min(0)
  @Max(100_000_000)
  pricePaise!: number;
}

/**
 * Clinic setup — the step between "a clinic exists with staff" and "a clinic can
 * see patients".
 *
 * Behind `schedule:manage`, which only the administrator holds: a doctor's hours
 * and fees are a clinic-level setting, not a booking action, and the front desk
 * changing them would be the front desk changing what the clinic charges.
 */
@Controller()
export class ClinicSetupController {
  constructor(private readonly setup: ClinicSetupService) {}

  // --- departments ---------------------------------------------------------

  /** What setup sees, unlike booking: diagnostic departments included. */
  @Get('setup/departments')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async listDepartments(@CurrentTenant() tenantId: string) {
    return this.setup.listDepartments(tenantId);
  }

  @Post('departments')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async createDepartment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DepartmentDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.createDepartment(
      tenantId,
      dto.name,
      meta(req, user),
      dto.isDiagnostic ?? false,
    );
  }

  @Patch('departments/:id')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async updateDepartment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDepartmentDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.updateDepartment(tenantId, id, { ...dto }, meta(req, user));
  }

  // --- doctors -------------------------------------------------------------

  /** Every doctor with their weekly hours, plus logins not yet linked to one. */
  @Get('setup/practitioners')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async listPractitioners(@CurrentTenant() tenantId: string) {
    return this.setup.listPractitioners(tenantId);
  }

  @Post('setup/practitioners')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async createPractitioner(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PractitionerDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.createPractitioner(tenantId, { ...dto }, meta(req, user));
  }

  @Patch('setup/practitioners/:id')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async updatePractitioner(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePractitionerDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.updatePractitioner(tenantId, id, { ...dto }, meta(req, user));
  }

  // --- weekly hours --------------------------------------------------------

  @Post('setup/practitioners/:id/schedules')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async addSchedule(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ScheduleDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.addSchedule(tenantId, id, { ...dto }, meta(req, user));
  }

  @Delete('setup/schedules/:id')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async removeSchedule(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.removeSchedule(tenantId, id, meta(req, user));
  }

  // --- fees ----------------------------------------------------------------

  @Post('setup/services')
  @RequirePermissions(PERMISSIONS.TENANT_CONFIGURE)
  async upsertService(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ServiceDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.upsertService(tenantId, { ...dto }, meta(req, user));
  }
}

function meta(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const out: RequestMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) out.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') out.userAgent = ua.slice(0, 500);
  return out;
}
