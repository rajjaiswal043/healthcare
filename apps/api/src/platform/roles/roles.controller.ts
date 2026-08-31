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
import { ArrayUnique, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/decorators.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { RolesService } from './roles.service.js';

class CreateRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions!: string[];
}

class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];
}

/**
 * Roles and what they may do — all behind `role:manage`.
 *
 * Note there is no route that creates a PERMISSION. The catalogue is compiled
 * against by `@RequirePermissions`, so an administrator chooses from what the
 * code enforces and cannot invent one.
 */
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Every permission, grouped for the screen. */
  @Get('permissions')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  catalogue() {
    return this.roles.catalogue();
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  async list(@CurrentTenant() tenantId: string) {
    return this.roles.list(tenantId);
  }

  @Post('roles')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  async create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRoleDto,
    @Req() req: FastifyRequest,
  ) {
    return this.roles.create(tenantId, dto, meta(req, user));
  }

  /** Saving signs out everybody holding the role — the response says how many. */
  @Patch('roles/:id')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  async update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: FastifyRequest,
  ) {
    return this.roles.update(tenantId, id, dto, meta(req, user));
  }

  @Post('roles/:id/reset')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  async reset(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.roles.reset(tenantId, id, meta(req, user));
  }

  @Delete('roles/:id')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  async remove(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.roles.remove(tenantId, id, meta(req, user));
  }
}

interface RequestMeta {
  actorUserId: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

function meta(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const out: RequestMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) out.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') out.userAgent = ua.slice(0, 500);
  return out;
}
