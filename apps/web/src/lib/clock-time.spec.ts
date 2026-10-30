/**
 * What a clinic is allowed to type into a session's From and To.
 *
 * Reported from the clinic on 30 Oct 2026: the setup screen took `09:00` and
 * nothing else, so a clinic that thinks in "9 to 1" translated every session by
 * hand. Storage is unchanged — 24-hour `HH:MM` is still the column, the API and
 * what the availability engine compares — so these tests are about the typing
 * and the reading back, which is where the mistakes live.
 */

import { describe, expect, it } from 'vitest';
import { formatClockRange, formatClockTime, parseClockTime } from './clock-time';

describe('reading a typed time', () => {
  it('takes 24-hour, which is what it always took', () => {
    expect(parseClockTime('09:00')).toBe('09:00');
    expect(parseClockTime('13:30')).toBe('13:30');
    expect(parseClockTime('00:00')).toBe('00:00');
    expect(parseClockTime('23:59')).toBe('23:59');
  });

  it('takes 12-hour with am and pm', () => {
    expect(parseClockTime('9am')).toBe('09:00');
    expect(parseClockTime('9 AM')).toBe('09:00');
    expect(parseClockTime('9:30 am')).toBe('09:30');
    expect(parseClockTime('1pm')).toBe('13:00');
    expect(parseClockTime('1:45 PM')).toBe('13:45');
  });

  it('gets noon and midnight right', () => {
    // The two the hour-plus-twelve shortcut gets wrong.
    expect(parseClockTime('12am')).toBe('00:00');
    expect(parseClockTime('12:00 AM')).toBe('00:00');
    expect(parseClockTime('12pm')).toBe('12:00');
    expect(parseClockTime('12:30 pm')).toBe('12:30');
  });

  it('takes a bare hour as 24-hour', () => {
    // Somebody typing into a clinic setup field means nine in the morning and
    // one in the afternoon, which is what the unsuffixed reading gives.
    expect(parseClockTime('9')).toBe('09:00');
    expect(parseClockTime('13')).toBe('13:00');
  });

  it('takes a full stop as well as a colon', () => {
    expect(parseClockTime('9.30')).toBe('09:30');
    expect(parseClockTime('9.30 pm')).toBe('21:30');
  });

  it('pads a single-digit minute', () => {
    expect(parseClockTime('9:5')).toBe('09:05');
  });

  it('refuses an impossible hour or minute', () => {
    expect(parseClockTime('24:00')).toBeNull();
    expect(parseClockTime('25')).toBeNull();
    expect(parseClockTime('09:60')).toBeNull();
  });

  it('refuses a contradictory am or pm rather than guessing', () => {
    // A session at an hour the clinic did not choose is worse than a refusal.
    expect(parseClockTime('13pm')).toBeNull();
    expect(parseClockTime('0am')).toBeNull();
    expect(parseClockTime('15 am')).toBeNull();
  });

  it('refuses things that are not times at all', () => {
    expect(parseClockTime('')).toBeNull();
    expect(parseClockTime('   ')).toBeNull();
    expect(parseClockTime('morning')).toBeNull();
    expect(parseClockTime('9:00:00')).toBeNull();
    expect(parseClockTime('9-30')).toBeNull();
  });
});

describe('showing a stored time back', () => {
  it('reads a 24-hour time as a clinic would say it', () => {
    expect(formatClockTime('09:00')).toBe('9:00 AM');
    expect(formatClockTime('13:30')).toBe('1:30 PM');
    expect(formatClockTime('21:05')).toBe('9:05 PM');
  });

  it('says 12, not 0, at noon and midnight', () => {
    expect(formatClockTime('00:00')).toBe('12:00 AM');
    expect(formatClockTime('12:00')).toBe('12:00 PM');
  });

  it('hands back anything it does not recognise, untouched', () => {
    // A display helper must never be the thing that blanks a screen.
    expect(formatClockTime('')).toBe('');
    expect(formatClockTime('not a time')).toBe('not a time');
    expect(formatClockTime('99:99')).toBe('99:99');
  });

  it('says a session the way the clinic says it', () => {
    expect(formatClockRange('09:00', '13:00')).toBe('9:00 AM – 1:00 PM');
  });
});

describe('typing it and reading it back agree', () => {
  it('survives the round trip for every hour and half-hour', () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of ['00', '30']) {
        const stored = `${String(hour).padStart(2, '0')}:${minute}`;

        // Shown to somebody, typed back in by somebody, and still the same time.
        expect(parseClockTime(formatClockTime(stored))).toBe(stored);
      }
    }
  });
});
