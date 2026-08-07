/**
 * Clinic-local time.
 *
 * Schedule templates store wall-clock strings ("09:15") with no timezone;
 * appointments store instants. This module is the conversion between them, and
 * getting it wrong shifts every appointment in the system by five and a half
 * hours — the kind of bug that looks like "the queue is empty" rather than an
 * error.
 *
 * Written against Intl rather than adding a date library: the conversions needed
 * here are few and the dependency would be permanent.
 */

/** Milliseconds a timezone is ahead of UTC at a given instant. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');

  // Intl gives us the local wall-clock reading of `instant`. Interpreting that
  // reading AS IF it were UTC and subtracting the real instant yields the offset.
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Intl renders midnight as hour 24 in some locales/engines.
    get('hour') % 24,
    get('minute'),
    get('second'),
  );

  return asIfUtc - instant.getTime();
}

/**
 * Converts a clinic-local date and wall-clock time to an instant.
 *
 * @param date  "YYYY-MM-DD" in the clinic's timezone
 * @param time  "HH:mm" in the clinic's timezone
 */
export function localToInstant(date: string, time: string, timeZone: string): Date {
  const naive = new Date(`${date}T${time.length === 5 ? time : time.slice(0, 5)}:00Z`);

  // First pass uses the offset at the naive instant; the second corrects for the
  // case where that instant falls on the other side of a DST transition. India
  // has no DST, but a wrong answer twice a year is not something to leave in for
  // the first customer who does.
  const firstPass = new Date(naive.getTime() - offsetMsAt(naive, timeZone));
  return new Date(naive.getTime() - offsetMsAt(firstPass, timeZone));
}

/** The clinic-local calendar date of an instant, as "YYYY-MM-DD". */
export function instantToLocalDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is what Postgres wants for a date.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The clinic-local wall-clock time of an instant, as "HH:mm". */
export function instantToLocalTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
}

/** Day of week in the clinic's timezone. 0 = Sunday, matching JS getDay(). */
export function localDayOfWeek(date: string, timeZone: string): number {
  const noon = localToInstant(date, '12:00', timeZone);
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(noon);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const index = days.indexOf(name);
  if (index === -1) throw new Error(`Could not resolve weekday for ${date} in ${timeZone}`);
  return index;
}

/** "09:15" -> 555 minutes past midnight. */
export function timeToMinutes(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/** 555 -> "09:15". Wraps past midnight, which sessions should never do. */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Today in the clinic's timezone, as "YYYY-MM-DD". */
export function clinicToday(timeZone: string): string {
  return instantToLocalDate(new Date(), timeZone);
}

/** True when two [start, end) minute ranges overlap. Touching ends do not. */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
