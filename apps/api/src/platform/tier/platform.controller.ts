import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { OnboardingService } from './onboarding.service.js';
import { PlatformGuard, type PlatformActor } from './platform.guard.js';
import {
  PLATFORM_REFRESH_COOKIE,
  clearPlatformCookies,
  readPlatformCookie,
  setPlatformCookies,
} from './platform-cookies.js';

class PlatformLoginDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  totpCode?: string;
}

class ConfirmPlatformMfaDto extends PlatformLoginDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  declare totpCode: string;
}

class AdminDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  fullName!: string;
}

class OnboardDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @IsString()
  @MaxLength(63)
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  uhidPrefix?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, { message: 'contactMobile must be a 10-digit Indian mobile number' })
  contactMobile?: string;

  /** role key → seats. Omitting a role leaves it unlimited. */
  @IsOptional()
  @IsObject()
  seatLimits?: Record<string, number>;

  @ValidateNested()
  @Type(() => AdminDto)
  admin!: AdminDto;
}

class SuspendDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason?: string;
}

class SeatLimitsDto {
  @IsObject()
  seatLimits!: Record<string, number>;
}

/**
 * doctorsdesk.in.
 *
 * Note what is absent: any route that reads a patient, a queue, an invoice or a
 * clinical note. That is the line drawn in docs/06 section 2.2, and it is worth
 * keeping this file short enough that a new route crossing it is obvious in
 * review.
 *
 * The clinic's global AuthGuard is opted out of with @Public() and replaced by
 * PlatformGuard — the two realms verify different token shapes against different
 * tables, so neither one's credential works in the other.
 */
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly onboarding: OnboardingService,
  ) {}

  // --- signing in ----------------------------------------------------------

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body() dto: PlatformLoginDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.auth.login(dto.email, dto.password, dto.totpCode, metaFrom(req));

    if ('mfaRequired' in result) {
      void reply.status(200).send(result);
      return;
    }

    setPlatformCookies(reply, result.accessToken, result.refreshToken);
    void reply.status(200).send({ user: result.user });
  }

  @Public()
  @Post('auth/mfa/confirm')
  @HttpCode(200)
  async confirmMfa(
    @Body() dto: ConfirmPlatformMfaDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.auth.confirmMfa(dto.email, dto.password, dto.totpCode, metaFrom(req));

    setPlatformCookies(reply, result.accessToken, result.refreshToken);
    void reply.status(200).send({ user: result.user });
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const token = readPlatformCookie(req.headers.cookie, PLATFORM_REFRESH_COOKIE);

    if (!token) {
      void reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'No session', correlationId: req.id },
      });
      return;
    }

    const result = await this.auth.refresh(token, metaFrom(req));
    setPlatformCookies(reply, result.accessToken, result.refreshToken);
    void reply.status(200).send({ user: result.user });
  }

  @Public()
  @UseGuards(PlatformGuard)
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    await this.auth.logout(actor(req).sessionId);
    clearPlatformCookies(reply);
    void reply.status(204).send();
  }

  @Public()
  @UseGuards(PlatformGuard)
  @Get('auth/me')
  async me(@Req() req: FastifyRequest) {
    return this.auth.me(actor(req).platformUserId);
  }

  // --- clinics -------------------------------------------------------------

  @Public()
  @UseGuards(PlatformGuard)
  @Get('clinics')
  async clinics() {
    return this.onboarding.listClinics();
  }

  /** Create a clinic that works: roles, seats, a location, and an administrator. */
  @Public()
  @UseGuards(PlatformGuard)
  @Post('clinics')
  async onboard(@Body() dto: OnboardDto, @Req() req: FastifyRequest) {
    return this.onboarding.onboard(
      {
        name: dto.name,
        slug: dto.slug,
        ...(dto.timezone ? { timezone: dto.timezone } : {}),
        ...(dto.uhidPrefix ? { uhidPrefix: dto.uhidPrefix } : {}),
        ...(dto.contactEmail ? { contactEmail: dto.contactEmail } : {}),
        ...(dto.contactMobile ? { contactMobile: dto.contactMobile } : {}),
        ...(dto.seatLimits ? { seatLimits: dto.seatLimits } : {}),
        admin: dto.admin,
      },
      actor(req).platformUserId,
    );
  }

  @Public()
  @UseGuards(PlatformGuard)
  @Patch('clinics/:id/suspend')
  async suspend(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SuspendDto) {
    return this.onboarding.setSuspended(id, true, dto.reason ?? null);
  }

  @Public()
  @UseGuards(PlatformGuard)
  @Patch('clinics/:id/reactivate')
  async reactivate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.onboarding.setSuspended(id, false, null);
  }

  @Public()
  @UseGuards(PlatformGuard)
  @Patch('clinics/:id/seat-limits')
  async seatLimits(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SeatLimitsDto) {
    return this.onboarding.setSeatLimits(id, dto.seatLimits);
  }
}

function actor(req: FastifyRequest): PlatformActor {
  const platform = (req as FastifyRequest & { platform?: PlatformActor }).platform;
  if (!platform) throw new Error('PlatformGuard did not run');
  return platform;
}

function metaFrom(req: FastifyRequest) {
  const meta: { ipAddress?: string; userAgent?: string; correlationId?: string } = {
    correlationId: req.id,
  };
  if (req.ip) meta.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua.slice(0, 500);
  return meta;
}
