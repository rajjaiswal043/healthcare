import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  Public,
  RequirePermissions,
  type AuthenticatedUser,
} from '../platform/auth/decorators.js';
import { PERMISSIONS } from '../platform/auth/permissions.js';
import { DisplayService } from './display.service.js';
import type { RequestMeta } from './appointments.service.js';

class PairDisplayDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Empty or absent means every doctor at that location. */
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  practitionerIds?: string[];
}

@Controller()
export class DisplayController {
  constructor(private readonly display: DisplayService) {}

  /**
   * What a waiting-room screen reads. No session: the key is the credential.
   *
   * Public by necessity — a television cannot sign in — and narrow by
   * construction: the response carries token numbers and doctor names, never a
   * patient name. See DisplayService for why that is a constraint rather than a
   * display preference.
   */
  @Public()
  @Get('display/:key')
  async board(@Param('key') key: string) {
    return this.display.board(key);
  }

  // --- pairing, for administrators -----------------------------------------

  @Post('display-devices')
  @RequirePermissions(PERMISSIONS.DISPLAY_MANAGE)
  async pair(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PairDisplayDto,
    @Req() req: FastifyRequest,
  ) {
    return this.display.pair(
      tenantId,
      {
        name: dto.name,
        ...(dto.locationId ? { locationId: dto.locationId } : {}),
        ...(dto.practitionerIds ? { practitionerIds: dto.practitionerIds } : {}),
      },
      meta(req, user),
    );
  }

  @Get('display-devices')
  @RequirePermissions(PERMISSIONS.DISPLAY_MANAGE)
  async list(@CurrentTenant() tenantId: string) {
    return this.display.list(tenantId);
  }

  @Delete('display-devices/:id')
  @RequirePermissions(PERMISSIONS.DISPLAY_MANAGE)
  async revoke(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.display.revoke(tenantId, id, meta(req, user));
  }
}

function meta(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const out: RequestMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) out.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') out.userAgent = ua.slice(0, 500);
  return out;
}
