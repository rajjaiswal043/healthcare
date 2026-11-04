import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { PERMISSIONS } from '../platform/auth/permissions.js';
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
  /** Identity, not position. Held from booking onwards. */
  tokenNumber: number | null;
  /** When they became ready to be seen. What the waiting list sorts on. */
  readyAt: Date | null;
  /** Set when this visit has been flagged to be seen next. */
  priority: { reasonCode: string; note: string | null; setAt: Date } | null;
  /** Set while the patient is out for an investigation. */
  sentOut: { at: Date; reason: string } | null;
  returnedAt: Date | null;
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

/** What a booking needs — from the front desk, or from a reschedule. */
type BookInput = {
  patientId: string;
  practitionerId: string;
  locationId: string;
  startAt: string;
  visitType?: string;
  reasonForVisit?: string;
};

/**
 * A visit the clinic is still dealing with, for the "already in this queue"
 * guard on booking and on walk-in.
 *
 * `AWAITING_TESTS` was missing until 28 Oct 2026, and the hole was reported
 * from the clinic: the moment a doctor sent somebody for an X-ray this guard
 * stopped seeing them, so the front desk could add the same patient to the same
 * doctor a second time. They came back from the test and the queue showed one
 * person being served AND waiting — two live appointments, two tokens and two
 * consultation bills for one visit.
 *
 * Out at a department is not out of the clinic. The states that end a visit are
 * FULFILLED, CANCELLED and NO_SHOW; everything else is somebody the clinic
 * still has in its hands.
 */
const LIVE_STATUSES = ['BOOKED', 'ARRIVED', 'IN_PROGRESS', 'AWAITING_TESTS'] as const;

/**
 * A patient already somewhere else at this hour, whoever they are with.
 *
 * The duplicate checks either side of this are scoped to ONE DOCTOR — they ask
 * "is this patient already with Dr Rao today", never "is this patient already
 * booked at all". So the same person could be put in three rooms at ten
 * o'clock with three different consultants, which produced three tokens, three
 * consultation bills and a Collect button reading "1 of 3". Reported from the
 * clinic, 29 Oct 2026.
 *
 * OVERLAP, not "same day". A patient seeing an orthopaedic consultant at 10:00
 * and a physiotherapist at 11:30 is an ordinary morning and must keep working;
 * the same patient in two rooms at 10:00 is not a booking, it is a mistake.
 * Narveer's call, 29 Oct 2026.
 *
 * Half-open on both sides: a 10:00-10:15 slot and a 10:15-10:30 one touch at
 * the boundary and do not overlap, which is what back-to-back means.
 */
async function patientBusyBetween(
  tx: TenantClient,
  patientId: string,
  startAt: Date,
  endAt: Date,
  ignoreAppointmentId?: string,
) {
  return tx.appointment.findFirst({
    where: {
      patientId,
      status: { in: [...LIVE_STATUSES] },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(ignoreAppointmentId ? { id: { not: ignoreAppointmentId } } : {}),
    },
    select: {
      id: true,
      startAt: true,
      practitioner: { select: { fullName: true } },
    },
  });
}

/**
 * The visits the "In the queue" tile counts: every one whose day is not over —
 * yet to arrive, waiting, in the room, out for tests.
 *
 * Listed state by state rather than as "everything except FULFILLED, CANCELLED
 * and NO_SHOW", so a status added to the enum later is left out until somebody
 * decides it belongs here, instead of being counted by default.
 */
const IN_QUEUE: ReadonlySet<string> = new Set([
  'BOOKED',
  'ARRIVED',
  'IN_PROGRESS',
  'AWAITING_TESTS',
]);

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
  async book(tenantId: string, input: BookInput, meta: RequestMeta): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, (tx) => this.bookIn(tx, tenantId, input, meta));
  }

  /**
   * The booking itself, in a transaction the caller holds — so a reschedule
   * can cancel and book as one act, and every check below (the doctor's lock,
   * the slot, the duplicate) runs where the insert does.
   */
  private async bookIn(
    tx: TenantClient,
    tenantId: string,
    input: BookInput,
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    // First, and in the transaction that inserts: see lockBookablePractitioner.
    await lockBookablePractitioner(tx, input.practitionerId);

    const tz = await this.timezone(tx, tenantId);
    const startAt = new Date(input.startAt);

    if (Number.isNaN(startAt.getTime())) {
      throw new BadRequestException('startAt is not a valid date-time');
    }

    const date = instantToLocalDate(startAt, tz);
    const time = instantToLocalTime(startAt, tz);

    // Ask the availability engine rather than re-deriving the rules here —
    // one source of truth for what "bookable" means.
    const day = await this.availability.forDayIn(tx, tenantId, {
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
    /**
     * Checked before capacity, because a finished slot is not a full one.
     *
     * The availability engine already reports `available: 0` for a slot that
     * has ended, so without this the refusal below would tell a receptionist
     * the 09:00 slot is "fully booked" at two in the afternoon — and send them
     * looking for a cancellation that was never the problem.
     *
     * The line sits at the slot's END, matching the engine: a patient three
     * minutes into their 14:00 appointment can still be booked in.
     */
    if (slot.past) {
      throw new ConflictException({
        code: 'SLOT_IN_THE_PAST',
        message:
          'That appointment time has already passed. Pick a later slot, or add the ' +
          'patient to today’s queue as a walk-in.',
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

    /* And with anybody else. See `patientBusyBetween` — the check above only
       ever looked at this one doctor. */
    const clash = await patientBusyBetween(tx, input.patientId, slot.startAt, slot.endAt);
    if (clash) {
      throw new ConflictException({
        code: 'PATIENT_DOUBLE_BOOKED',
        message:
          `This patient is already with ${clash.practitioner?.fullName ?? 'another doctor'} ` +
          `at ${instantToLocalTime(clash.startAt, tz)}. They cannot be in two places at once — ` +
          'pick a time that does not overlap.',
        existingAppointmentId: clash.id,
      });
    }

    /**
     * The token is issued here, at booking — not at check-in.
     *
     * Allocated after the capacity and duplicate checks so a refused booking
     * does not consume a number, and before the INSERT so the row is never
     * briefly tokenless. A cancellation still leaves a gap in the series, and
     * that is fine: a token is an identifier, not a receipt number. Renumbering
     * to close a gap would move a token out from under a patient already
     * holding a slip with it printed.
     */
    const token = await this.allocateToken(tx, tenantId, input.practitionerId, date);

    const created = await tx.appointment.create({
      data: {
        tenantId,
        patientId: input.patientId,
        practitionerId: input.practitionerId,
        locationId: input.locationId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        status: 'BOOKED',
        visitType: (input.visitType ?? 'NEW') as never,
        source: 'FRONT_DESK',
        reasonForVisit: input.reasonForVisit ?? null,
        bookedByUserId: meta.actorUserId ?? null,
        tokenNumber: token,
        // The token belongs to the day of the visit, in clinic time — not to
        // the day the booking was taken, which may be weeks earlier.
        queueDate: new Date(`${date}T00:00:00Z`),
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
      changedFields: ['practitionerId', 'startAt', 'visitType', 'tokenNumber'],
      ...meta,
    });

    return toView(created, tz);
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
      reasonForVisit?: string;
      visitType?: string;
    },
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      // A walk-in has no slot, so the availability engine never sees it — this
      // is the only thing between a switched-off doctor and a new patient.
      await lockBookablePractitioner(tx, input.practitionerId);

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

      /*
       * And with anybody else. A walk-in is now, for the next fifteen minutes,
       * so it clashes with whoever has this patient at this moment — including
       * somebody they are sitting in front of. See `patientBusyBetween`.
       */
      const walkInEnd = new Date(now.getTime() + 15 * 60 * 1000);
      const clash = await patientBusyBetween(tx, input.patientId, now, walkInEnd);
      if (clash) {
        throw new ConflictException({
          code: 'PATIENT_DOUBLE_BOOKED',
          message:
            `This patient is already with ${clash.practitioner?.fullName ?? 'another doctor'} ` +
            `at ${instantToLocalTime(clash.startAt, tz)}. Finish or cancel that visit first.`,
          existingAppointmentId: clash.id,
        });
      }

      /**
       * Created as BOOKED first, then admitted.
       *
       * The token comes with the record — a walk-in is registered and booked in
       * the same act, so there is no moment at which they are a patient without
       * a number. What the money still governs is the WAITING LIST: if there is
       * anything outstanding the visit stays BOOKED with its token, and the
       * front desk collects and checks them in exactly as for a booked patient
       * who has just walked through the door.
       */
      const token = await this.allocateToken(tx, tenantId, input.practitionerId, date);

      const created = await tx.appointment.create({
        data: {
          tenantId,
          patientId: input.patientId,
          practitionerId: input.practitionerId,
          locationId: input.locationId,
          // A walk-in has no slot; the window is nominal and exists so the
          // record has a consistent shape with booked appointments.
          startAt: now,
          endAt: new Date(now.getTime() + 15 * 60 * 1000),
          status: 'BOOKED',
          visitType: (input.visitType ?? 'NEW') as never,
          source: 'WALK_IN',
          reasonForVisit: input.reasonForVisit ?? null,
          bookedByUserId: meta.actorUserId ?? null,
          tokenNumber: token,
          queueDate: new Date(`${date}T00:00:00Z`),
        },
        select: { id: true, patientId: true },
      });

      await this.billing.ensureInvoiceForAppointment(tx, tenantId, created.id, meta);
      const unpaid = await this.billing.blockingReason(tx, created.id);

      if (!unpaid) {
        await tx.appointment.update({
          where: { id: created.id },
          data: {
            status: 'ARRIVED',
            checkedInAt: now,
            readyAt: now,
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

  /**
   * Mark arrival and admit the patient to the waiting list (FR-APT-08).
   *
   * This no longer issues the token — booking did that. What check-in does now
   * is give the visit a POSITION: `readyAt` is the moment the patient became
   * ready to be seen, and the waiting list sorts on it.
   */
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
       * No PLACE IN THE QUEUE until the visit is paid, waived or deferred. The
       * rule used to be phrased as "no token", which stopped being true when
       * tokens moved to booking — but the gate itself has not moved, and neither
       * has the reason for its position: it stops the visit at the desk, in
       * front of the receptionist with a card machine to hand, rather than at
       * the door of the consulting room with nothing to do but send the patient
       * back out.
       *
       * A clinic that has priced nothing has no invoice, and the gate stays
       * open. See BillingService.ensureInvoiceForAppointment.
       */
      const unpaid = await this.billing.blockingReason(tx, id);
      if (unpaid) {
        throw new ConflictException({ code: 'PAYMENT_REQUIRED', message: unpaid });
      }

      const now = new Date();

      /**
       * Appointments booked before this rule changed carry no token, and so do
       * rows written straight into the database by a seed. Issuing one here
       * keeps them workable instead of putting a tokenless patient on the board
       * — the migration backfills the diary, and this covers whatever it missed.
       */
      const date = instantToLocalDate(appt.startAt, tz);
      const token =
        appt.tokenNumber ?? (await this.allocateToken(tx, tenantId, appt.practitionerId, date));

      const updated = await tx.appointment.update({
        where: { id },
        data: {
          status: 'ARRIVED',
          tokenNumber: token,
          queueDate: appt.queueDate ?? new Date(`${date}T00:00:00Z`),
          checkedInAt: now,
          readyAt: now,
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.check_in',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: updated.patientId,
        changedFields: ['status', 'checkedInAt', 'readyAt'],
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  /** Doctor calls the next patient in. */
  async call(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.transition(tenantId, id, 'ARRIVED', 'IN_PROGRESS', { calledAt: new Date() }, meta);
  }

  /**
   * Send the patient out for an X-ray or a test, without ending the visit
   * (FR-APT-14).
   *
   * The consultation stays a draft and the bill stays as it is — this is a
   * pause, not a discharge. Signing the note would end the visit, which is
   * exactly what the doctor does NOT want when they are waiting for a film.
   *
   * The patient leaves the waiting list: `readyAt` is cleared, because they are
   * not ready to be seen while they are down the corridor. It is re-stamped
   * when they come back, and that is what puts them back in the ordering.
   */
  async sendForTests(
    tenantId: string,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      // Only from the room. Sending out someone the doctor has not yet seen is
      // not this feature — that patient is simply still waiting.
      if (appt.status !== 'IN_PROGRESS') {
        throw new ConflictException({
          code: 'NOT_IN_CONSULTATION',
          message: 'Only a patient currently with the doctor can be sent for tests.',
        });
      }

      const updated = await tx.appointment.update({
        where: { id },
        data: {
          status: 'AWAITING_TESTS',
          sentOutAt: new Date(),
          sentOutReason: reason,
          // A second leg — X-ray, then bloods — starts from a clean return.
          returnedAt: null,
          readyAt: null,
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.send_for_tests',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: updated.patientId,
        changedFields: ['status', 'sentOutAt', 'sentOutReason'],
        reason,
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  /**
   * The patient is back at the desk with their report (FR-APT-15).
   *
   * Where they land is a decision, not a rule — Narveer's call on 12 Aug 2026.
   * `seeNext` is the ordinary case and the default at the desk: they have
   * already waited once. Declining it puts them behind everyone currently
   * waiting, which is what the desk chooses when the doctor is mid-consultation
   * and the report is not urgent.
   *
   * Either way they keep their token, their draft note and their invoice.
   */
  /**
   * Say the visit is over.
   *
   * THE DIFFERENCE FROM `FULFILLED`. That status is the doctor's sign-off and
   * nothing more. The patient may still be in the building — waiting on a film,
   * waiting to pay, waiting to be told they can go — and until this was
   * recorded the board called that "Done" and the front desk had no queue of
   * people still here. Closing is the desk's act, not the clinician's.
   *
   * ONLY FROM FULFILLED. A visit still in progress, or one the patient was sent
   * out of, has something left to happen; closing it would strand whatever that
   * is. Refused rather than quietly ignored, because the caller believes they
   * finished something.
   *
   * MONEY IS NOT CHECKED HERE, deliberately (Narveer, 22 Oct 2026). The desk is
   * the one standing in front of the patient and "they will settle it at the
   * follow-up" is a real answer a clinic gives. The board shows what is owed
   * before the button and the bill stays open afterwards, so nothing is lost —
   * what would be lost is the desk's ability to send somebody home.
   *
   * Closing twice is refused: the second caller would overwrite who closed it
   * and when, which is the only thing this column is for.
   */
  async closeVisit(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      if (appt.closedAt) {
        throw new ConflictException({
          code: 'ALREADY_CLOSED',
          message: 'This visit has already been closed.',
        });
      }

      /**
       * WHICH STAGES MAY BE CLOSED — Narveer's call, 2 Nov 2026.
       *
       * Closing used to require FULFILLED, and that was the whole of the
       * "cannot end the patient's journey" report. A visit abandoned halfway
       * had no way out at all: the doctor never pressed OPD done, so the
       * status stayed IN_PROGRESS or AWAITING_TESTS forever and every button
       * on the row was refused.
       *
       * So: any stage where a visit actually started may be closed. What is
       * refused is the three where there is nothing to close — a booking
       * nobody kept, one already written off, and one already cancelled.
       *
       * THE STATUS IS NOT TOUCHED by closing. `closed_at` says the patient
       * left; the status says how far the visit got. That is the 22 Oct split,
       * and collapsing the two here would record that a doctor finished a
       * consultation they actually abandoned.
       */
      const CLOSEABLE = ['IN_PROGRESS', 'AWAITING_TESTS', 'FULFILLED'];
      if (!CLOSEABLE.includes(appt.status)) {
        throw new ConflictException({
          code: 'NOT_STARTED',
          message:
            appt.status === 'BOOKED'
              ? 'This patient never checked in, so there is no visit to close.'
              : `A visit that is ${appt.status.toLowerCase().replace('_', ' ')} cannot be closed.`,
        });
      }

      /**
       * A PENDING TEST NO LONGER BLOCKS THE CLOSE.
       *
       * It used to, and the reasoning was sound on its own terms: closing here
       * leaves a film nobody is waiting for. But it made "At a department" a
       * dead end, which is the state a patient is most likely to walk out of —
       * they are told to go for an X-ray, they go home instead, and the desk
       * was left with a row it could not clear by any route.
       *
       * The order is deliberately left PENDING rather than cancelled. What was
       * asked for is a clinical record, and closing a visit is not the same
       * decision as withdrawing a request. The board now shows the way out of
       * the test beside the way out of the visit, so the desk can do both —
       * see `secondaryStep` and the two slots it fills.
       */

      const updated = await tx.appointment.update({
        where: { id },
        data: { closedAt: new Date(), closedByUserId: meta.actorUserId ?? null },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.close',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: appt.patientId,
        changedFields: ['closedAt', 'closedByUserId'],
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  /**
   * Undo a close.
   *
   * CLOSING IS A PRESS, SO IT CAN BE A MISPRESS. The board shows a list of
   * patients and the button that ends a visit sits on every finished row; the
   * clinic reported closing the wrong one, and until now the only way back was
   * an edit to the database. A recorded decision has to be correctable by the
   * people who record it, or they stop trusting the record.
   *
   * THE TRAIL KEEPS BOTH EVENTS. `closed_at` is cleared, but `appointment.close`
   * and `appointment.reopen` both stand in the audit log — so the history reads
   * "closed at 4:05, reopened at 4:06 by Asha", which is the truth, rather than
   * a visit that was never closed at all.
   *
   * Same permission as closing: whoever may end a visit may un-end one. The
   * front desk makes this mistake most often, and sending them to find an
   * administrator for a thirty-second slip is how a workaround gets invented.
   */
  async reopenVisit(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      if (!appt.closedAt) {
        throw new ConflictException({
          code: 'NOT_CLOSED',
          message: 'This visit is already open.',
        });
      }

      const updated = await tx.appointment.update({
        where: { id },
        data: { closedAt: null, closedByUserId: null },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.reopen',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: appt.patientId,
        changedFields: ['closedAt', 'closedByUserId'],
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  async returnFromTests(
    tenantId: string,
    id: string,
    input: { seeNext: boolean; note?: string },
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      if (appt.status !== 'AWAITING_TESTS') {
        throw new ConflictException({
          code: 'NOT_AWAY',
          message: 'This patient was not sent for tests, so there is nothing to bring back.',
        });
      }

      const now = new Date();

      const updated = await tx.appointment.update({
        where: { id },
        data: {
          status: 'ARRIVED',
          returnedAt: now,
          readyAt: now,
          ...(input.seeNext
            ? {
                priorityReasonCode: 'BACK_FROM_TESTS',
                priorityNote: input.note ?? null,
                prioritySetAt: now,
                prioritySetByUserId: meta.actorUserId ?? null,
              }
            : {}),
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.return_from_tests',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: updated.patientId,
        changedFields: input.seeNext
          ? ['status', 'returnedAt', 'readyAt', 'priorityReasonCode']
          : ['status', 'returnedAt', 'readyAt'],
        reason: input.seeNext ? 'Back from tests, to be seen next' : 'Back from tests, queued',
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  /**
   * Move a waiting patient to the front (FR-APT-16).
   *
   * Both the front desk and the doctor hold `queue:prioritise`, and both are
   * recorded. The reason is a code rather than free text because this field is
   * read by someone judging whether the jump was legitimate — and "urgent!!"
   * cannot be counted.
   *
   * `prioritySetAt` is stamped now, which is what orders flagged patients among
   * themselves: first flagged, first served. A later emergency queues behind a
   * recall that was already promised "you are next" rather than displacing it.
   */
  async flagToBeSeenNext(
    tenantId: string,
    id: string,
    input: { reasonCode: string; note?: string },
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    const setBy = meta.actorUserId;
    if (!setBy) throw new BadRequestException('A priority needs an author.');

    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      // Only someone in the waiting list has a position to change. Flagging a
      // patient who has not arrived would promise a place they do not hold.
      if (appt.status !== 'ARRIVED') {
        throw new ConflictException({
          code: 'NOT_WAITING',
          message: 'Only a patient waiting to be seen can be moved up the queue.',
        });
      }

      const updated = await tx.appointment.update({
        where: { id },
        data: {
          priorityReasonCode: input.reasonCode as never,
          priorityNote: input.note ?? null,
          prioritySetAt: new Date(),
          prioritySetByUserId: setBy,
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.prioritise',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: updated.patientId,
        changedFields: ['priorityReasonCode', 'prioritySetAt'],
        reason: input.note ? `${input.reasonCode}: ${input.note}` : input.reasonCode,
        ...meta,
      });

      return toView(updated, tz);
    });
  }

  /**
   * Take the flag back.
   *
   * Without an undo, a mis-click is repaired by cancelling and re-registering
   * the patient — which loses their token and their bill. An expensive fix for
   * a cheap mistake, and the reason this endpoint exists.
   */
  async clearPriority(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);
      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      if (!appt.prioritySetAt) {
        throw new ConflictException({
          code: 'NOT_PRIORITISED',
          message: 'This patient is already in their normal position.',
        });
      }

      const updated = await tx.appointment.update({
        where: { id },
        data: {
          priorityReasonCode: null,
          priorityNote: null,
          prioritySetAt: null,
          prioritySetByUserId: null,
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.clear_priority',
        resourceType: 'Appointment',
        resourceId: id,
        patientId: updated.patientId,
        changedFields: ['priorityReasonCode', 'prioritySetAt'],
        ...meta,
      });

      return toView(updated, tz);
    });
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
    return this.prisma.forTenant(tenantId, (tx) => this.cancelIn(tx, tenantId, id, reason, meta));
  }

  private async cancelIn(
    tx: TenantClient,
    tenantId: string,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AppointmentView> {
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
  }

  /**
   * Did not turn up (FR-APT-09).
   *
   * ALSO FROM ARRIVED, since 2 Nov 2026. A patient who checked in and left
   * before anybody saw them was a dead end: the board offered nothing on a
   * waiting row once the day had passed, and this endpoint refused the only
   * verb that fits. Narveer's call — write it off rather than close it, since
   * no visit happened.
   *
   * `checkedInAt` IS DELIBERATELY LEFT ALONE. They did arrive, and that is a
   * fact worth keeping; clearing it to make the row tidy would delete
   * something that happened. A no-show carrying a check-in time is exactly
   * what "left before being seen" looks like, and the pair stays readable in
   * the no-show figures rather than quietly inflating them.
   */
  async markNoShow(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.transition(
      tenantId,
      id,
      ['BOOKED', 'ARRIVED'],
      'NO_SHOW',
      { noShowAt: new Date() },
      meta,
    );
  }

  /**
   * They turned up after all.
   *
   * Marking a no-show was one-way until 28 Oct 2026, reported from the clinic:
   * a patient written off at eleven who walks in at half past had no route
   * back. The desk's only option was booking a fresh appointment, which issues
   * a second token and raises a second consultation bill for one visit.
   *
   * Back to BOOKED rather than straight to ARRIVED, so the ordinary check-in
   * runs next and the pay-first gate is asked exactly as it would have been.
   * Undoing a mistake must not also be a way around the money.
   *
   * `noShowAt` is cleared, because the record now says it did not happen — the
   * audit entry is where the fact that somebody marked it lives.
   */
  async undoNoShow(tenantId: string, id: string, meta: RequestMeta): Promise<AppointmentView> {
    return this.transition(
      tenantId,
      id,
      'NO_SHOW',
      'BOOKED',
      { noShowAt: null },
      meta,
      /*
       * NOT BACK INTO A CLASH.
       *
       * A no-show is not a live status, so while it stood the desk could quite
       * correctly book this patient elsewhere at the same hour — that is the
       * whole point of writing them off. Reviving it without looking would then
       * put them in two rooms at ten o'clock by the back door, which is the
       * same fault `patientBusyBetween` was added to stop at the front.
       *
       * Found while confirming no path could still double-book, 30 Oct 2026.
       * The appointment excludes ITSELF from the search: it is the row being
       * revived, not a clash with it.
       */
      async (tx, appt) => {
        const clash = await patientBusyBetween(
          tx,
          appt.patientId,
          appt.startAt,
          appt.endAt,
          appt.id,
        );
        if (!clash) return;

        const tz = await this.timezone(tx, tenantId);
        throw new ConflictException({
          code: 'PATIENT_DOUBLE_BOOKED',
          message:
            `This patient was booked with ${clash.practitioner?.fullName ?? 'another doctor'} ` +
            `at ${instantToLocalTime(clash.startAt, tz)} after being marked absent. ` +
            'Use that appointment, or cancel it before bringing this one back.',
          existingAppointmentId: clash.id,
        });
      },
    );
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
    input: { startAt: string; reason: string; practitionerId?: string },
    meta: RequestMeta,
  ): Promise<AppointmentView> {
    /**
     * One transaction, cancel and book together. They used to be two, and a
     * booking refused AFTER the cancel had committed — a full slot, a doctor
     * switched off — left the patient with no appointment at all and an audit
     * trail saying the front desk cancelled it. Now a refusal anywhere rolls
     * the whole thing back: the original is untouched and no event is written.
     *
     * Locks, in the order taken: this appointment (FOR UPDATE, so two
     * reschedules of it cannot both pass the BOOKED check), then the doctor
     * (FOR SHARE, inside `bookIn`). Switching a doctor off takes only the
     * doctor's row, so no lock here waits on anything that waits on it.
     */
    return this.prisma.forTenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM appointment WHERE id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.appointment.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Appointment not found');

      if (existing.status !== 'BOOKED') {
        throw new ConflictException({
          code: 'NOT_RESCHEDULABLE',
          message: 'Only a booked appointment that has not yet arrived can be moved.',
        });
      }

      await this.cancelIn(tx, tenantId, id, `Rescheduled: ${input.reason}`, meta);

      return this.bookIn(
        tx,
        tenantId,
        {
          patientId: existing.patientId,
          /*
           * The same doctor unless a different one was asked for.
           *
           * `bookIn` validates the slot against whichever practitioner this
           * is, so a move to a doctor who is switched off, has no session at
           * that hour, or is already full is refused by the rules that govern
           * any other booking. Nothing special is needed here beyond letting
           * the id through.
           */
          practitionerId: input.practitionerId ?? existing.practitionerId,
          locationId: existing.locationId,
          startAt: input.startAt,
          visitType: existing.visitType,
          ...(existing.reasonForVisit ? { reasonForVisit: existing.reasonForVisit } : {}),
        },
        meta,
      );
    });
  }

  /**
   * The live queue for one doctor.
   *
   * The waiting list is ordered by READINESS, not by token and not by
   * appointment time. Someone who booked 11:00 but arrived at 09:30 is seen
   * before someone who booked 09:45 and is still in traffic, which is how the
   * room actually works — and now that tokens are issued at booking, the token
   * cannot carry that ordering any more.
   *
   * Flagged patients come first, ordered by when they were flagged: first
   * flagged, first served, so a late emergency does not displace someone who
   * has already been told they are next. Token is the final tie-break, purely
   * so the order is deterministic.
   */
  /**
   * Which doctor's queue this caller may read.
   *
   * **A doctor sees their own list and nobody else's.** They are looking at
   * their own waiting room; another doctor's queue is that doctor's patients,
   * their complaints and their day, and there is no workflow in an OPD clinic
   * that needs one consultant browsing another's list.
   *
   * The rule is: a user who IS a practitioner is confined to themselves, unless
   * they also administer the clinic. The distinguishing fact is the practitioner
   * link rather than a role name — a nurse and a doctor both hold
   * `appointment:read`, so permissions alone cannot tell them apart here, but
   * only one of them is a row in `practitioner`. Front desk, nurses and owners
   * are not practitioners and are unaffected; an administrator who also
   * consults keeps the whole clinic's view, because that is the job they were
   * given `user:manage` for.
   *
   * Enforced HERE and not only in the console. The web app hides the doctor
   * selector, which is a courtesy; this is the part that means something.
   *
   * **An unlinked doctor gets nothing, not everything.** "Is this user a
   * practitioner" has three answers, not two, and the third one used to fail
   * open: a user with a doctor's permissions whose account was never joined to
   * a `practitioner` row looked exactly like the front desk, so they were let
   * through to ANY doctor's queue in the clinic. That is the state every new
   * doctor is in between being created and having their Doctors-and-hours
   * setup done, which is to say the state they are in on their first day.
   *
   * `consultation:write` is what separates the third case from the first. Only
   * the doctor role carries it — the front desk, nurses, finance and
   * diagnostics do not — so it reads as "this account is meant to belong to a
   * practitioner", and an account that is meant to have a queue and has no link
   * is misconfigured rather than unrestricted.
   */
  async assertMayReadQueue(
    tenantId: string,
    user: { userId: string; permissions: string[] },
    requestedPractitionerId: string,
  ): Promise<void> {
    if (user.permissions.includes('user:manage')) return;

    const self = await this.prisma.forTenant(tenantId, (tx) =>
      tx.practitioner.findFirst({ where: { userId: user.userId }, select: { id: true } }),
    );

    if (!self) {
      if (user.permissions.includes(PERMISSIONS.CONSULTATION_WRITE)) {
        throw new ForbiddenException(
          'Your account is not linked to a doctor record yet, so you do not have a queue. ' +
            'An administrator can link it under Doctors and hours.',
        );
      }
      // Front desk, nurses, finance: never had a queue of their own, and the
      // whole clinic's list is their job.
      return;
    }

    if (self.id !== requestedPractitionerId) {
      throw new ForbiddenException('You can only view your own queue.');
    }
  }

  /** The practitioner this user is, if any. Null for front desk, nurses, admins. */
  async practitionerIdFor(tenantId: string, userId: string): Promise<string | null> {
    const row = await this.prisma.forTenant(tenantId, (tx) =>
      tx.practitioner.findFirst({ where: { userId }, select: { id: true } }),
    );
    return row?.id ?? null;
  }

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
        // Serving order, in the database rather than in application code: this
        // is the rule the display board will read too, and two implementations
        // of it would disagree the first time one of them changed.
        orderBy: [
          { prioritySetAt: { sort: 'asc', nulls: 'last' } },
          { readyAt: { sort: 'asc', nulls: 'last' } },
          { tokenNumber: 'asc' },
        ],
      });

      const views = rows.map((r) => toView(r, tz));

      const yetToArrive = views
        .filter((v) => v.status === 'BOOKED')
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      const waiting = views.filter((v) => v.status === 'ARRIVED');
      const inProgress = views.find((v) => v.status === 'IN_PROGRESS') ?? null;
      /**
       * Most recently finished first, since 27 Oct 2026.
       *
       * It used to inherit the serving order, so the first patient of the
       * morning sat at the top of "Seen today" all day and the one who just
       * walked out was at the bottom of a list of twenty. This is the only
       * list on the screen read backwards — the other three are a queue, a
       * diary and a waiting time, and all three belong in ascending order.
       *
       * Sorted on the rows rather than the views, so the ordering reads off
       * the real `completedAt` rather than anything the view happens to carry.
       */
      const completed = rows
        .filter((r) => r.status === 'FULFILLED')
        .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
        .map((r) => toView(r, tz));
      // Out for an X-ray. Not waiting, not finished, and the desk needs to see
      // them or nobody knows who the clinic is still holding a room for.
      const awayForTests = views
        .filter((v) => v.status === 'AWAITING_TESTS')
        .sort((a, b) => (a.sentOut?.at.getTime() ?? 0) - (b.sentOut?.at.getTime() ?? 0));

      return {
        date: day,
        timezone: tz,
        nowServing: inProgress,
        waiting,
        awayForTests,
        // Nobody here is in the queue yet, so serving order says nothing about
        // them. The front desk reads this list as a diary — by time.
        yetToArrive,
        completed,
        cancelled: views.filter((v) => v.status === 'CANCELLED' || v.status === 'NO_SHOW'),
        stats: {
          /**
           * Everybody the clinic still has to deal with today: yet to arrive,
           * waiting, in the room, and out for tests.
           *
           * This was `total: views.length` under the label "In the queue", and
           * `views` is every appointment of the day in any state — a finished
           * visit, a cancellation and a no-show all counted. So the number only
           * ever went up, and it could include a patient shown nowhere on the
           * screen: finished visits appear under "Seen today", and cancelled
           * ones are not drawn at all. Measured on the development data: 1
           * booked + 1 finished read "In the queue: 2" beside an empty waiting
           * list.
           *
           * Counted by status rather than by adding up the lists, for one
           * reason: `nowServing` shows a single patient, and if the data ever
           * held two visits in progress for one doctor, a sum of the lists
           * would silently drop the second. The status set is the definition;
           * the lists are how the screen happens to draw it.
           */
          inQueue: views.filter((v) => IN_QUEUE.has(v.status)).length,
          waiting: waiting.length,
          awayForTests: awayForTests.length,
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
    /**
     * The status, or statuses, this transition may run from.
     *
     * A list rather than one value since 2 Nov 2026, for `markNoShow`: a
     * patient who checked in and left before anybody saw them is written off
     * from ARRIVED, not from BOOKED.
     */
    from: string | readonly string[],
    to: string,
    extra: Record<string, unknown>,
    meta: RequestMeta,
    /**
     * One more rule, checked inside this transaction with the row in hand.
     *
     * Exists for `undoNoShow`, which is the only transition that puts an
     * appointment BACK into a live status and so is the only one that can
     * create a clash rather than resolve one.
     */
    guard?: (
      tx: TenantClient,
      appt: { id: string; patientId: string; startAt: Date; endAt: Date },
    ) => Promise<void>,
  ): Promise<AppointmentView> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tz = await this.timezone(tx, tenantId);

      /*
       * Locked before it is read, as `reschedule` does.
       *
       * Without this, two desks calling the same transition both read the old
       * status, both pass the check below and both write — and for the one
       * transition that revives an appointment, both could revive it into a
       * clash that neither saw.
       */
      await tx.$queryRaw`SELECT id FROM appointment WHERE id = ${id}::uuid FOR UPDATE`;

      const appt = await tx.appointment.findUnique({ where: { id } });
      if (!appt) throw new NotFoundException('Appointment not found');

      const allowedFrom = typeof from === 'string' ? [from] : from;
      if (!allowedFrom.includes(appt.status)) {
        throw new ConflictException({
          code: 'INVALID_TRANSITION',
          message: `Expected the appointment to be ${allowedFrom
            .map((s) => s.toLowerCase())
            .join(' or ')}, but it is ${appt.status.toLowerCase()}.`,
        });
      }

      if (guard) await guard(tx, appt);

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
    readyAt: Date | null;
    priorityReasonCode: string | null;
    priorityNote: string | null;
    prioritySetAt: Date | null;
    sentOutAt: Date | null;
    sentOutReason: string | null;
    returnedAt: Date | null;
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
    readyAt: a.readyAt,
    // Null unless the visit has been flagged. The three columns move together —
    // a CHECK constraint says so — but the view collapses them into one object
    // so a client cannot render half a flag.
    priority:
      a.priorityReasonCode && a.prioritySetAt
        ? { reasonCode: a.priorityReasonCode, note: a.priorityNote, setAt: a.prioritySetAt }
        : null,
    sentOut: a.sentOutAt && a.sentOutReason ? { at: a.sentOutAt, reason: a.sentOutReason } : null,
    returnedAt: a.returnedAt,
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

/**
 * Hold the doctor still for the rest of this transaction, and refuse one who
 * has been switched off.
 *
 * Every path that creates an appointment calls this first — booking, walk-in,
 * and rescheduling (which books). The availability engine refuses a switched-off
 * doctor too, but it reads in a transaction of its own, so on its own it left a
 * window: a booking that had seen the doctor active could save after the
 * switch-off committed.
 *
 * `FOR SHARE` closes it against the `FOR UPDATE` that switching off takes
 * (`ClinicSetupService.updatePractitioner`):
 *
 *   - a booking holding this lock makes the switch-off wait until the booking
 *     commits; the switch-off then counts the new appointment and refuses
 *     with its 409;
 *   - a switch-off holding its lock makes this wait until it commits; this
 *     then reads the committed `is_active = false` and refuses.
 *
 * Bookings for the same doctor do not wait for each other — shared locks are
 * compatible — so this costs the busy front desk nothing.
 *
 * The refusal is the one booking already gives for a switched-off doctor, so
 * all three paths answer alike.
 */
async function lockBookablePractitioner(tx: TenantClient, practitionerId: string): Promise<void> {
  const [row] = await tx.$queryRaw<Array<{ is_active: boolean }>>`
    SELECT is_active FROM practitioner WHERE id = ${practitionerId}::uuid FOR SHARE
  `;
  if (!row) throw new NotFoundException('Doctor not found');
  if (!row.is_active) {
    throw new ConflictException({
      code: 'SLOT_NOT_AVAILABLE',
      message: 'This doctor is no longer active.',
    });
  }
}
