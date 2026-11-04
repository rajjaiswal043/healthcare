/**
 * WHAT A VISIT MAY DO NEXT — one definition, asked by both sides.
 *
 * THE BUG THIS EXISTS TO END. The day board decided which buttons to draw from
 * the BUCKET, and each endpoint decided whether to accept them from the ROW.
 * Two pieces of reasoning, in two files, with nothing making them agree. Every
 * time they disagreed the clinic got a button that errored when pressed, which
 * is the worst failure this board has: somebody presses it in front of a
 * patient.
 *
 * It happened three times in six days, and patching each one only made the two
 * agree at that single point:
 *
 *   30 Oct — a past-day row offered Close visit; `closeVisit` took only
 *            FULFILLED, so the one button on the row errored.
 *   4 Nov  — the whole "At a department" tab offered Close visit; those visits
 *            are ARRIVED, because the bucket comes from the TEST while the
 *            guard reads the APPOINTMENT.
 *   4 Nov  — the same tab offered Close visit on an ALREADY CLOSED visit,
 *            because closing deliberately leaves the pending test alone and
 *            that test is what keeps the row in the tab.
 *
 * So the decision moved here. The endpoint throws when one of these returns a
 * refusal; the board pushes the step only when it returns null. Offering and
 * accepting stop being two decisions and become one function asked twice —
 * the board cannot offer a step the server refuses, by construction rather
 * than by review.
 *
 * The same pattern as `invoiceSettlement`, and for the same stated reason:
 * "one definition of 'paid' in the system and all three screens agree by
 * construction rather than by review." This is that, for transitions.
 *
 * WHAT STAYS WITH THE BUCKET. Which steps are RELEVANT to a stage is still the
 * board's business — a patient at a department is not offered Check in because
 * it would be nonsense, not because it is illegal. This module answers only
 * whether a step is LEGAL. Conflating the two questions is what produced the
 * bugs above.
 *
 * PURE, and deliberately: no Prisma, no tenant, no IO. It is asked once per
 * request by an endpoint and once per row by a board rendering forty of them.
 */

/** Why a transition was refused. Thrown as a ConflictException by the caller. */
export interface Refusal {
  code: string;
  message: string;
}

/**
 * The two facts every one of these rules reads.
 *
 * `closed` rather than `closedAt` because the board holds a boolean and the
 * service holds a timestamp, and neither should have to fake the other's shape
 * to ask a question.
 */
export interface VisitState {
  status: string;
  closed: boolean;
}

/** "awaiting tests" rather than "AWAITING_TESTS", for a message a human reads. */
function plainly(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ');
}

/**
 * Check a booked patient in.
 *
 * The money gate is NOT here: `blockingReason` reads the visit's bill and needs
 * the database, so the endpoint asks it separately and the board asks its own
 * `visitFeePending`. This answers only the question about the appointment.
 */
export function mayCheckIn(visit: VisitState): Refusal | null {
  if (visit.status !== 'BOOKED') {
    return {
      code: 'NOT_CHECKABLE',
      message: `This appointment is ${plainly(visit.status)}, so it cannot be checked in.`,
    };
  }
  return null;
}

/**
 * Write somebody off as not having come.
 *
 * ARRIVED as well as BOOKED since 2 Nov 2026: a patient who checked in and left
 * before anybody saw them is written off, not closed, because no visit happened.
 * `checked_in_at` is deliberately kept — see `markNoShow`.
 */
export function mayMarkNoShow(visit: VisitState): Refusal | null {
  const from = ['BOOKED', 'ARRIVED'];
  if (!from.includes(visit.status)) {
    return {
      code: 'INVALID_TRANSITION',
      message:
        `Expected the appointment to be ${from.map((s) => s.toLowerCase()).join(' or ')}, ` +
        `but it is ${visit.status.toLowerCase()}.`,
    };
  }
  return null;
}

/** Bring a patient back from a department. */
export function mayBringBack(visit: VisitState): Refusal | null {
  if (visit.status !== 'AWAITING_TESTS') {
    return {
      code: 'NOT_AWAY',
      message: 'This patient was not sent for tests, so there is nothing to bring back.',
    };
  }
  return null;
}

/**
 * OPD done — the doctor has finished.
 *
 * Only from IN_PROGRESS, because that is the one status `complete` moves. This
 * does NOT close the visit: whether the patient has left is a separate fact,
 * which is the whole of the 22 Oct split.
 */
export function mayFinish(visit: VisitState): Refusal | null {
  if (visit.status !== 'IN_PROGRESS') {
    return {
      code: 'INVALID_TRANSITION',
      message: `Expected the appointment to be in_progress, but it is ${visit.status.toLowerCase()}.`,
    };
  }
  return null;
}

/**
 * The visit is over and the patient has gone home.
 *
 * ORDER MATTERS: already-closed is answered before how-far-it-got, so somebody
 * pressing a stale button is told the visit is closed rather than something
 * about its status.
 *
 * ARRIVED is closeable (4 Nov 2026): this clinic books and pays for tests at
 * registration, so a patient at a department is often still ARRIVED, never
 * having gone through the send-out step. They attended and paid; closing is the
 * honest verb and "did not come" plainly is not.
 */
export function mayClose(visit: VisitState): Refusal | null {
  if (visit.closed) {
    return { code: 'ALREADY_CLOSED', message: 'This visit has already been closed.' };
  }

  const closeable = ['ARRIVED', 'IN_PROGRESS', 'AWAITING_TESTS', 'FULFILLED'];
  if (!closeable.includes(visit.status)) {
    return {
      code: 'NOT_STARTED',
      message:
        visit.status === 'BOOKED'
          ? 'This patient never checked in, so there is no visit to close.'
          : `A visit that is ${plainly(visit.status)} cannot be closed.`,
    };
  }
  return null;
}

/** Undo a close. Whoever may end a visit may un-end one. */
export function mayReopen(visit: VisitState): Refusal | null {
  if (!visit.closed) {
    return { code: 'NOT_CLOSED', message: 'This visit is already open.' };
  }
  return null;
}
