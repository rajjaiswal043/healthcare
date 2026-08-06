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

  /** Who am I — used by the console on load to restore session state. */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      permissions: user.permissions,
    };
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
