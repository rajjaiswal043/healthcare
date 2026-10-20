/**
 * Which button each person gets.
 *
 * The server sends what the PATIENT needs, most blocking first. This picks the
 * first of those the person looking may actually do — which is the whole reason
 * one board can serve a desk, a doctor and a technician without any of them
 * being shown a control the API would refuse.
 */

import { describe, expect, it } from 'vitest';
import type { NextStep } from '@/lib/api';
import { firstDoableStep, stepLabel } from './next-step';

/** A person who holds exactly these permissions. */
const holding =
  (...permissions: string[]) =>
  (permission: string) =>
    permissions.includes(permission);

const DESK = holding('payment:collect', 'invoice:read', 'appointment:write');
const DOCTOR = holding('consultation:write', 'diagnostic:order');
const TECHNICIAN = holding('diagnostic:result');
const ADMIN = () => true;
const NOBODY = () => false;

const COLLECT: NextStep = { kind: 'COLLECT', invoiceId: 'inv-1', duePaise: 50000 };
const CHECK_IN: NextStep = { kind: 'CHECK_IN', appointmentId: 'appt-1' };
const START: NextStep = { kind: 'START', appointmentId: 'appt-1' };
const RESUME: NextStep = { kind: 'RESUME', appointmentId: 'appt-1' };
const FINISH: NextStep = { kind: 'FINISH', appointmentId: 'appt-1' };
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
    expect(stepLabel(FINISH)).toBe('Done');
    expect(stepLabel(RECORD)).toBe('Record result');
    expect(stepLabel(RECEIPT)).toBe('Receipt');
  });
});
