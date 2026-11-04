/**
 * Clock times a clinic can type, in either format.
 *
 * Doctors' sessions are stored and sent as 24-hour `HH:MM` — that is the
 * column, the API contract and the thing the availability engine compares
 * against, and none of that changes here. What changed on 30 Oct 2026 is what
 * somebody is allowed to TYPE: the setup screen took `09:00` and nothing else,
 * and a clinic that thinks in "9 to 1" had to translate every session by hand.
 * Reported from the clinic.
 *
 * PARSE WIDELY, STORE ONE WAY, SHOW THE READING BACK. The screen displays what
 * it understood ("9:00 AM") next to the box, because a parser that silently
 * turns "1:00" into one in the morning when the doctor meant the afternoon is
 * worse than one that refuses.
 */

/** `HH:MM`, 24-hour, zero-padded — the only shape that leaves this module. */
export type ClockTime = string;

/**
 * Read a typed time, or null if it is not one.
 *
 * Accepts `9`, `9:30`, `09:30`, `9am`, `9 AM`, `9:30pm`, `9.30 pm`, `12:00 AM`.
 * A bare number is taken as 24-hour, so `13` is one in the afternoon and `9` is
 * nine in the morning — which is what somebody typing into a field labelled
 * "From" on a clinic setup screen means.
 *
 * AMBIGUITY IS REFUSED, not guessed: `13pm` and `0am` are not times, and a
 * clinic is better told so than given a session at an hour it did not choose.
 */
export function parseClockTime(input: string): ClockTime | null {
  const text = input.trim().toLowerCase();
  if (text === '') return null;

  const match = /^(\d{1,2})(?:[:.](\d{1,2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;

  const rawHour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const suffix = match[3];

  if (!Number.isInteger(rawHour) || !Number.isInteger(minute)) return null;
  if (minute > 59) return null;

  let hour = rawHour;

  if (suffix) {
    // With am/pm the hour is a 12-hour clock reading, so 0 and 13+ are typos.
    if (rawHour < 1 || rawHour > 12) return null;
    if (suffix === 'am') hour = rawHour === 12 ? 0 : rawHour;
    else hour = rawHour === 12 ? 12 : rawHour + 12;
  } else if (rawHour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * `09:00` as "9:00 AM", for showing a stored time back to somebody.
 *
 * Returns the input untouched if it is not a time this module produced — a
 * display helper must never be the thing that blanks a screen.
 */
export function formatClockTime(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return time;

  const hour = Number(match[1]);
  const minute = match[2]!;
  if (hour > 23) return time;

  const suffix = hour < 12 ? 'AM' : 'PM';
  // Midnight and noon are 12, not 0 — the one case a modulo gets wrong.
  const shown = hour % 12 === 0 ? 12 : hour % 12;

  return `${shown}:${minute} ${suffix}`;
}

/** Both ends of a session, as a clinic would say it: "9:00 AM – 1:00 PM". */
export function formatClockRange(from: string, to: string): string {
  return `${formatClockTime(from)} – ${formatClockTime(to)}`;
}
