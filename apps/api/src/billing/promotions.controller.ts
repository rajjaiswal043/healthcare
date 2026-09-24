import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../platform/auth/decorators.js';
import { PERMISSIONS } from '../platform/auth/permissions.js';
import { PromotionsService, type RequestMeta } from './promotions.service.js';
import {
  ApplyPromotionDto,
  CreatePromotionDto,
  ListPromotionsQueryDto,
  ReversePromotionDto,
  SetPromotionActiveDto,
  UpdatePromotionDto,
} from './promotion-dto.js';

function metaFrom(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  return {
    correlationId: req.id,
    ...(req.ip ? { ipAddress: req.ip } : {}),
    ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
    actorUserId: user.userId,
  };
}

/**
 * Promotions.
 *
 * There is no `DELETE /promotions/:id`, and there will not be. FR-PRO-01 is
 * explicit that a promotion is switched off and never removed, and the app role
 * has no DELETE privilege on the table either — an endpoint would fail at the
 * database even if somebody added one. `PATCH /promotions/:id/active` is the
 * delete.
 *
 * The one DELETE here, `/invoices/:id/promotion`, removes nothing: it writes a
 * compensating row. The verb describes what the desk is doing, not what the
 * database is doing.
 */
@Controller()
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  /**
   * The clinic's discounts.
   *
   * Read behind `invoice:read` rather than a new `promotion:read`. The finance
   * desk already holds it, an administrator holds everything, and a permission
   * whose only job is to gate a list that every biller needs would be one more
   * checkbox on the roles screen with no decision behind it. Defining and
   * applying are the acts worth separating, and both have their own permission.
   */
  @Get('promotions')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async list(@CurrentTenant() tenantId: string, @Query() query: ListPromotionsQueryDto) {
    return this.promotions.list(tenantId, query.applicable === 'true');
  }

  @Post('promotions')
  @RequirePermissions(PERMISSIONS.PROMOTION_MANAGE)
  async create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePromotionDto,
    @Req() req: FastifyRequest,
  ) {
    return this.promotions.create(tenantId, dto, metaFrom(req, user));
  }

  /** Refused once the promotion has been applied to anything — see the service. */
  @Patch('promotions/:id')
  @RequirePermissions(PERMISSIONS.PROMOTION_MANAGE)
  async update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePromotionDto,
    @Req() req: FastifyRequest,
  ) {
    return this.promotions.update(tenantId, id, dto, metaFrom(req, user));
  }

  @Patch('promotions/:id/active')
  @RequirePermissions(PERMISSIONS.PROMOTION_MANAGE)
  async setActive(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetPromotionActiveDto,
    @Req() req: FastifyRequest,
  ) {
    return this.promotions.setActive(tenantId, id, dto.isActive, metaFrom(req, user));
  }

  /**
   * Apply a promotion to a bill (FR-PRO-02).
   *
   * `promotion:apply`, which the finance desk, the front desk and the
   * administrator hold. Applying is not defining: this endpoint can only reach a
   * promotion somebody with `promotion:manage` already created.
   */
  @Post('invoices/:id/promotion')
  @RequirePermissions(PERMISSIONS.PROMOTION_APPLY)
  async apply(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApplyPromotionDto,
    @Req() req: FastifyRequest,
  ) {
    return this.promotions.apply(tenantId, id, dto, metaFrom(req, user));
  }

  /**
   * Take the discount back off, before any money has moved.
   *
   * DELETE by shape, an INSERT underneath: the compensating row is written and
   * nothing is removed. `promotion:apply`, the same permission as putting one
   * on — undoing your own typo within the same minute is part of applying a
   * discount, not a separate power, and the row records who did it either way.
   *
   * Note this is the only DELETE in this controller, and it deletes nothing.
   * A promotion itself is switched off, never removed.
   */
  @Delete('invoices/:id/promotion')
  @RequirePermissions(PERMISSIONS.PROMOTION_APPLY)
  async reverse(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReversePromotionDto,
    @Req() req: FastifyRequest,
  ) {
    return this.promotions.reverse(tenantId, id, dto, metaFrom(req, user));
  }
}
