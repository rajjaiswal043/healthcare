import type { DayBucket, NextStep } from '@/lib/api';

/**
 * Stages a patient can be sent for a test from.
 *
 * THE RULE IS "ARE THEY IN THE BUILDING", not "is the visit tidy". A doctor
 * finishes a consultation, the patient stands up, and the doctor decides they
 * want a film after all — a normal way for an afternoon to go, and the server
 * has never minded: `createOrder` reads the visit's id and patient and does
 * not look at its status. Ordering against a finished visit moves the patient
 * back to "At a department" on its own, because a pending order places there
 * and that beats the finished buckets.
 *
 * READY_TO_CLOSE and BACK_FROM_TESTS were MISSING and that was a regression.
 * When `FULFILLED` stopped meaning DONE on 22 Oct 2026 and split into "the
 * doctor has finished" and "the visit is closed", this list still named only
 * DONE — so from 27 Oct a patient the doctor had finished with could not be
 * sent for a second test at all, and the row offered nothing but Close visit.
 * Reported from the clinic: "agar blood test add karna ho, toh nahi ho pa
 * raha hai".
 *
 * EXPECTED is still out: a patient who has not arrived cannot be sent
 * anywhere, and raising a charge for one is how a bill exists for a visit that
 * never happened. NOT_ATTENDING likewise — nobody is chasing a cancellation
 * around the clinic.
 */
export const SENDABLE = new Set<DayBucket>([
  'WAITING',
  'WITH_DOCTOR',
  'AT_DEPARTMENT',
  /* Their film is back and they are waiting to be seen again. The doctor
     reading it is exactly who decides a blood test is needed too. */
  'BACK_FROM_TESTS',
  /* The doctor has finished and the patient is still standing there. This is
     the case the original note was written for, and the one the split broke. */
  'READY_TO_CLOSE',
  /* Kept from before the split. A closed visit can still take a late order;
     the row simply reopens at "At a department" until the test is done. */
  'DONE',
]);

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
  /* Writing somebody off as not having come is the desk's act, and it is the
     same permission as checking them in: both say whether a visit happened. */
  MARK_NO_SHOW: 'appointment:write',
  START: 'consultation:write',
  RESUME: 'consultation:write',
  /* The desk's act, not the doctor's: bringing somebody back from a department
     is moving them through the clinic, and a receptionist does it. */
  BRING_BACK: 'appointment:write',
  FINISH: 'appointment:write',
  /* Likewise. Closing a visit is sending a patient home, not a clinical call. */
  CLOSE_VISIT: 'appointment:write',
  /* Whoever may end a visit may un-end one. Closing is a press on a crowded
     board, so it can be a mispress, and the people who make it are the people
     who have to be able to fix it. */
  REOPEN_VISIT: 'appointment:write',
  RECORD_RESULT: 'diagnostic:result',
  /* Taking a charge off a bill is a money act, not a clinical one — the same
     permission the finance desk's own Decline button sits behind. */
  DECLINE_TEST: 'invoice:write',
  /* Withdrawing a request the clinic made is the clinical half, and it is who
     may ORDER a test rather than who may bill for one. */
  CANCEL_TEST: 'diagnostic:order',
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
/*
 * Safe to offer on a day that is not today.
 *
 * Money and receipts, because a bill from Tuesday is still owed on Thursday.
 * And marking a no-show, which is the one act that is MORE likely on a past
 * day than on the day itself: it records something about a day that is over.
 */
const PAST_SAFE = new Set<NextStep['kind']>(['COLLECT', 'RECEIPT', 'MARK_NO_SHOW']);

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
    steps.find(
      (step) =>
        !NEVER_PRIMARY.has(step.kind) &&
        (isToday || PAST_SAFE.has(step.kind)) &&
        can(NEEDS[step.kind]),
    ) ?? null
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
    case 'BRING_BACK':
      /* Not "Return": the verb has to be something the desk DOES to the
         patient, and the patient is already standing there. */
      return 'Bring back in';
    case 'FINISH':
      /* Named for what it finishes. 'Done' on its own sat on a board where a
         test can also be done and a visit can also be closed, and meant one
         of the three depending on where you looked. */
      return 'OPD done';
    case 'CLOSE_VISIT':
      return 'Close visit';
    case 'RECORD_RESULT':
      return 'Record result';
    case 'RECEIPT':
      return 'Receipt';
    case 'DECLINE_TEST':
      /* The patient's words, not the clinic's. "Cancel" would read as the
         clinic changing its mind about a test it still thinks is needed. */
      return 'Patient declined';
    case 'CANCEL_TEST':
      return 'Cancel test';
    case 'REOPEN_VISIT':
      return 'Reopen visit';
    case 'MARK_NO_SHOW':
      /* What happened, not what the software calls it. "No-show" is a word for
         a report; the desk says the patient did not come. */
      return 'Did not come';
  }
}

/**
 * Steps that are a way OUT and must never be a row's main instruction.
 *
 * A finished patient is not waiting to be reopened, and a department working
 * on a film is not waiting for somebody to cancel it. If these were eligible
 * to be the primary, a row with nothing else doable would start telling people
 * to undo things — which is the opposite of what the board is for.
 *
 * FINISH and CLOSE_VISIT are deliberately NOT here: for the front desk, who
 * hold no `consultation:write`, those genuinely are the next thing to do.
 */
const NEVER_PRIMARY = new Set<NextStep['kind']>([
  'DECLINE_TEST',
  'CANCEL_TEST',
  'REOPEN_VISIT',
  /* A patient who is twenty minutes late is still coming. Check in is what the
     row should be telling the desk to do, and writing them off must take a
     deliberate press on the quiet button instead. */
  'MARK_NO_SHOW',
]);

/**
 * The steps that are a WAY OUT rather than a way on.
 *
 * These are offered beside the primary action instead of competing with it.
 * The board's rule is one primary per row — see the home-board notes — and an
 * escape hatch is a different thing from a second choice about what to do
 * next: it is what somebody presses when the normal path is blocked and the
 * patient is standing in front of them.
 */
const SECONDARY = new Set<NextStep['kind']>([
  'FINISH',
  /**
   * Closing sits here for the same reason finishing does, and one more.
   *
   * On a row that still owes money the primary is Collect, so an administrator
   * had no way to close the visit at all — which contradicts the rule that
   * closing with a balance is ALLOWED: it warns, the bill stays open, and the
   * desk decides. Hiding the button behind the money made that rule
   * unreachable by the one role that needs it.
   */
  'CLOSE_VISIT',
  'DECLINE_TEST',
  'CANCEL_TEST',
  'REOPEN_VISIT',
]);

/**
 * The quiet button beside the primary one, if this person has one.
 *
 * Two cases, both reported from the clinic on 27 Oct 2026:
 *
 *   A DOCTOR OR ADMIN COULD NOT FINISH A VISIT from the board. Both hold
 *   `consultation:write`, so `firstDoableStep` always handed them Open and
 *   they never reached OPD done — which only the front desk, holding no
 *   `consultation:write`, ever fell through to. Finishing stays secondary
 *   rather than primary because it cannot be undone and should not be what a
 *   misplaced click does.
 *
 *   A PATIENT WHO COULD NOT PAY for a test had no way off the board. The row
 *   offered Collect and nothing else.
 *
 * Never returns the step already being shown as the primary, so a front desk
 * row showing OPD done does not also show it a second time.
 */
export function secondaryStep(
  steps: NextStep[],
  can: (permission: string) => boolean,
  isToday: boolean,
  primary: NextStep | null,
): NextStep | null {
  return (
    steps.find(
      (step) =>
        SECONDARY.has(step.kind) &&
        step.kind !== primary?.kind &&
        (isToday || PAST_SAFE.has(step.kind)) &&
        can(NEEDS[step.kind]),
    ) ?? null
  );
}
