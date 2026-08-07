import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { AvailabilityService } from './availability.service.js';
import {
  clinicToday,
  instantToLocalDate,
  instantToLocalTime,
  localToInstant,
} from './clinic-time.js';

export interface RequestMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
}

export interface AppointmentView {
  id: string;
  status: string;
  visitType: string;
  source: string;
  startAt: Date;
  endAt: Date;
  localTime: string;
  reasonForVisit: string | null;
  tokenNumber: number | null;
  checkedInAt: Date | null;
  calledAt: Date | null;
  completedAt: Date | null;
  patient: {
    id: string;
    uhid: string;
    name: string;
    mobile: string;
    gender: string;
    ageYears: number | null;
    birthDate: Date | null;
  };
  practitioner: { id: string; fullName: string; prefix: string | null; specialty: string | null };
}

const LIVE_STATUSES = ['BOOKED', 'ARRIVED', 'IN_PROGRESS'] as const;

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly availability: AvailabilityService,
    private readonly billing: BillingService,
  ) {}

  /** The clinic's IANA timezone — every wall-clock conversion depends on it. */
  private async timezone(tx: TenantClient, tenantId: string): Promise<string> {
    const t = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return t.timezone;
  }

  /**
   * Book a slot.
   *
   * Capacity is checked here for a good error message, but the real guarantee is
   * the partial unique index in the migration: "check then insert" is not atomic,
   * and two receptionists taking the last 10:15 slot would both pass the check.
   */
  async book(
    tenantId: string,
    input: {
      patientId: string;
      practitionerId: string;
      locationId: string;
      departmentId?: string;
      startAt: string;
      visitType?: string;
      reasonForVisit?: string;
    },
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const startAt = new Date(input.startAt);

      if (Number.isNaN(startAt.getTime())) {
        throw new BadRequestException('startAt is not a valid date-time');
      }

      const date = instantToLocalDate(startAt, tz);
      const time = instantToLocalTime(startAt, tz);

      // Ask the availability engine rather than re-deriving the rules here —
      // one source of truth for what "bookable" means.
      const day = await this.availability.forDay(tenantId, {
        practitionerId: input.practitionerId,
        date,
      });

      const slot = day.slots.find((s) => s.time === time);
      if (!slot) {
        throw new ConflictException({
          code: 'SLOT_NOT_AVAILABLE',
          message:
            day.unavailableReason ?? 'That time is not part of the doctor’s schedule for this day.',
        });
      }
      if (slot.available <= 0) {
        throw new ConflictException({ code: 'SLOT_FULL', message: 'That slot is fully booked.' });
      }

      const patient = await tx.patient.findUnique({
        where: { id: input.patientId },
        select: { id: true },
      });
      if (!patient) throw new NotFoundException('Patient not found');

      // Same patient, same doctor, same day, still live — almost always a
      // double-click or a second receptionist, not a genuine second visit.
      const dayStart = localToInstant(date, '00:00', tz);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const duplicate = await tx.appointment.findFirst({
        where: {
          patientId: input.patientId,
          practitionerId: input.practitionerId,
          startAt: { gte: dayStart, lt: dayEnd },
          status: { in: [...LIVE_STATUSES] },
        },
        select: { id: true, startAt: true },
      });

      if (duplicate) {
        throw new ConflictException({
          code: 'ALREADY_BOOKED',
          message: `This patient already has an appointment with this doctor at ${instantToLocalTime(duplicate.startAt, tz)} today.`,
          existingAppointmentId: duplicate.id,
        });
      }

      const created = await tx.appointment.create({
        data: {
          tenantId,
          patientId: input.patientId,
          practitionerId: input.practitionerId,
          locationId: input.locationId,
          departmentId: input.departmentId ?? null,
          startAt: slot.startAt,
          endAt: slot.endAt,
          status: 'BOOKED',
          visitType: (input.visitType ?? 'NEW') as never,
          source: 'FRONT_DESK',
          reasonForVisit: input.reasonForVisit ?? null,
          bookedByUserId: meta.actorUserId ?? null,
        },
        include: APPOINTMENT_INCLUDE,
      });

      // The bill comes into existence with the visit, in the same transaction.
      // Raising it later would leave a window in which an appointment exists
      // with nothing to pay against it — which, under a pay-first rule, is a
      // patient the front desk cannot admit.
      await this.billing.ensureInvoiceForAppointment(tx, tenantId, created.id, meta);

      await this.audit.record(tx, tenantId, {
        action: 'appointment.book',
        resourceType: 'Appointment',
        resourceId: created.id,
        patientId: created.patientId,
        changedFields: ['practitionerId', 'startAt', 'visitType'],
        ...meta,
      });

      return toView(created, tz);
    });
  }

  /**
   * Register a walk-in: create the appointment and check them in at once.
   *
   * A walk-in is an Appointment with source = WALK_IN and no prior slot, so the
   * doctor's worklist stays one query rather than a union of two record types.
   */
  async walkIn(
    tenantId: string,
    input: {
      patientId: string;
      practitionerId: string;
      locationId: string;
      departmentId?: string;
      reasonForVisit?: string;
      visitType?: string;
    },
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const now = new Date();
      const date = instantToLocalDate(now, tz);

      const patient = await tx.patient.findUnique({
        where: { id: input.patientId },
        select: { id: true },
      });
      if (!patient) throw new NotFoundException('Patient not found');

      const existing = await tx.appointment.findFirst({
        where: {
          patientId: input.patientId,
          practitionerId: input.practitionerId,
          queueDate: new Date(`${date}T00:00:00Z`),
          status: { in: [...LIVE_STATUSES] },
        },
        select: { id: true, tokenNumber: true },
      });

      if (existing) {
        throw new ConflictException({
          code: 'ALREADY_IN_QUEUE',
          message: `Already in this doctor's queue with token ${existing.tokenNumber ?? '—'}.`,
          existingAppointmentId: existing.id,
        });
      }

      /**
       * Created as BOOKED first, then admitted.
       *
       * A walk-in used to arrive already ARRIVED with a token. Under the
       * pay-first rule it cannot: the invoice needs the appointment to exist
       * before it can reference it, and the token must not be issued until that
       * invoice is settled. So the record is created, billed, and only then
       * admitted — and if there is money outstanding it stays BOOKED, with the
       * front desk collecting and checking in exactly as they would for a
       * booked patient who has just walked through the door.
       */
      const created = await tx.appointment.create({
        data: {
          tenantId,
          patientId: input.patientId,
          practitionerId: input.practitionerId,
          locationId: input.locationId,
          departmentId: input.departmentId ?? null,
          // A walk-in has no slot; the window is nominal and exists so the
          // record has a consistent shape with booked appointments.
          startAt: now,
          endAt: new Date(now.getTime() + 15 * 60 * 1000),
          status: 'BOOKED',
          visitType: (input.visitType ?? 'NEW') as never,
          source: 'WALK_IN',
          reasonForVisit: input.reasonForVisit ?? null,
          bookedByUserId: meta.actorUserId ?? null,
        },
        select: { id: true, patientId: true },
      });

      await this.billing.ensureInvoiceForAppointment(tx, tenantId, created.id, meta);
      const unpaid = await this.billing.blockingReason(tx, created.id);

      if (!unpaid) {
        const token = await this.allocateToken(tx, tenantId, input.practitionerId, date);
        await tx.appointment.update({
          where: { id: created.id },
          data: {
            status: 'ARRIVED',
            tokenNumber: token,
            queueDate: new Date(`${date}T00:00:00Z`),
            checkedInAt: now,
          },
        });
      }

      const admitted = await tx.appointment.findUniqueOrThrow({
        where: { id: created.id },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.walk_in',
        resourceType: 'Appointment',
        resourceId: created.id,
        patientId: created.patientId,
        changedFields: ['tokenNumber', 'status'],
        ...meta,
      });

      return toView(admitted, tz);
    });
  }

  /** Mark arrival and issue the token (FR-APT-08). */
  async checkIn(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      if (appt.status !== 'BOOKED') {
        throw new ConflictException({
          code: 'NOT_CHECKABLE',
          message: `This appointment is ${appt.status.toLowerCase().replace('_', ' ')}, so it cannot be checked in.`,
        });
      }

      /**
       * The pay-first gate (FR-BIL-04).
       *
       * No token until the visit is paid, waived or deferred. This is the point
       * where an unpaid visit is stopped, and the point is WHO it stops: the
       * receptionist, at the desk, with the patient in front of them — rather
       * than the doctor, with the patient already in the room and nothing to do
       * but send them back out.
       *
       * A clinic that has priced nothing has no invoice, and the gate stays
       * open. See BillingService.ensureInvoiceForAppointment.
       */
      const unpaid = await this.billing.blockingReason(tx, id);
      if (unpaid) {
        throw new ConflictException({ code: 'PAYMENT_REQUIRED', message: unpaid });
      }

      const now = new Date();
      const date = instantToLocalDate(now, tz);
      const token = await this.allocateToken(tx, tenantId, appt.practitionerId, date);

      const updated = await tx.appointment.update({
        where: { id },
        data: {
          status: 'ARRIVED',
          tokenNumber: token,
          queueDate: new Date(`${date}T00:00:00Z`),
          checkedInAt: now,
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.check_in',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: updated.patientId,
        changedFields: ['status', 'tokenNumber', 'checkedInAt'],
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  /** Doctor calls the next patient in. */
  async call(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.transition(tenantId, id, 'ARRIVED', 'IN_PROGRESS', { calledAt: new Date() }, meta);
  }

  /** Visit finished. */
  async complete(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.transition(
      tenantId,
      id,
      'IN_PROGRESS',
      'FULFILLED',
      { completedAt: new Date() },
      meta,
    );
  }

  async cancel(
    tenantId: string,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      if (appt.status === 'FULFILLED') {
        throw new ConflictException({
          code: 'ALREADY_COMPLETED',
          message: 'A completed visit cannot be cancelled.',
        });
      }

      const updated = await tx.appointment.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: reason,
          cancelledByUserId: meta.actorUserId ?? null,
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.cancel',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: updated.patientId,
        changedFields: ['status', 'cancelReason'],
        reason,
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  /** Did not turn up (FR-APT-09). */
  async markNoShow(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.transition(tenantId, id, 'BOOKED', 'NO_SHOW', { noShowAt: new Date() }, meta);
  }

  /**
   * Move an appointment to a different slot.
   *
   * Implemented as cancel-then-book rather than an UPDATE of start_at, so the
   * new slot goes through the same availability and capacity checks as any other
   * booking, and the original remains in the record with its reason.
   */
  async reschedule(
    tenantId: string,
    id: string,
    input: { startAt: string; reason: string },
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.appointment.findUnique({ where: { id } }),
    );
    if (!existing) throw new NotFoundException('Appointment not found');

    if (existing.status !== 'BOOKED') {
      throw new ConflictException({
        code: 'NOT_RESCHEDULABLE',
        message: 'Only a booked appointment that has not yet arrived can be moved.',
      });
    }

    await this.cancel(tenantId, id, `Rescheduled: ${input.reason}`, meta);

    return this.book(
      tenantId,
      {
        patientId: existing.patientId,
        practitionerId: existing.practitionerId,
        locationId: existing.locationId,
        ...(existing.departmentId ? { departmentId: existing.departmentId } : {}),
        startAt: input.startAt,
        visitType: existing.visitType,
        ...(existing.reasonForVisit ? { reasonForVisit: existing.reasonForVisit } : {}),
      },
      meta,
    );
  }

  /**
   * The live queue for one doctor.
   *
   * Ordered by token, which is arrival order — not by appointment time. Someone
   * who booked 11:00 but arrived at 09:30 is seen before someone who booked
   * 09:45 and is still in traffic, which is how the room actually works.
   */
  async queue(tenantId: string, practitionerId: string, date?: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const day = date ?? clinicToday(tz);
      const queueDate = new Date(`${day}T00:00:00Z`);

      const rows = await tx.appointment.findMany({
        where: {
          practitionerId,
          OR: [
            { queueDate },
            {
              startAt: {
                gte: localToInstant(day, '00:00', tz),
                lt: new Date(localToInstant(day, '00:00', tz).getTime() + 86400000),
              },
            },
          ],
        },
        include: APPOINTMENT_INCLUDE,
        orderBy: [{ tokenNumber: 'asc' }, { startAt: 'asc' }],
      });

      const views = rows.map((r) => toView(r, tz));

      const waiting = views.filter((v) => v.status === 'ARRIVED');
      const inProgress = views.find((v) => v.status === 'IN_PROGRESS') ?? null;
      const completed = views.filter((v) => v.status === 'FULFILLED');

      return {
        date: day,
        timezone: tz,
        nowServing: inProgress,
        waiting,
        yetToArrive: views.filter((v) => v.status === 'BOOKED'),
        completed,
        cancelled: views.filter((v) => v.status === 'CANCELLED' || v.status === 'NO_SHOW'),
        stats: {
          total: views.length,
          waiting: waiting.length,
          completed: completed.length,
          /**
           * Mean minutes from check-in to being called, over patients already
           * seen today. Null until at least one has been — an average of nothing
           * displayed as "0 min wait" is a lie the front desk will repeat to
           * patients.
           */
          averageWaitMinutes: averageWait(views),
        },
      };
    });
  }

  /** Everything for a doctor on a date, for their own day list. */
  async dayList(tenantId: string, practitionerId: string, date?: string) {
    return this.queue(tenantId, practitionerId, date);
  }

  // --- internals -----------------------------------------------------------

  private async transition(
    tenantId: string,
    id: string,
    from: string,
    to: string,
    extra: Record<string, unknown>,
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      if (appt.status !== from) {
        throw new ConflictException({
          code: 'INVALID_TRANSITION',
          message: `Expected the appointment to be ${from.toLowerCase()}, but it is ${appt.status.toLowerCase()}.`,
        });
      }

      const updated = await tx.appointment.update({
        where: { id },
        data: { status: to as never, ...extra },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: `appointment.${to.toLowerCase()}`,
        resourceType: 'Appointment',
        resourceId: id,
        patientId: updated.patientId,
        changedFields: ['status'],
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  /**
   * Atomic token allocation. See next_queue_token() in the migration for why
   * this cannot be `SELECT max(token) + 1`.
   */
  private async allocateToken(
    tx: TenantClient,
    tenantId: string,
    practitionerId: string,
    date: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ next_queue_token: number }>>`
      SELECT next_queue_token(${tenantId}::uuid, ${practitionerId}::uuid, ${date}::date)
    `;

    const token = rows[0]?.next_queue_token;
    if (typeof token !== 'number') {
      throw new Error('Token allocation returned no result — is the scheduling migration applied?');
    }
    return token;
  }
}

const APPOINTMENT_INCLUDE = {
  patient: {
    select: {
      id: true,
      uhid: true,
      name: true,
      mobile: true,
      gender: true,
      ageYears: true,
      birthDate: true,
    },
  },
  practitioner: {
    select: { id: true, fullName: true, prefix: true, specialty: true },
  },
} as const;

type AppointmentWithRelations = Parameters<typeof toView>[0];

function toView(
  a: {
    id: string;
    status: string;
    visitType: string;
    source: string;
    startAt: Date;
    endAt: Date;
    reasonForVisit: string | null;
    tokenNumber: number | null;
    checkedInAt: Date | null;
    calledAt: Date | null;
    completedAt: Date | null;
    patientId: string;
    patient: AppointmentView['patient'];
    practitioner: AppointmentView['practitioner'];
  },
  tz: string,
): AppointmentView {
  return {
    id: a.id,
    status: a.status,
    visitType: a.visitType,
    source: a.source,
    startAt: a.startAt,
    endAt: a.endAt,
    localTime: instantToLocalTime(a.startAt, tz),
    reasonForVisit: a.reasonForVisit,
    tokenNumber: a.tokenNumber,
    checkedInAt: a.checkedInAt,
    calledAt: a.calledAt,
    completedAt: a.completedAt,
    patient: a.patient,
    practitioner: a.practitioner,
  };
}

function averageWait(views: AppointmentView[]): number | null {
  const seen = views.filter((v) => v.checkedInAt && v.calledAt);
  if (seen.length === 0) return null;

  const total = seen.reduce(
    (sum, v) => sum + ((v.calledAt as Date).getTime() - (v.checkedInAt as Date).getTime()),
    0,
  );
  return Math.round(total / seen.length / 60000);
}

export type { AppointmentWithRelations };
