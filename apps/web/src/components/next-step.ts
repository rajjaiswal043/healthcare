import type { NextStep } from '@/lib/api';

/**
 * Which permission each step needs — the one the SERVER enforces on it.
 *
 * Kept beside the picker so the button and the endpoint cannot drift: a button
 * drawn for somebody the API will refuse is worse than no button, because they
 * find out by pressing it in front of a patient.
 */
const NEEDS: Record<NextStep['kind'], string> = {
  COLLECT: 'payment:collect',
  CHECK_IN: 'appointment:write',
  START: 'consultation:write',
  RESUME: 'consultation:write',
  FINISH: 'appointment:write',
  RECORD_RESULT: 'diagnostic:result',
  RECEIPT: 'invoice:read',
};

/**
 * The steps that still make sense on a day that has already happened.
 *
 * Money and paper. A bill from last Tuesday is still owed — that is half the
 * reason to look at last Tuesday — and a receipt is a copy of something that
 * already happened, which is the other half.
 *
 * Everything else is about moving a patient through a clinic they left days
 * ago. Checking somebody in on a past date, or opening a consultation against
 * it, would write today's work into the wrong day.
 */
const PAST_SAFE = new Set<NextStep['kind']>(['COLLECT', 'RECEIPT']);

/**
 * The one step this person should be offered on this row.
 *
 * The server sends what the PATIENT needs, most blocking first; this picks the
 * first of those the person looking can actually do. That split is what lets
 * one list serve everybody:
 *
 *   the desk, holding money permissions, sees Collect on a patient who owes and
 *   nothing on one who is waiting for the doctor;
 *
 *   the doctor, holding none, skips past Collect to Resume on that same row;
 *
 *   somebody holding every permission — an administrator who is also the
 *   doctor, which is most small clinics — sees Collect, because it is first,
 *   and first means it is blocking everything behind it.
 *
 * Returns null when there is nothing for them to do, which is a normal state
 * and should render as empty space rather than a disabled button.
 */
export function firstDoableStep(
  steps: NextStep[],
  can: (permission: string) => boolean,
  isToday: boolean,
): NextStep | null {
  return (
    steps.find((step) => (isToday || PAST_SAFE.has(step.kind)) && can(NEEDS[step.kind])) ?? null
  );
}

/** The words on the button. A verb, because it is about to do something. */
export function stepLabel(step: NextStep): string {
  switch (step.kind) {
    case 'COLLECT':
      return 'Collect';
    case 'CHECK_IN':
      return 'Check in';
    case 'START':
      return 'Start';
    case 'RESUME':
      return 'Open';
    case 'FINISH':
      return 'Done';
    case 'RECORD_RESULT':
      return 'Record result';
    case 'RECEIPT':
      return 'Receipt';
  }
}
