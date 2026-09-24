import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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

/**
 * Editing a doctor already on the books — and note what is NOT here.
 *
 * This used to `extends PractitionerDto`, which meant it silently accepted
 * everything creation accepts. Inheritance is the wrong tool for a shape whose
 * whole point is that it is NARROWER than the one it resembles: a field added
 * to creation would have appeared here too, editable, without anybody deciding
 * it should be. Written out in full instead, so the list of what an edit may
 * touch is a list somebody has to change on purpose.
 *
 * **`departmentId` is absent, and that is the enforcement.** A doctor's
 * department is the anchor two things already treat as permanent: walk-in
 * diagnostics, and the department-wise revenue split in the finance report.
 * Moving a doctor between departments would not re-file the money they earned
 * last quarter — it would silently change what last quarter's report MEANS, and
 * a report whose meaning depends on a setting somebody edited since is not a
 * report. Same principle the patient-ID format follows: history is not rewritten
 * to match a new setting.
 *
 * Absent rather than validated-and-rejected because the global ValidationPipe
 * runs with `forbidNonWhitelisted` — a request carrying `departmentId` is
 * refused with a 400 naming the field, rather than quietly ignored. Quiet
 * ignoring is worse: the caller is told it worked.
 *
 * **`userId` is absent too**, for a different reason — linking a doctor to a
 * login is a real feature, it simply is not this form, and it needs its own
 * decisions about what happens to an existing link. When it gets a screen it
 * gets a field here; until then an edit cannot move it by accident.
 */
class UpdatePractitionerDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  prefix?: string;

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

  /**
   * Settable, correctable, and removable — three states, like a staff mobile.
   *
   * `undefined` leaves the stored fee alone; a number replaces it; `null` drops
   * it, which puts the doctor back on the service catalogue's price rather than
   * on a fee of zero. Without the third state a fee typed in by mistake could
   * only be swapped for another number: there was no way back to "this doctor
   * has no override", which is the default every doctor starts in.
   *
   * Zero is a real and different answer — a doctor who genuinely does not
   * charge — so it cannot be the way to clear one. Hence null, and hence
   * `@Min(0)` staying.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  consultationFeePaise?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  followUpFeePaise?: number | null;

  /** Functional, not cosmetic: availability refuses an inactive doctor. */
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

  /**
   * In paise. The screen takes rupees and converts at the edge — a float never
   * reaches this field and never reaches the column.
   */
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  pricePaise!: number;

  /**
   * Basis points, so 5% is 500. Zero for almost every clinic: healthcare
   * services by a clinical establishment are GST-exempt under Notification
   * 12/2017, which is why the column defaulted to zero and had no way to set it
   * until now.
   *
   * Storing a rate is all this does. What a GST-registered clinic's RECEIPT must
   * legally carry — GSTIN, HSN or SAC codes, a tax breakdown — is a separate
   * question and deliberately not answered here.
   *
   * Capped at 10000 (100%). A tax rate above the price itself is a typo.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  taxRateBasisPoints?: number;

  /** Null detaches the service from its department; absent leaves it alone. */
  @IsOptional()
  @IsUUID()
  departmentId?: string | null;

  /**
   * Absent means "do not change it".
   *
   * This used to be forced to true on every update, so correcting the price of a
   * withdrawn service quietly put it back on the finance desk's dropdown.
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Every change to a doctor's login link says why — it moves whose notes are whose. */
class UnlinkLoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

class LinkLoginDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

class ServiceActiveDto {
  @IsBoolean()
  isActive!: boolean;
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

  /**
   * Delete a doctor added by mistake. Refused with a 409 and the counts once
   * the doctor has any appointment or consultation — see the service.
   */
  @Delete('setup/practitioners/:id')
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE)
  async deletePractitioner(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.deletePractitioner(tenantId, id, meta(req, user));
  }

  // --- the login link ------------------------------------------------------

  /**
   * Administrator only: `user:manage` on top of `schedule:manage`. Changing
   * which login IS a doctor decides whose queue and whose consultations that
   * login can open — a user-management act, not a scheduling one, and a custom
   * role given the doctors' hours should not get it along with them.
   */
  @Post('setup/practitioners/:id/unlink-login')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE, PERMISSIONS.USER_MANAGE)
  async unlinkLogin(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UnlinkLoginDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.unlinkLogin(tenantId, id, dto.reason, meta(req, user));
  }

  @Post('setup/practitioners/:id/link-login')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SCHEDULE_MANAGE, PERMISSIONS.USER_MANAGE)
  async linkLogin(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: LinkLoginDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.linkLogin(tenantId, id, dto.userId, dto.reason, meta(req, user));
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

  /**
   * The whole price list, switched-off services included (FR-PRC-01).
   *
   * Deliberately NOT the same endpoint as `GET /services`. That one answers
   * "what may I put on a bill", hides inactive rows and sits behind
   * `invoice:read` so the finance desk can read it. This answers "what does this
   * clinic charge for", shows everything, and sits behind `tenant:configure` —
   * an administrator pricing a clinic needs to see the withdrawn ones to bring
   * one back, and the desk must never be offered them.
   */
  @Get('setup/services')
  @RequirePermissions(PERMISSIONS.TENANT_CONFIGURE)
  async priceList(@CurrentTenant() tenantId: string) {
    return this.setup.priceList(tenantId);
  }

  /** Switch a service off, or back on. There is no delete — see FR-PRC-03. */
  @Patch('setup/services/:id/active')
  @RequirePermissions(PERMISSIONS.TENANT_CONFIGURE)
  async setServiceActive(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ServiceActiveDto,
    @Req() req: FastifyRequest,
  ) {
    return this.setup.setServiceActive(tenantId, id, dto.isActive, meta(req, user));
  }

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
