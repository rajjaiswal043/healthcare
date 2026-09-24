import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import {
  instantToLocalTime,
  localDayOfWeek,
  localToInstant,
  minutesToTime,
  rangesOverlap,
  timeToMinutes,
} from './clinic-time.js';

export interface SlotView {
  /** Clinic-local "HH:mm", for display. */
  time: string;
  startAt: Date;
  endAt: Date;
  capacity: number;
  booked: number;
  available: number;
  /** True when only the doctor's overbooking allowance keeps this bookable. */
  overbooking: boolean;
}

export interface DayAvailability {
  date: string;
  timezone: string;
  practitionerId: string;
  /** Empty when the doctor does not sit that day, or is on leave. */
  slots: SlotView[];
  /** Why there are no slots, when there are none. */
  unavailableReason: string | null;
}

/**
 * Computes bookable slots.
 *
 * Slots are DERIVED, never stored: weekly template, minus exceptions, minus
 * what is already booked. Materialising them would mean a generation job, a
 * rebuild every time a doctor changes their hours, and rows that can quietly
 * disagree with the template. A clinic has a handful of doctors and perhaps
 * sixty slots each per day, so this is three small queries and some arithmetic.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async forDay(
    tenantId: string,
    input: { practitionerId: string; date: string; locationId?: string; visitType?: string },
  ): Promise<DayAvailability> {
    return this.prisma.forTenant(tenantId, (tx) => this.forDayIn(tx, tenantId, input));
  }

  /**
   * The same, inside a transaction the caller already holds.
   *
   * What booking uses, so the slot is checked in the transaction that takes it.
   * Checked in a transaction of its own, it could not see what the caller had
   * already done — a reschedule's cancellation of the original, still
   * uncommitted, would still be holding the slot it was leaving.
   */
  async forDayIn(
    tx: TenantClient,
    tenantId: string,
    input: { practitionerId: string; date: string; locationId?: string; visitType?: string },
  ): Promise<DayAvailability> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const tz = tenant.timezone;

    const practitioner = await tx.practitioner.findUnique({
      where: { id: input.practitionerId },
      select: { id: true, isActive: true, overbookPerSession: true },
    });

    if (!practitioner) throw new NotFoundException('Doctor not found');

    const empty = (reason: string): DayAvailability => ({
      date: input.date,
      timezone: tz,
      practitionerId: input.practitionerId,
      slots: [],
      unavailableReason: reason,
    });

    if (!practitioner.isActive) return empty('This doctor is no longer active.');

    const dayOfWeek = localDayOfWeek(input.date, tz);
    const dateOnly = new Date(`${input.date}T00:00:00Z`);

    const schedules = await tx.practitionerSchedule.findMany({
      where: {
        practitionerId: input.practitionerId,
        dayOfWeek,
        isActive: true,
        validFrom: { lte: dateOnly },
        OR: [{ validTo: null }, { validTo: { gte: dateOnly } }],
        ...(input.locationId ? { locationId: input.locationId } : {}),
      },
      orderBy: { startTime: 'asc' },
    });

    if (schedules.length === 0) {
      return empty('The doctor does not hold a clinic on this day.');
    }

    // Exceptions overlapping this date. EXTRA sessions are not yet generated
    // into slots — they are recorded, and adding them is a follow-on.
    const exceptions = await tx.scheduleException.findMany({
      where: {
        practitionerId: input.practitionerId,
        startDate: { lte: dateOnly },
        endDate: { gte: dateOnly },
      },
    });

    const blocking = exceptions.filter((e) => e.type === 'LEAVE' || e.type === 'BLOCK');

    // A whole-day block ends the matter regardless of session times.
    const wholeDayBlock = blocking.find((e) => !e.startTime || !e.endTime);
    if (wholeDayBlock) {
      return empty(
        wholeDayBlock.type === 'LEAVE'
          ? `On leave${wholeDayBlock.reason ? ` — ${wholeDayBlock.reason}` : ''}.`
          : `Unavailable${wholeDayBlock.reason ? ` — ${wholeDayBlock.reason}` : ''}.`,
      );
    }

    // Everything already on the books for that doctor that day. Cancelled and
    // no-show appointments must NOT hold a slot.
    const dayStart = localToInstant(input.date, '00:00', tz);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const booked = await tx.appointment.findMany({
      where: {
        practitionerId: input.practitionerId,
        startAt: { gte: dayStart, lt: dayEnd },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      select: { startAt: true },
    });

    // Bucket by local start time so lookup is O(1) per slot.
    const bookedByTime = new Map<string, number>();
    for (const a of booked) {
      const key = instantToLocalTime(a.startAt, tz);
      bookedByTime.set(key, (bookedByTime.get(key) ?? 0) + 1);
    }

    const blockedWindows = blocking
      .filter((e) => e.startTime && e.endTime)
      .map(
        (e) => [timeToMinutes(e.startTime as string), timeToMinutes(e.endTime as string)] as const,
      );

    const slots: SlotView[] = [];

    for (const schedule of schedules) {
      if (
        input.visitType &&
        schedule.visitTypes.length > 0 &&
        !schedule.visitTypes.includes(input.visitType as never)
      ) {
        continue;
      }

      const from = timeToMinutes(schedule.startTime);
      const to = timeToMinutes(schedule.endTime);

      for (let m = from; m + schedule.slotMinutes <= to; m += schedule.slotMinutes) {
        const slotEnd = m + schedule.slotMinutes;

        if (blockedWindows.some(([bs, be]) => rangesOverlap(m, slotEnd, bs, be))) continue;

        const time = minutesToTime(m);
        const used = bookedByTime.get(time) ?? 0;
        const capacity = schedule.capacityPerSlot;
        const ceiling = capacity + practitioner.overbookPerSession;

        slots.push({
          time,
          startAt: localToInstant(input.date, time, tz),
          endAt: localToInstant(input.date, minutesToTime(slotEnd), tz),
          capacity,
          booked: used,
          available: Math.max(0, ceiling - used),
          overbooking: used >= capacity && used < ceiling,
        });
      }
    }

    slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

    return {
      date: input.date,
      timezone: tz,
      practitionerId: input.practitionerId,
      slots,
      unavailableReason: slots.length === 0 ? 'Every slot is taken for this day.' : null,
    };
  }
}
