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
import { Transform } from 'class-transformer';
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

  /**
   * Settable, correctable, and REMOVABLE.
   *
   * Three states, not two. `undefined` is "not part of this edit" and leaves
   * whatever is stored alone; a 10-digit number replaces it; `null` clears it.
   * Without the third an administrator who found a wrong number on a record
   * could only swap it for another wrong number — there was no way back to "we
   * do not have one", which is the honest state and often the true one.
   *
   * The form sends an empty string for that, because a cleared text input is
   * `''` and asking the UI to translate emptiness into `null` is how the two
   * ends drift. It is mapped here instead, once, next to the rule it serves.
   * `@IsOptional()` then skips the format check for null — that is its defined
   * behaviour for both null and undefined — so only a non-empty value is ever
   * matched against the pattern.
   */
  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? null : value))
  @Matches(/^[6-9]\d{9}$/, { message: 'mobile must be a 10-digit Indian mobile number' })
  mobile?: string | null;

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
 * holds — with one deliberate exception, `GET /users/approvers`, which returns
 * two columns and is explained on its own handler. Note what is NOT here: any
 * way to change what a role can do. The permission vocabulary is fixed in code
 * (packages/db/src/permissions.ts) — membership is tenant data, contents are
 * not.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * Who may be named as the person who authorised a discount.
   *
   * Id and display name of active staff. Nothing else — see the service, where
   * the narrow `select` is the actual control.
   *
   * Gated on `promotion:apply` rather than `user:manage`, which is the whole
   * point: the finance desk and the front desk have to name an approver and must
   * not be given the power to create accounts in order to do it. The administrator reaches it
   * too, by holding every permission.
   *
   * Declared BEFORE the `:id` routes. Nest matches in declaration order, and a
   * `@Get(':id')` added above this later would swallow `/users/approvers` and
   * answer it with a not-found for a patient id that is really the word
   * "approvers".
   */
  @Get('approvers')
  @RequirePermissions(PERMISSIONS.PROMOTION_APPLY)
  async approvers(@CurrentTenant() tenantId: string) {
    return this.users.approvers(tenantId);
  }

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
