import type { TenantClient } from '@healthcloud/db';
import type { QueueRow } from './queue-estimate.js';

/**
 * The serving order, as a Prisma `orderBy`.
 *
 * Priority first (first flagged, first served), then readiness, then token as
 * a tie-break. The staff board sorts with exactly this, and so does everything
 * a patient sees — see AppointmentsService.queue for why it is readiness and
 * not the token.
 */
export const SERVING_ORDER = [
  { prioritySetAt: { sort: 'asc', nulls: 'last' } },
  { readyAt: { sort: 'asc', nulls: 'last' } },
  { tokenNumber: 'asc' },
] as const;

export interface QueueDayRow extends QueueRow {
  tokenNumber: number | null;
  leaveNowSentAt: Date | null;
  arrivalIntent: string | null;
  patientId: string;
}

export interface QueueDay {
  all: QueueDayRow[];
  waitingInOrder: QueueDayRow[];
  inProgress: QueueDayRow | null;
  bookedToday: QueueDayRow[];
}

/** One doctor's day, split the way the estimate needs it. */
export async function loadQueueDay(
  tx: TenantClient,
  practitionerId: string,
  queueDate: Date,
): Promise<QueueDay> {
  const rows = await tx.appointment.findMany({
    where: { practitionerId, queueDate },
    orderBy: SERVING_ORDER.map((o) => ({ ...o })) as never,
    select: {
      id: true,
      status: true,
      startAt: true,
      calledAt: true,
      completedAt: true,
      tokenNumber: true,
      leaveNowSentAt: true,
      arrivalIntent: true,
      patientId: true,
    },
  });

  const all: QueueDayRow[] = rows.map((r) => ({ ...r, status: String(r.status) }));

  return {
    all,
    waitingInOrder: all.filter((r) => r.status === 'ARRIVED'),
    inProgress: all.find((r) => r.status === 'IN_PROGRESS') ?? null,
    bookedToday: all.filter((r) => r.status === 'BOOKED'),
  };
}
