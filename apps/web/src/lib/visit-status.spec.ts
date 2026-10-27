/**
 * How a visit reads on a patient's record.
 *
 * The case that matters is the first describe: nothing in the clinic marks a
 * no-show, so "booked" is what a missed appointment looks like in the database
 * for ever, and the record has to stop saying it in the present tense.
 *
 * No dates here on purpose. Whether the clinic's day is over is the server's
 * question, because only the server knows the clinic's timezone — so this side
 * takes the answer as a flag, and the tests are the same in every zone.
 */

import { describe, expect, it } from 'vitest';
import { VISIT_STATUS_LABEL, VISIT_STATUS_TONE, effectiveVisitStatus } from './visit-status';

function label(status: string, missed = false) {
  return VISIT_STATUS_LABEL[effectiveVisitStatus(status, missed)];
}

function tone(status: string, missed = false) {
  return VISIT_STATUS_TONE[effectiveVisitStatus(status, missed)];
}

describe('a visit still booked', () => {
  it('did not come, once the clinic says its day is over', () => {
    expect(label('BOOKED', true)).toBe('Did not come');
  });

  it('is still simply booked until then', () => {
    // Somebody twenty minutes late has not failed to turn up, and neither has
    // somebody booked for next Tuesday.
    expect(label('BOOKED', false)).toBe('Booked');
  });

  it('is drawn as a visit that did not happen, not as a neutral one', () => {
    expect(tone('BOOKED', false)).toBe('badge-neutral');
    expect(tone('BOOKED', true)).toBe('badge-coral');
  });
});

describe('a status that was actually recorded', () => {
  it('is reported as it stands, even if the day is long gone', () => {
    expect(label('FULFILLED', true)).toBe('Finished');
    expect(label('CANCELLED', true)).toBe('Cancelled');
    expect(label('ARRIVED', true)).toBe('Waiting');
    expect(label('IN_PROGRESS', true)).toBe('With the doctor');
    expect(label('AWAITING_TESTS', true)).toBe('At a department');
  });

  it('calls a recorded no-show what the board calls an inferred one', () => {
    // Two words for one fact would imply they were two different facts.
    expect(label('NO_SHOW')).toBe('Did not come');
    expect(label('BOOKED', true)).toBe('Did not come');
  });
});

describe('nothing reads as an enum', () => {
  it('has no underscores and no shouting in any label', () => {
    for (const text of Object.values(VISIT_STATUS_LABEL)) {
      expect(text).not.toContain('_');
      expect(text).not.toBe(text.toUpperCase());
    }
  });

  it('falls back to Booked for a status it has never heard of', () => {
    // A status added to the enum later must not reach the screen as raw text.
    expect(label('SOMETHING_NEW')).toBe('Booked');
  });
});
