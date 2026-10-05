import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  Public,
  RequirePermissions,
  type AuthenticatedUser,
} from '../platform/auth/decorators.js';
import { PERMISSIONS } from '../platform/auth/permissions.js';
import { PublicRateLimitGuard } from '../common/public-rate-limit.guard.js';
import { EngagementService, type EngagementMeta } from './engagement.service.js';
import { FollowUpsService } from './follow-ups.service.js';
import { PatientLinkService } from './patient-link.service.js';

class ArrivalIntentDto {
  @IsIn(['ON_THE_WAY', 'RUNNING_LATE'])
  intent!: 'ON_THE_WAY' | 'RUNNING_LATE';
}

class CheckinAnswerDto {
  @IsInt()
  @Min(0)
  @Max(10)
  painScore!: number;

  @IsOptional()
  @IsBoolean()
  exercisesDone?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

class ConsentDto {
  @IsBoolean()
  granted!: boolean;
}

class BoardQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'week must be YYYY-MM-DD' })
  week?: string;
}

/**
 * What a patient's phone talks to. No session: the key is the credential.
 *
 * Rate-limited per IP, like the branding endpoints, because these are the only
 * other routes in the API that answer strangers.
 */
@Controller()
export class PatientLinkController {
  constructor(private readonly links: PatientLinkService) {}

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Get('p/:key')
  async view(@Param('key') key: string) {
    return this.links.view(key);
  }

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Post('p/:key/arrival')
  async arrival(@Param('key') key: string, @Body() dto: ArrivalIntentDto) {
    return this.links.setArrivalIntent(key, dto.intent);
  }

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Post('p/:key/checkin')
  async checkin(@Param('key') key: string, @Body() dto: CheckinAnswerDto) {
    return this.links.answerCheckin(key, {
      painScore: dto.painScore,
      ...(dto.exercisesDone !== undefined ? { exercisesDone: dto.exercisesDone } : {}),
      ...(dto.note !== undefined ? { note: dto.note } : {}),
    });
  }
}

/** The staff side: the follow-up board, recovery in the consultation, and sending. */
@Controller()
export class EngagementController {
  constructor(
    private readonly engagement: EngagementService,
    private readonly followUps: FollowUpsService,
  ) {}

  @Get('follow-ups')
  @RequirePermissions(PERMISSIONS.FOLLOWUP_READ)
  async board(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BoardQueryDto,
  ) {
    const practitionerId = await this.followUps.scopeFor(tenantId, user);
    return this.followUps.board(tenantId, {
      practitionerId,
      ...(query.week ? { week: query.week } : {}),
    });
  }

  @Post('follow-ups/remind-overdue')
  @RequirePermissions(PERMISSIONS.FOLLOWUP_MANAGE)
  async remindOverdue(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
  ) {
    const practitionerId = await this.followUps.scopeFor(tenantId, user);
    return this.followUps.remindAllOverdue(tenantId, practitionerId, meta(req, user));
  }

  @Post('follow-ups/dispatch-checkins')
  @RequirePermissions(PERMISSIONS.FOLLOWUP_MANAGE)
  async dispatch(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
  ) {
    const sent = await this.engagement.dispatchDueCheckins(tenantId, meta(req, user));
    return { sent };
  }

  @Post('follow-ups/:encounterId/remind')
  @RequirePermissions(PERMISSIONS.FOLLOWUP_MANAGE)
  async remind(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.engagement.remindReview(tenantId, encounterId, meta(req, user));
  }

  @Post('follow-ups/checkins/:id/clear-flag')
  @RequirePermissions(PERMISSIONS.FOLLOWUP_MANAGE)
  async clearFlag(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.followUps.clearFlag(tenantId, id, meta(req, user));
  }

  @Get('encounters/:id/recovery')
  @RequirePermissions(PERMISSIONS.CONSULTATION_READ)
  async recovery(@CurrentTenant() tenantId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.followUps.recoveryForEncounter(tenantId, id);
  }

  @Post('encounters/:id/send-to-patient')
  @RequirePermissions(PERMISSIONS.CONSULTATION_WRITE)
  async sendToPatient(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.engagement.sendPrescription(tenantId, id, meta(req, user));
  }

  @Put('patients/:id/communications-consent')
  @RequirePermissions(PERMISSIONS.CONSENT_WRITE)
  async consent(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConsentDto,
    @Req() req: FastifyRequest,
  ) {
    return this.engagement.setCommunicationsConsent(tenantId, id, dto.granted, meta(req, user));
  }

  @Get('patients/:id/messages')
  @RequirePermissions(PERMISSIONS.PATIENT_READ)
  async messages(@CurrentTenant() tenantId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.engagement.messagesFor(tenantId, id);
  }
}

function meta(req: FastifyRequest, user: AuthenticatedUser): EngagementMeta {
  const out: EngagementMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) out.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') out.userAgent = ua.slice(0, 500);
  return out;
}
