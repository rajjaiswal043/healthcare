import { describe, expect, it } from 'vitest';
import { estimatePosition, minutesPerPatient, DEFAULT_CONSULT_MINUTES } from './queue-estimate.js';
import { checkinDates, flagFor } from './recovery.js';

const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00+05:30`);

function row(id: string, status: string, start: string, called?: string, done?: string) {
  return {
    id,
    status,
    startAt: at(start),
    calledAt: called ? at(called) : null,
    completedAt: done ? at(done) : null,
  };
}

describe('minutesPerPatient', () => {
  it('uses the default before anybody has been seen', () => {
    expect(minutesPerPatient([])).toBe(DEFAULT_CONSULT_MINUTES);
  });

  it('averages finished visits and clamps the silly ones', () => {
    expect(minutesPerPatient([row('a', 'FULFILLED', '09:00', '09:00', '09:12')])).toBe(12);
    expect(minutesPerPatient([row('a', 'FULFILLED', '09:00', '09:00', '13:00')])).toBe(45);
    expect(minutesPerPatient([row('a', 'FULFILLED', '09:00', '09:00', '09:00')])).toBe(3);
  });
});

describe('estimatePosition', () => {
  const inRoom = row('r', 'IN_PROGRESS', '09:00', '09:05');
  const w1 = row('w1', 'ARRIVED', '09:15');
  const w2 = row('w2', 'ARRIVED', '09:30');

  it('counts the room and everybody ahead in the waiting list', () => {
    const e = estimatePosition({
      appointment: w2,
      waitingInOrder: [w1, w2],
      inProgress: inRoom,
      bookedToday: [],
      allToday: [inRoom, w1, w2],
      now: at('09:10'),
    });
    expect(e.ahead).toBe(2);
    expect(e.etaMinutes).toBe(2 * DEFAULT_CONSULT_MINUTES);
  });

  it('never tells somebody at home to come before their own slot', () => {
    const home = row('h', 'BOOKED', '12:00');
    const e = estimatePosition({
      appointment: home,
      waitingInOrder: [],
      inProgress: null,
      bookedToday: [home],
      allToday: [home],
      now: at('09:00'),
    });
    expect(e.ahead).toBe(0);
    expect(e.etaMinutes).toBe(180);
  });

  it('puts somebody at home behind the waiting room when the queue is long', () => {
    const home = row('h', 'BOOKED', '09:20');
    const e = estimatePosition({
      appointment: home,
      waitingInOrder: [w1, w2],
      inProgress: inRoom,
      bookedToday: [home],
      allToday: [inRoom, w1, w2, home],
      now: at('09:10'),
    });
    expect(e.ahead).toBe(3);
    expect(e.etaMinutes).toBe(30);
  });
});

describe('flagFor', () => {
  it('flags severe pain whatever came before', () => {
    expect(flagFor(8, null)).toMatch(/Severe/);
  });

  it('flags a rise of two or more, and nothing smaller', () => {
    expect(flagFor(6, 4)).toBe('Pain rising, 4 → 6');
    expect(flagFor(5, 4)).toBeNull();
    expect(flagFor(3, 7)).toBeNull();
  });
});

describe('checkinDates', () => {
  it('runs every N days from the visit and stops before the review', () => {
    expect(checkinDates('2026-10-01', '2026-10-10', 3)).toEqual(['2026-10-04', '2026-10-07']);
  });

  it('is empty when the review is sooner than the first check-in', () => {
    expect(checkinDates('2026-10-01', '2026-10-02', 3)).toEqual([]);
  });
});
