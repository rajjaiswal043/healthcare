/**
 * "How long until it is my turn?" — answered for a patient who is not in the
 * building.
 *
 * Pure, so it can be tested without a database, and shared by the patient's
 * live page, the "time to leave" message and the waiting-room screen. Three
 * callers with three versions of this sum would tell one patient three times.
 *
 * It is an ESTIMATE and says so everywhere it is shown. The clinic works to
 * readiness, priority flags and a doctor's judgement; none of that is
 * predictable, and a number that pretends otherwise is a number patients stop
 * trusting the first time it is wrong.
 */

/** Before anyone has been seen today, assume this. Ten minutes is an OPD average. */
export const DEFAULT_CONSULT_MINUTES = 10;

/** Send "time to leave" when the estimate drops to this. Travel in an Indian city. */
export const LEAVE_NOW_MINUTES = 30;

export interface QueueRow {
  id: string;
  status: string;
  startAt: Date;
  calledAt: Date | null;
  completedAt: Date | null;
}

export interface PositionEstimate {
  /** People the doctor will see before this patient, including whoever is in the room. */
  ahead: number;
  /** Minutes until this patient is likely to be called. Null once they have been. */
  etaMinutes: number | null;
  /** Mean minutes per patient today, or the default. */
  minutesPerPatient: number;
}

/**
 * Mean consultation length today, from the visits already finished.
 *
 * Clamped: one visit that was left open over lunch should not tell a patient
 * the wait is three hours, and one that was opened and signed in a minute
 * should not tell them to run.
 */
export function minutesPerPatient(rows: QueueRow[]): number {
  const done = rows.filter((r) => r.calledAt && r.completedAt);
  if (done.length === 0) return DEFAULT_CONSULT_MINUTES;

  const total = done.reduce(
    (sum, r) => sum + ((r.completedAt as Date).getTime() - (r.calledAt as Date).getTime()),
    0,
  );
  const mean = total / done.length / 60000;
  return Math.min(45, Math.max(3, Math.round(mean)));
}

/**
 * Where one appointment stands.
 *
 * `waitingInOrder` must be the ARRIVED visits in serving order — the same order
 * the staff board and the screen use (priority, then readiness, then token).
 *
 * A patient still at home (BOOKED) is behind everybody already waiting, and
 * behind anybody at home whose slot is earlier. Their estimate is also never
 * earlier than their own slot: "come now" to somebody booked for noon, at nine,
 * would empty the house into the waiting room, which is the thing this exists
 * to prevent.
 */
export function estimatePosition(input: {
  appointment: QueueRow;
  waitingInOrder: QueueRow[];
  inProgress: QueueRow | null;
  bookedToday: QueueRow[];
  allToday: QueueRow[];
  now: Date;
}): PositionEstimate {
  const perPatient = minutesPerPatient(input.allToday);
  const { appointment } = input;
  const inRoom = input.inProgress ? 1 : 0;

  if (appointment.status === 'IN_PROGRESS') {
    return { ahead: 0, etaMinutes: 0, minutesPerPatient: perPatient };
  }

  if (appointment.status === 'ARRIVED') {
    const index = input.waitingInOrder.findIndex((r) => r.id === appointment.id);
    const before = index < 0 ? input.waitingInOrder.length : index;
    const ahead = before + inRoom;
    return { ahead, etaMinutes: ahead * perPatient, minutesPerPatient: perPatient };
  }

  if (appointment.status === 'BOOKED') {
    const bookedEarlier = input.bookedToday.filter(
      (r) => r.id !== appointment.id && r.startAt.getTime() < appointment.startAt.getTime(),
    ).length;
    const ahead = input.waitingInOrder.length + inRoom + bookedEarlier;
    const byQueue = ahead * perPatient;
    const bySlot = Math.max(
      0,
      Math.round((appointment.startAt.getTime() - input.now.getTime()) / 60000),
    );
    return { ahead, etaMinutes: Math.max(byQueue, bySlot), minutesPerPatient: perPatient };
  }

  return { ahead: 0, etaMinutes: null, minutesPerPatient: perPatient };
}
