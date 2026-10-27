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
import { PrismaService } from '../platform/database/prisma.service.js';
import { AvailabilityService } from './availability.service.js';
import { AppointmentsService, type RequestMeta } from './appointments.service.js';
import { DayBoardService } from './day-board.service.js';
import {
  AvailabilityQueryDto,
  BookAppointmentDto,
  CancelAppointmentDto,
  PrioritiseDto,
  DayBoardQueryDto,
  QueueQueryDto,
  RescheduleAppointmentDto,
  ReturnFromTestsDto,
  SendForTestsDto,
  WalkInDto,
} from './dto.js';

@Controller()
export class SchedulingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly appointments: AppointmentsService,
    private readonly dayBoard: DayBoardService,
  ) {}

  // --- masters -------------------------------------------------------------

  /**
   * Doctors.
   *
   * THERE IS NO `GET /departments` ANY MORE, and no `departmentId` filter here.
   * A department is a place that does tests; booking never had a use for one.
   * The list it served narrowed four doctors by departments a seed invented,
   * and `specialty` — which this does return — is what somebody choosing a
   * doctor actually reads. Test departments are served by
   * `GET /diagnostics/departments`.
   */
  @Get('practitioners')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_READ)
  async practitioners(@CurrentTenant() tenantId: string) {
    const practitioners = await this.prisma.forTenant(tenantId, (tx) =>
      tx.practitioner.findMany({
        where: { isActive: true },
        orderBy: { fullName: 'asc' },
        select: {
          id: true,
          fullName: true,
          prefix: true,
          specialty: true,
          qualification: true,
          registrationNumber: true,
          /**
           * The doctor's own consultation fee, so a screen choosing a doctor can
           * show what the visit will cost before it commits to one.
           *
           * Not sensitive: it is printed on every bill and every receipt the
           * patient is handed. `followUpFeePaise` is deliberately NOT here — the
           * only caller that needs a price is the finance desk, which always
           * opens a NEW consultation.
           */
          consultationFeePaise: true,
        },
      }),
    );
    return { practitioners };
  }

  /** Locations, for choosing where the visit happens. */
  @Get('locations')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_READ)
  async locations(@CurrentTenant() tenantId: string) {
    const locations = await this.prisma.forTenant(tenantId, (tx) =>
      tx.location.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, city: true },
      }),
    );
    return { locations };
  }

  // --- availability --------------------------------------------------------

  @Get('availability')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_READ)
  async availabilityForDay(
    @CurrentTenant() tenantId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.availability.forDay(tenantId, query);
  }

  // --- appointments --------------------------------------------------------

  @Post('appointments')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async book(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BookAppointmentDto,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.book(tenantId, dto, metaFrom(req, user));
  }

  /**
   * A patient who is here now, for a doctor who is consulting now.
   *
   * Guarded by `visit:open` rather than `appointment:write` since 5 Sep 2026.
   * Opening today's visit and holding the clinic's diary are two different
   * powers, and they were one permission — which meant a finance desk that
   * needed the first could only be given it by also handing over the second.
   * The front desk and the administrator hold both and lost nothing.
   */
  @Post('appointments/walk-in')
  @RequirePermissions(PERMISSIONS.VISIT_OPEN)
  async walkIn(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WalkInDto,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.walkIn(tenantId, dto, metaFrom(req, user));
  }

  @Patch('appointments/:id/check-in')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async checkIn(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.checkIn(tenantId, id, metaFrom(req, user));
  }

  @Patch('appointments/:id/call')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async call(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.call(tenantId, id, metaFrom(req, user));
  }

  /**
   * Send the patient out for an X-ray without ending the visit (FR-APT-14).
   *
   * Behind `appointment:write` rather than a clinical permission: it is a queue
   * movement, and the nurse — who is read-only on the queue — should not be
   * making it.
   */
  @Patch('appointments/:id/send-for-tests')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async sendForTests(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendForTestsDto,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.sendForTests(tenantId, id, dto.reason, metaFrom(req, user));
  }

  /** Back at the desk with the report (FR-APT-15). */
  @Patch('appointments/:id/return')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async returnFromTests(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReturnFromTestsDto,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.returnFromTests(
      tenantId,
      id,
      { seeNext: dto.seeNext, ...(dto.note ? { note: dto.note } : {}) },
      metaFrom(req, user),
    );
  }

  /**
   * Say the visit is over.
   *
   * `appointment:write` rather than anything clinical: closing is the front
   * desk sending somebody home, not a clinical judgement. The doctor's own
   * sign-off is FULFILLED and happens earlier.
   */
  @Patch('appointments/:id/close')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async closeVisit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.closeVisit(tenantId, id, metaFrom(req, user));
  }

  /**
   * Undo a close, for the row somebody pressed by mistake.
   *
   * The same `appointment:write` as closing. Both events stay in the audit
   * log, so the history shows the correction rather than hiding it.
   */
  @Patch('appointments/:id/reopen')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async reopenVisit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.reopenVisit(tenantId, id, metaFrom(req, user));
  }

  /**
   * Move a waiting patient to the front (FR-APT-16).
   *
   * Its own permission, because this is the one queue action a whole waiting
   * room can see the effect of.
   */
  @Patch('appointments/:id/priority')
  @RequirePermissions(PERMISSIONS.QUEUE_PRIORITISE)
  async prioritise(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PrioritiseDto,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.flagToBeSeenNext(
      tenantId,
      id,
      { reasonCode: dto.reasonCode, ...(dto.note ? { note: dto.note } : {}) },
      metaFrom(req, user),
    );
  }

  /** Undo the flag — a mis-click must not cost the patient their token. */
  @Delete('appointments/:id/priority')
  @RequirePermissions(PERMISSIONS.QUEUE_PRIORITISE)
  async clearPriority(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.clearPriority(tenantId, id, metaFrom(req, user));
  }

  @Patch('appointments/:id/complete')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async complete(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.complete(tenantId, id, metaFrom(req, user));
  }

  @Patch('appointments/:id/no-show')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async noShow(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.markNoShow(tenantId, id, metaFrom(req, user));
  }

  @Patch('appointments/:id/cancel')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_CANCEL)
  async cancel(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelAppointmentDto,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.cancel(tenantId, id, dto.reason, metaFrom(req, user));
  }

  @Patch('appointments/:id/reschedule')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_WRITE)
  async reschedule(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RescheduleAppointmentDto,
    @Req() req: FastifyRequest,
  ) {
    return this.appointments.reschedule(tenantId, id, dto, metaFrom(req, user));
  }

  // --- the queue -----------------------------------------------------------

  /**
   * A doctor's queue is their own. See `assertMayReadQueue` for the rule and
   * why it is expressed as "is this user a practitioner" rather than as a role.
   */
  @Get('queue')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_READ)
  async queue(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueueQueryDto,
  ) {
    await this.appointments.assertMayReadQueue(tenantId, user, query.practitionerId);
    return this.appointments.queue(tenantId, query.practitionerId, query.date);
  }

  /**
   * Everybody in the clinic today, one row per patient — the home screen.
   *
   * No `practitionerId`: unlike the queue, this is not a question about one
   * doctor. Who the caller may see is decided from the caller, by the same rule
   * the queue applies — a doctor gets their own patients, the desk gets
   * everyone. Taking an id here would invite a doctor to ask for somebody
   * else's and get a 403 for a screen that never offered them the choice.
   */
  @Get('day-board')
  @RequirePermissions(PERMISSIONS.APPOINTMENT_READ)
  async dayBoardForToday(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DayBoardQueryDto,
  ) {
    return this.dayBoard.forDay(tenantId, user, query.date);
  }
}

function metaFrom(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const meta: RequestMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) meta.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua.slice(0, 500);
  return meta;
}
