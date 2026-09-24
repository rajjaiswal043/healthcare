import { describe, expect, it } from 'vitest';
import {
  instantToLocalDate,
  instantToLocalTime,
  localDayOfWeek,
  localToInstant,
  minutesToTime,
  rangesOverlap,
  timeToMinutes,
} from '../clinic-time.js';

/**
 * These conversions sit between "09:15 on Tuesday" and an instant in the
 * database. An off-by-one-timezone bug here does not throw — it silently books
 * everyone five and a half hours out and shows an empty queue, which is much
 * harder to spot than a crash.
 */

const IST = 'Asia/Kolkata';

describe('localToInstant', () => {
  it('converts clinic-local wall clock to the right UTC instant', () => {
    // 09:00 IST is 03:30 UTC — India is UTC+5:30.
    expect(localToInstant('2026-08-07', '09:00', IST).toISOString()).toBe(
      '2026-08-07T03:30:00.000Z',
    );
  });

  it('handles times that cross midnight UTC', () => {
    // 02:00 IST is 20:30 UTC on the PREVIOUS day.
    expect(localToInstant('2026-08-07', '02:00', IST).toISOString()).toBe(
      '2026-08-06T20:30:00.000Z',
    );
  });

  it('round-trips through instantToLocalTime', () => {
    for (const time of ['00:00', '09:15', '13:30', '17:45', '23:59']) {
      const instant = localToInstant('2026-08-07', time, IST);
      expect(instantToLocalTime(instant, IST)).toBe(time);
    }
  });

  it('works for a timezone that observes DST', () => {
    // London in August is BST (UTC+1), so 09:00 local is 08:00 UTC.
    expect(localToInstant('2026-08-07', '09:00', 'Europe/London').toISOString()).toBe(
      '2026-08-07T08:00:00.000Z',
    );
    // ...and in January it is GMT, so 09:00 local is 09:00 UTC. This is the case
    // the two-pass offset correction exists for.
    expect(localToInstant('2026-01-07', '09:00', 'Europe/London').toISOString()).toBe(
      '2026-01-07T09:00:00.000Z',
    );
  });
});

describe('instantToLocalDate', () => {
  it('reports the clinic-local date, not the UTC one', () => {
    // 20:30 UTC on the 6th is 02:00 IST on the 7th. A clinic in Pune closing at
    // 8pm must not see those appointments filed under yesterday.
    const instant = new Date('2026-08-06T20:30:00.000Z');
    expect(instantToLocalDate(instant, IST)).toBe('2026-08-07');
    expect(instantToLocalDate(instant, 'UTC')).toBe('2026-08-06');
  });
});

describe('localDayOfWeek', () => {
  it('matches JavaScript getDay() numbering', () => {
    // 2026-08-07 is a Friday.
    expect(localDayOfWeek('2026-08-07', IST)).toBe(5);
    expect(localDayOfWeek('2026-08-09', IST)).toBe(0); // Sunday
    expect(localDayOfWeek('2026-08-10', IST)).toBe(1); // Monday
  });
});

describe('minute helpers', () => {
  it('converts both ways', () => {
    expect(timeToMinutes('09:15')).toBe(555);
    expect(minutesToTime(555)).toBe('09:15');
    expect(timeToMinutes('00:00')).toBe(0);
    expect(minutesToTime(0)).toBe('00:00');
  });
});

describe('rangesOverlap', () => {
  it('treats touching ranges as NOT overlapping', () => {
    // A 09:00-09:15 slot and a 09:15-09:30 slot are adjacent, not conflicting.
    // Getting this wrong halves every doctor's availability.
    expect(rangesOverlap(540, 555, 555, 570)).toBe(false);
  });

  it('detects genuine overlap', () => {
    expect(rangesOverlap(540, 570, 555, 585)).toBe(true);
    expect(rangesOverlap(540, 600, 550, 560)).toBe(true); // fully contained
  });
});
