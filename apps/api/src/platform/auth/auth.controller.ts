import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service.js';
import { Public, CurrentUser, type AuthenticatedUser } from './decorators.js';
import { clearAuthCookies, readRefreshCookie, setAuthCookies } from './cookies.js';

class LoginDto {
  @IsString()
  @MaxLength(63)
  tenantSlug!: string;

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

class ConfirmMfaDto extends LoginDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  declare totpCode: string;
}

class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  /**
   * Twelve characters, and no composition rules.
   *
   * Length is the property that actually resists an offline attack; forcing a
   * symbol and a digit mostly produces Password1! and a sticky note. NIST
   * dropped composition rules for this reason, and the accounts here belong to
   * people who type on a shared clinic PC in a hurry.
   */
  @IsString()
  @MinLength(12, { message: 'Use at least 12 characters — length matters more than symbols.' })
  @MaxLength(200)
  newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const result = await this.auth.login(
      dto.tenantSlug,
      dto.email,
      dto.password,
      dto.totpCode,
      metaFrom(req),
    );

    if ('mfaRequired' in result) {
      // 200, not 401: the password was correct. A 401 here would tell the client
      // to discard the attempt, when what it actually needs is to ask for a code.
      void reply.status(200).send(result);
      return;
    }

    setAuthCookies(reply, result.accessToken, result.refreshToken);
    void reply.status(200).send({ user: result.user, tenant: result.tenant });
  }

  @Public()
  @Post('mfa/confirm')
  @HttpCode(200)
  async confirmMfa(
    @Body() dto: ConfirmMfaDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.auth.confirmMfaEnrolment(
      dto.tenantSlug,
      dto.email,
      dto.password,
      dto.totpCode,
      metaFrom(req),
    );

    if ('mfaRequired' in result) {
      void reply.status(200).send(result);
      return;
    }

    setAuthCookies(reply, result.accessToken, result.refreshToken);
    void reply.status(200).send({ user: result.user, tenant: result.tenant });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const token = readRefreshCookie(req.headers.cookie);
    if (!token) {
      void reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'No session', correlationId: req.id },
      });
      return;
    }

    const result = await this.auth.refresh(token, metaFrom(req));
    setAuthCookies(reply, result.accessToken, result.refreshToken);
    void reply.status(200).send({ user: result.user, tenant: result.tenant });
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.auth.logout(user.tenantId, user.sessionId, metaFrom(req));
    clearAuthCookies(reply);
    void reply.status(204).send();
  }

  /**
   * Who am I — used by the console on load to restore session state.
   *
   * Permissions come from the verified token; the name and roles are read from
   * the database, because the console shows them in its chrome and a role that
   * changed an hour ago should not still be painting the screen.
   */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    const profile = await this.auth.profile(user.tenantId, user.userId);

    return {
      userId: user.userId,
      tenantId: user.tenantId,
      permissions: user.permissions,
      fullName: profile.fullName,
      roles: profile.roles,
      // The console gates every screen on this, so it has to survive a reload —
      // a gate that only exists in the login response is one refresh away from
      // being bypassed.
      mustChangePassword: profile.mustChangePassword,
      // The clinic's own name and logo version. Under full white-label this is
      // what the console wears instead of ours, so it has to survive a reload
      // rather than living only in the login response.
      tenant: profile.tenant,
      // Set when this user is a bookable doctor. The console uses it to lock
      // the queue to their own list; the API enforces the same thing.
      practitionerId: profile.practitionerId,
    };
  }

  /**
   * Change your own password (FR-USR-05).
   *
   * The one write a user forced into a password change is allowed to make — the
   * console blocks every other screen until `mustChangePassword` clears, and
   * this is the endpoint that clears it.
   */
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.auth.changePassword(
      user.tenantId,
      user.userId,
      user.sessionId,
      dto.currentPassword,
      dto.newPassword,
      metaFrom(req),
    );

    void reply.status(204).send();
  }

  /** Active sessions for this user (FR-USR-03). */
  @Get('sessions')
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    return { sessions: await this.auth.listSessions(user.tenantId, user.userId) };
  }
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
