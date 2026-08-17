import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/decorators.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { UsersService, type RequestMeta } from './users.service.js';

class CreateUserDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  fullName!: string;

  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, { message: 'mobile must be a 10-digit Indian mobile number' })
  mobile?: string;

  /** At least one — a user with no role can sign in and see nothing. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  roleKeys!: string[];
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, { message: 'mobile must be a 10-digit Indian mobile number' })
  mobile?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  roleKeys?: string[];
}

class SetActiveDto {
  @IsBoolean()
  isActive!: boolean;
}

/**
 * Staff accounts for one clinic.
 *
 * Everything here is behind `user:manage`, which only the administrator role
 * holds. Note what is NOT here: any way to change what a role can do. The
 * permission vocabulary is fixed in code (packages/db/src/permissions.ts) —
 * membership is tenant data, contents are not.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  async list(@CurrentTenant() tenantId: string) {
    return this.users.list(tenantId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  async create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateUserDto,
    @Req() req: FastifyRequest,
  ) {
    return this.users.create(
      tenantId,
      {
        email: dto.email,
        fullName: dto.fullName,
        ...(dto.mobile ? { mobile: dto.mobile } : {}),
        roleKeys: dto.roleKeys,
      },
      meta(req, user),
    );
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  async update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: FastifyRequest,
  ) {
    return this.users.update(
      tenantId,
      id,
      {
        ...(dto.fullName === undefined ? {} : { fullName: dto.fullName }),
        ...(dto.mobile === undefined ? {} : { mobile: dto.mobile }),
        ...(dto.roleKeys === undefined ? {} : { roleKeys: dto.roleKeys }),
      },
      meta(req, user),
    );
  }

  @Patch(':id/active')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  async setActive(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetActiveDto,
    @Req() req: FastifyRequest,
  ) {
    return this.users.setActive(tenantId, id, dto.isActive, meta(req, user));
  }

  /** A new temporary password, shown once. Ends the user's sessions. */
  @Post(':id/reset-password')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  async resetPassword(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.users.resetPassword(tenantId, id, meta(req, user));
  }
}

function meta(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const out: RequestMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) out.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') out.userAgent = ua.slice(0, 500);
  return out;
}
