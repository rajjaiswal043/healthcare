/**
 * Which button each person gets.
 *
 * The server sends what the PATIENT needs, most blocking first. This picks the
 * first of those the person looking may actually do — which is the whole reason
 * one board can serve a desk, a doctor and a technician without any of them
 * being shown a control the API would refuse.
 */

import { describe, expect, it } from 'vitest';
import type { DayBucket, NextStep } from '@/lib/api';
import { firstDoableStep, SENDABLE, secondaryStep, stepLabel } from './next-step';

/** A person who holds exactly these permissions. */
const holding =
  (...permissions: string[]) =>
  (permission: string) =>
    permissions.includes(permission);

const DESK = holding('payment:collect', 'invoice:read', 'appointment:write');
/* Matches the real `doctor` role in packages/db/src/permissions.ts, which
   holds `appointment:write` as well — a doctor checks patients in and finishes
   visits. The fixture used to leave it out, which made a doctor look unable to
   close a visit and let a test assert exactly that. */
const DOCTOR = holding('consultation:write', 'diagnostic:order', 'appointment:write');
const TECHNICIAN = holding('diagnostic:result');
const ADMIN = () => true;
const NOBODY = () => false;

const COLLECT: NextStep = { kind: 'COLLECT', invoiceId: 'inv-1', duePaise: 50000, billsOwing: 1 };
const CHECK_IN: NextStep = { kind: 'CHECK_IN', appointmentId: 'appt-1' };
const START: NextStep = { kind: 'START', appointmentId: 'appt-1' };
const RESUME: NextStep = { kind: 'RESUME', appointmentId: 'appt-1' };
const FINISH: NextStep = { kind: 'FINISH', appointmentId: 'appt-1' };
const BRING_BACK: NextStep = { kind: 'BRING_BACK', appointmentId: 'appt-1' };
const CLOSE_VISIT: NextStep = { kind: 'CLOSE_VISIT', appointmentId: 'appt-1' };
const DECLINE_TEST: NextStep = { kind: 'DECLINE_TEST', orderId: 'order-1' };
const CANCEL_TEST: NextStep = { kind: 'CANCEL_TEST', orderId: 'order-1' };
const REOPEN_VISIT: NextStep = { kind: 'REOPEN_VISIT', appointmentId: 'appt-1' };
const RECORD: NextStep = { kind: 'RECORD_RESULT', orderId: 'ord-1' };
const RECEIPT: NextStep = { kind: 'RECEIPT', paymentId: 'pay-1' };

describe('the one button each person gets', () => {
  it('gives the desk the money and the doctor the patient, from one row', () => {
    // The row that makes a list necessary: sitting with the doctor, and just
    // sent for an X-ray they have not paid for. Both steps are true at once.
    const steps = [COLLECT, RESUME];

    expect(firstDoableStep(steps, DESK, true)).toEqual(COLLECT);
    expect(firstDoableStep(steps, DOCTOR, true)).toEqual(RESUME);
  });

  /**
   * Closing a visit cannot be undone, so it sits behind opening it — the
   * doctor's one button stays the harmless one. The desk, holding no
   * `consultation:write`, skips straight to it, which is right: they are who
   * closes visits today.
   */
  it('puts finishing a visit behind opening it, for whoever can do both', () => {
    expect(firstDoableStep([RESUME, FINISH], DOCTOR, true)).toEqual(RESUME);
    expect(firstDoableStep([RESUME, FINISH], DESK, true)).toEqual(FINISH);
  });

  it('will not finish a visit on a past day', () => {
    expect(firstDoableStep([FINISH], DESK, false)).toBeNull();
  });

  it('gives somebody who can do everything the blocking step', () => {
    // An administrator who is also the doctor — most small clinics. One button,
    // and it is the one holding everything else up.
    expect(firstDoableStep([COLLECT, RESUME], ADMIN, true)).toEqual(COLLECT);
  });

  it('gives nothing to somebody with nothing to do here', () => {
    // Empty, not disabled: a greyed-out button invites somebody to work out why
    // and there is no answer worth reading.
    expect(firstDoableStep([COLLECT, START], TECHNICIAN, true)).toBeNull();
    expect(firstDoableStep([CHECK_IN], NOBODY, true)).toBeNull();
  });

  it('skips a step the person cannot do and offers the next one they can', () => {
    expect(firstDoableStep([COLLECT, CHECK_IN], holding('appointment:write'), true)).toEqual(
      CHECK_IN,
    );
  });

  it('offers the technician the result once the test is paid for', () => {
    // The server only sends RECORD_RESULT when the bill is clear — an unpaid
    // test sends COLLECT instead, and the technician sees nothing.
    expect(firstDoableStep([RECORD], TECHNICIAN, true)).toEqual(RECORD);
    expect(firstDoableStep([COLLECT], TECHNICIAN, true)).toBeNull();
  });
});

describe('a day that has already happened', () => {
  it('still collects an old bill, because it is still owed', () => {
    expect(firstDoableStep([COLLECT], DESK, false)).toEqual(COLLECT);
  });

  it('still reprints a receipt, which is a copy of what happened', () => {
    expect(firstDoableStep([RECEIPT], DESK, false)).toEqual(RECEIPT);
  });

  it('will not check somebody in, or open a consultation, on a past day', () => {
    // Both would write today's work into the wrong day, against a patient who
    // went home.
    expect(firstDoableStep([CHECK_IN], DESK, false)).toBeNull();
    expect(firstDoableStep([START], DOCTOR, false)).toBeNull();
    expect(firstDoableStep([RESUME], DOCTOR, false)).toBeNull();
    expect(firstDoableStep([RECORD], TECHNICIAN, false)).toBeNull();
  });

  it('falls through to the money step rather than showing the queue one', () => {
    expect(firstDoableStep([CHECK_IN, COLLECT], ADMIN, false)).toEqual(COLLECT);
  });
});

describe('the words on the button', () => {
  it('is a verb for every step, because it is about to do something', () => {
    expect(stepLabel(COLLECT)).toBe('Collect');
    expect(stepLabel(CHECK_IN)).toBe('Check in');
    expect(stepLabel(START)).toBe('Start');
    expect(stepLabel(RESUME)).toBe('Open');
    // Named for what it finishes: a test can also be done, and a visit can
    // also be closed, so a bare "Done" meant one of three things depending on
    // where you were looking.
    expect(stepLabel(FINISH)).toBe('OPD done');
    expect(stepLabel(RECORD)).toBe('Record result');
    expect(stepLabel(RECEIPT)).toBe('Receipt');

    // The two halves of the 22 Oct split. Both are the desk moving a patient
    // on rather than anything clinical, which is why both read as instructions
    // to a receptionist.
    expect(stepLabel(BRING_BACK)).toBe('Bring back in');
    expect(stepLabel(CLOSE_VISIT)).toBe('Close visit');
  });

  it('keeps both new steps behind appointment:write', () => {
    /*
     * Bringing somebody back from a department and sending them home are
     * movements through the clinic. The desk and the DOCTOR both do them —
     * the doctor holds `appointment:write` too, which this test used to deny
     * because the fixture above was missing it.
     *
     * The technician is the honest negative: `diagnostic:result` and nothing
     * that moves a patient.
     */
    expect(firstDoableStep([BRING_BACK], DESK, true)).toEqual(BRING_BACK);
    expect(firstDoableStep([CLOSE_VISIT], DESK, true)).toEqual(CLOSE_VISIT);
    expect(firstDoableStep([BRING_BACK], DOCTOR, true)).toEqual(BRING_BACK);
    expect(firstDoableStep([CLOSE_VISIT], DOCTOR, true)).toEqual(CLOSE_VISIT);
    expect(firstDoableStep([BRING_BACK], TECHNICIAN, true)).toBeNull();
    expect(firstDoableStep([CLOSE_VISIT], TECHNICIAN, true)).toBeNull();
  });

  it('will not move a patient through a day that has already happened', () => {
    // Closing a visit from last Tuesday would record today's decision against
    // a patient who left days ago.
    expect(firstDoableStep([BRING_BACK], DESK, false)).toBeNull();
    expect(firstDoableStep([CLOSE_VISIT], DESK, false)).toBeNull();
  });
});

/**
 * The quiet button beside the primary one.
 *
 * Both halves reported from the clinic on 27 Oct 2026: a doctor and an admin
 * could not finish a visit from the board at all, and a patient who said they
 * could not pay for a test had nowhere to go but the finance desk.
 */
describe('the way out, beside the way on', () => {
  it('gives a doctor OPD done while Open stays the primary', () => {
    // The bug: both hold `consultation:write`, so the primary was always Open
    // and FINISH — which only the front desk ever fell through to — was
    // unreachable for the two roles that run the clinic.
    const steps = [RESUME, FINISH];

    expect(firstDoableStep(steps, DOCTOR, true)).toEqual(RESUME);
    expect(secondaryStep(steps, DOCTOR, true, RESUME)).toEqual(FINISH);
  });

  it('does not show the front desk the same button twice', () => {
    // They hold no `consultation:write`, so OPD done is already their primary.
    const steps = [RESUME, FINISH];
    const primary = firstDoableStep(steps, DESK, true);

    expect(primary).toEqual(FINISH);
    expect(secondaryStep(steps, DESK, true, primary)).toBeNull();
  });

  it('lets an admin close a visit that still owes money', () => {
    // Collect is the primary because money gates what is behind it. Closing
    // with a balance is ALLOWED — it warns and the bill stays open — so
    // hiding it behind the money made that rule unreachable.
    const steps = [COLLECT, CLOSE_VISIT];

    expect(firstDoableStep(steps, ADMIN, true)).toEqual(COLLECT);
    expect(secondaryStep(steps, ADMIN, true, COLLECT)).toEqual(CLOSE_VISIT);
  });

  it('offers the way out for a patient who cannot pay for a test', () => {
    // The row offered Collect and nothing else, so "I cannot pay for it today"
    // was a dead end on the one screen the clinic works from.
    const steps = [COLLECT, DECLINE_TEST];

    expect(secondaryStep(steps, ADMIN, true, COLLECT)).toEqual(DECLINE_TEST);
  });

  it('keeps declining with the money permission, not the clinical one', () => {
    // Taking a charge off a bill is the finance desk's act. A doctor holds
    // `diagnostic:order` and gets the cancel verb instead.
    expect(secondaryStep([DECLINE_TEST], DOCTOR, true, null)).toBeNull();
    expect(secondaryStep([CANCEL_TEST], DOCTOR, true, null)).toEqual(CANCEL_TEST);
  });

  it('will not do any of it on a day that has already happened', () => {
    // Finishing, closing or declining against a patient who went home days ago
    // would record today's decision on the wrong day.
    expect(secondaryStep([RESUME, FINISH], ADMIN, false, null)).toBeNull();
    expect(secondaryStep([COLLECT, CLOSE_VISIT], ADMIN, false, COLLECT)).toBeNull();
    expect(secondaryStep([COLLECT, DECLINE_TEST], ADMIN, false, COLLECT)).toBeNull();
  });
});

/**
 * Where a patient can be sent for a test from.
 *
 * WRITTEN AS A COMPLETE RECORD, not a list, and that is the whole point. The
 * previous version of this rule named four buckets by hand. When `FULFILLED`
 * split into "the doctor has finished" and "the visit is closed" on 22 Oct
 * 2026, the new bucket was simply not in it — and the Send-for-a-test button
 * disappeared for every patient the doctor had finished with, silently, until
 * the clinic reported it five days later.
 *
 * `Record<DayBucket, boolean>` means TypeScript refuses to compile the next
 * time somebody adds a stage without deciding this question. A list would have
 * gone quiet again.
 */
describe('sending a patient for a test', () => {
  const PATIENT_IS_IN_THE_BUILDING: Record<DayBucket, boolean> = {
    // Not arrived. Raising a charge here bills a visit that may never happen.
    EXPECTED: false,
    WAITING: true,
    WITH_DOCTOR: true,
    AT_DEPARTMENT: true,
    // Film is back, waiting to be seen again — the doctor reading it is
    // exactly who decides bloods are needed too.
    BACK_FROM_TESTS: true,
    // The doctor has finished and the patient is still standing there. This is
    // the one the 22 Oct split broke.
    READY_TO_CLOSE: true,
    DONE: true,
    // Cancelled or a no-show. Nobody is chasing them around the clinic.
    NOT_FINISHED: false,
    DID_NOT_COME: false,
    NOT_ATTENDING: false,
  };

  it('is offered wherever the patient is actually here', () => {
    for (const [bucket, expected] of Object.entries(PATIENT_IS_IN_THE_BUILDING)) {
      expect(SENDABLE.has(bucket as DayBucket), bucket).toBe(expected);
    }
  });

  it('covers a patient the doctor has already finished with', () => {
    // The reported bug, pinned on its own: "agar blood test add karna ho, toh
    // nahi ho pa raha hai" after sending the same patient for an X-ray.
    expect(SENDABLE.has('READY_TO_CLOSE')).toBe(true);
    expect(SENDABLE.has('BACK_FROM_TESTS')).toBe(true);
  });
});

/**
 * A way out is never a row's main instruction.
 *
 * Reopening exists because closing is a press on a crowded board and can be a
 * mispress — but a finished patient is not waiting to be reopened, and a
 * department working on a film is not waiting for somebody to cancel it. If
 * these could be the primary, a row with nothing else doable would start
 * telling people to undo things.
 */
describe('escape hatches stay out of the way', () => {
  it('never offers reopening as the thing to do next', () => {
    // A closed visit with nothing else on it. The row should say nothing.
    expect(firstDoableStep([REOPEN_VISIT], ADMIN, true)).toBeNull();
    expect(secondaryStep([REOPEN_VISIT], ADMIN, true, null)).toEqual(REOPEN_VISIT);
  });

  it('never offers cancelling a test as the thing to do next', () => {
    expect(firstDoableStep([CANCEL_TEST], DOCTOR, true)).toBeNull();
    expect(secondaryStep([CANCEL_TEST], DOCTOR, true, null)).toEqual(CANCEL_TEST);
  });

  it('still lets the front desk finish and close as primaries', () => {
    // Those two are NOT escape hatches: for somebody holding no
    // `consultation:write` they genuinely are the next thing to do.
    expect(firstDoableStep([RESUME, FINISH], DESK, true)).toEqual(FINISH);
    expect(firstDoableStep([CLOSE_VISIT], DESK, true)).toEqual(CLOSE_VISIT);
  });

  it('keeps the receipt as the primary on a closed row', () => {
    // Printing is what a finished row is for; reopening sits quietly beside it.
    const steps = [REOPEN_VISIT, RECEIPT];
    const primary = firstDoableStep(steps, DESK, true);

    expect(primary).toEqual(RECEIPT);
    expect(secondaryStep(steps, DESK, true, primary)).toEqual(REOPEN_VISIT);
  });
});
