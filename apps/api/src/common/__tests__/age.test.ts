/**
 * An age is a question about the CALENDAR, not about elapsed time.
 *
 * Reported from the clinic on 30 Oct 2026: a patient born 30 Oct 2001 showed 25
 * on the registration screen and 24 once saved. Two separate faults, one on
 * each side — this file pins the server's.
 *
 * `ageFrom` read `new Date()` in UTC. The clinic is in Asia/Kolkata, so for the
 * five and a half hours after local midnight the UTC date is still YESTERDAY,
 * and every patient whose birthday was today came back a year younger. The
 * browser worked in its own local time and got it right, which is exactly why
 * the two screens disagreed.
 *
 * The times below are chosen to sit INSIDE that window: 00:30 IST on 30 Oct is
 * 19:00 UTC on 29 Oct. Fake timers rather than a real clock, so these tests say
 * the same thing in CI at any hour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ageFrom } from '../age.js';

const IST = 'Asia/Kolkata';

afterEach(() => {
  vi.useRealTimers();
});

/** Freeze the clock at an exact instant. */
function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe('an age worked out from a birth date', () => {
  it('counts the birthday on the morning of the birthday', () => {
    // 00:30 IST on 30 Oct 2026 — the half-hour the bug lived in. In UTC it is
    // still 29 Oct, which is what made this 24.
    at('2026-10-29T19:00:00Z');

    expect(ageFrom(null, '2001-10-30', IST)).toBe(25);
  });

  it('still counts it later the same day, when UTC has caught up', () => {
    // 18:00 IST, 12:30 UTC. The old code happened to be right here, which is
    // why this only ever looked intermittent.
    at('2026-10-30T12:30:00Z');

    expect(ageFrom(null, '2001-10-30', IST)).toBe(25);
  });

  it('does not count it the day before', () => {
    at('2026-10-29T12:30:00Z');

    expect(ageFrom(null, '2001-10-30', IST)).toBe(24);
  });

  it('does not count it at 23:30 IST the night before', () => {
    // 18:00 UTC on the 29th is 23:30 IST on the 29th — still not their
    // birthday, and the mirror image of the first case.
    at('2026-10-29T18:00:00Z');

    expect(ageFrom(null, '2001-10-30', IST)).toBe(24);
  });

  it('counts a birthday that has already passed this year', () => {
    at('2026-10-30T12:30:00Z');

    expect(ageFrom(null, '2001-03-12', IST)).toBe(25);
  });

  it('does not count one still to come this year', () => {
    at('2026-10-30T12:30:00Z');

    expect(ageFrom(null, '2001-12-25', IST)).toBe(24);
  });

  it('handles a leap-day birthday without going backwards', () => {
    // Born 29 Feb 2004. On 28 Feb 2026 they have not had a birthday yet this
    // year; on 1 Mar they have.
    at('2026-02-28T12:30:00Z');
    expect(ageFrom(null, '2004-02-29', IST)).toBe(21);

    vi.setSystemTime(new Date('2026-03-01T12:30:00Z'));
    expect(ageFrom(null, '2004-02-29', IST)).toBe(22);
  });

  it('is exact across a span the 365.25-day approximation gets wrong', () => {
    /*
     * The browser's own fault, kept here because it is the same question.
     *
     * Somebody born exactly 25 years ago has lived 9131 days — 25 × 365 plus
     * six leap days — and 25 × 365.25 is 9131.25, so dividing floors to 24 ON
     * THE BIRTHDAY. Counting birthdays cannot be done by averaging a year.
     *
     * The drift is a quarter of a day, so it only bites while fewer than six
     * hours of the birthday have elapsed — by midday the division happens to
     * round back to the right answer. 00:00 UTC on the 30th is 05:30 IST, so
     * the clinic is well into the birthday while the division is still short.
     */
    at('2026-10-30T00:00:00Z');

    const elapsedDays =
      (Date.now() - new Date('2001-10-30T00:00:00Z').getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.floor(elapsedDays / 365.25)).toBe(24); // the old, wrong answer
    expect(ageFrom(null, '2001-10-30', IST)).toBe(25); // the right one
  });
});

describe('an age that was given rather than worked out', () => {
  it('is returned as stated, whatever the clock says', () => {
    // The two columns are alternatives: most Indian OPD patients state an age,
    // and a stated age is not a calculation to be second-guessed.
    at('2026-10-30T12:30:00Z');

    expect(ageFrom(47, null, IST)).toBe(47);
    expect(ageFrom(47, '2001-10-30', IST)).toBe(47);
    expect(ageFrom(0, null, IST)).toBe(0);
  });
});

describe('an age that cannot be worked out', () => {
  it('is null with neither column set', () => {
    expect(ageFrom(null, null, IST)).toBeNull();
    expect(ageFrom(undefined, undefined, IST)).toBeNull();
  });

  it('is null for an unparseable date', () => {
    expect(ageFrom(null, 'not a date', IST)).toBeNull();
  });

  it('is null for a date in the future', () => {
    at('2026-10-30T12:30:00Z');

    // Negative years are not an age, and the commonest cause is a mistyped
    // year on a keyboard.
    expect(ageFrom(null, '2030-01-01', IST)).toBeNull();
  });

  it('is null rather than throwing for a timezone nobody recognises', () => {
    // A bad tenant setting must not take a screen down for a decorative figure.
    expect(ageFrom(null, '2001-10-30', 'Mars/Olympus_Mons')).toBeNull();
  });
});
