/**
 * What a visit's status is called on a patient's record.
 *
 * A rule module because of the one case that is not a lookup: a visit still
 * sitting at `BOOKED` on a day that has gone. Nothing in this clinic marks a
 * no-show, so that is what a missed appointment looks like in the database for
 * ever, and the record was printing it as "booked" — present tense, about a
 * Tuesday three weeks ago. Reported 27 Oct 2026, alongside the same problem on
 * the day board, which infers it the same way.
 *
 * Also the end of printing the raw enum. `a.status.replace('_', ' ')` gave
 * "awaiting tests" and "in progress", which are column names, not something
 * you would say to a colleague about a patient.
 */

/** The statuses a visit can hold, plus the one this module infers. */
export type VisitStatus =
  | 'BOOKED'
  | 'ARRIVED'
  | 'IN_PROGRESS'
  | 'AWAITING_TESTS'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'NO_SHOW'
  /** Booked, never checked in, and the day is over. Inferred, never stored. */
  | 'DID_NOT_COME';

export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  BOOKED: 'Booked',
  ARRIVED: 'Waiting',
  IN_PROGRESS: 'With the doctor',
  AWAITING_TESTS: 'At a department',
  FULFILLED: 'Finished',
  CANCELLED: 'Cancelled',
  /* The same words for the recorded fact and the inferred one. A record that
     called them different things would imply they were different things. */
  NO_SHOW: 'Did not come',
  DID_NOT_COME: 'Did not come',
};

/** How each one is drawn. Coral is reserved for a visit that did not happen. */
export const VISIT_STATUS_TONE: Record<VisitStatus, string> = {
  BOOKED: 'badge-neutral',
  ARRIVED: 'badge-amber',
  IN_PROGRESS: 'badge-clinical',
  AWAITING_TESTS: 'badge-neutral',
  FULFILLED: 'badge-green',
  CANCELLED: 'badge-coral',
  NO_SHOW: 'badge-coral',
  DID_NOT_COME: 'badge-coral',
};

/**
 * The status to show, which is not always the status that was stored.
 *
 * `missed` comes from the server, which knows the clinic's timezone. The
 * browser knows only the reader's, and a date compared in the wrong one is a
 * day out for every appointment in the first half of the clinic's day — this
 * very laptop sits in America/Toronto while the clinic is in India.
 *
 * Only BOOKED is ever reinterpreted. A status somebody actually recorded is
 * reported as it stands, whatever the date.
 */
export function effectiveVisitStatus(status: string, missed: boolean): VisitStatus {
  if (status === 'BOOKED' && missed) return 'DID_NOT_COME';

  return status in VISIT_STATUS_LABEL ? (status as VisitStatus) : 'BOOKED';
}
