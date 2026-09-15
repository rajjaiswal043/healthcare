import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsBase64, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  Public,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/decorators.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { PublicRateLimitGuard } from '../../common/public-rate-limit.guard.js';
import { BrandingService } from './branding.service.js';
import { MAX_UPLOAD_BYTES } from './logo-image.js';

/**
 * Slug in a URL segment.
 *
 * Shaped rather than merely length-checked, so a slug that could not exist
 * never reaches a query. `tenant.slug` is `varchar(63)`.
 */
class SlugParamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'slug must be lowercase letters, digits and hyphens',
  })
  slug!: string;
}

/**
 * A logo, as base64.
 *
 * Base64 in a JSON body rather than multipart, deliberately. Multipart means a
 * new Fastify plugin, its interaction with the global ValidationPipe, and test
 * bodies assembled by hand — real cost, for a single bounded field. The
 * inflation it avoids is 33% of at most 512KB, so the encoded body peaks around
 * 700KB and sits inside Fastify's default 1MB limit with room to spare. If a
 * second, larger upload ever arrives (patient documents), that one wants
 * presigned direct-to-object-store uploads and would not have used this path
 * anyway.
 */
class RenameClinicDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;
}

class SetLogoDto {
  @IsString()
  @IsBase64({}, { message: 'logo must be base64-encoded image bytes' })
  // Bound the STRING here so an oversized payload is refused before it is
  // decoded into a Buffer. `normaliseLogo` checks the decoded length too; this
  // is the cheaper of the two checks and runs first.
  @MaxLength(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8, {
    message: `logo must be at most ${MAX_UPLOAD_BYTES / 1024}KB`,
  })
  logo!: string;
}

@Controller()
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  // --- public: the login page, before there is a session --------------------

  /**
   * What a clinic is called, and whether it has a logo.
   *
   * Public by necessity — the sign-in screen has to show a clinic's own name
   * and mark before anybody has authenticated, which is the entire point of
   * white-labelling. Narrow by construction: the service reads three columns of
   * one table by slug, and an unknown slug is answered exactly like a known one.
   */
  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Get('branding/:slug')
  async resolve(@Param() params: SlugParamDto) {
    return this.branding.resolve(params.slug);
  }

  /**
   * The logo bytes.
   *
   * Cached hard and keyed by version: the URL carries `?v=<logoVersion>` from
   * the call above, so replacing a logo produces a different URL and nothing
   * needs invalidating. The ETag makes the revalidation cheap for a client that
   * ignores the query parameter.
   */
  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Get('branding/:slug/logo')
  async logo(
    @Param() params: SlugParamDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { bytes, mimeType, etag } = await this.branding.logoFor(params.slug);

    if (req.headers['if-none-match'] === etag) {
      await reply.code(304).send();
      return;
    }

    await reply
      .header('Content-Type', mimeType)
      .header('ETag', etag)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      // This image is served to anyone who asks and rendered by the web app on
      // a different origin. It is a logo, not a document — say so, so a browser
      // never sniffs it into something executable.
      .header('X-Content-Type-Options', 'nosniff')
      .send(bytes);
  }

  // --- the clinic's own settings -------------------------------------------

  @Get('branding')
  @RequirePermissions(PERMISSIONS.TENANT_CONFIGURE)
  async current(@CurrentTenant() tenantId: string) {
    return this.branding.current(tenantId);
  }

  /**
   * The clinic's patient ID format, read-only (FR-UID-02).
   *
   * So an administrator can answer "what do our patient numbers look like?"
   * without asking us. There is deliberately no write beside it: changing the
   * format is the platform's job (decision D3), and a setting that looks
   * harmless and has no undo should not be one click away.
   */
  @Get('settings/patient-ids')
  @RequirePermissions(PERMISSIONS.TENANT_CONFIGURE)
  async patientIdFormat(@CurrentTenant() tenantId: string) {
    return this.branding.patientIdFormat(tenantId);
  }

  /**
   * Rename the clinic for display.
   *
   * Written as PATCH on the branding resource rather than a general
   * "update tenant" endpoint, so that the only tenant field a clinic can change
   * from its own console is the one it is meant to.
   */
  @Patch('branding')
  @RequirePermissions(PERMISSIONS.TENANT_CONFIGURE)
  async rename(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RenameClinicDto,
    @Req() req: FastifyRequest,
  ) {
    return this.branding.rename(tenantId, dto.name, meta(req, user));
  }

  @Put('branding/logo')
  @RequirePermissions(PERMISSIONS.TENANT_CONFIGURE)
  async setLogo(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetLogoDto,
    @Req() req: FastifyRequest,
  ) {
    return this.branding.setLogo(tenantId, Buffer.from(dto.logo, 'base64'), meta(req, user));
  }

  @Delete('branding/logo')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.TENANT_CONFIGURE)
  async clearLogo(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.branding.clearLogo(tenantId, meta(req, user));
  }
}

interface RequestMeta {
  correlationId?: string;
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
}

function meta(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const out: RequestMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) out.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') out.userAgent = ua.slice(0, 500);
  return out;
}
