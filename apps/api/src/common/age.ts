/**
 * An age in whole years, from whichever of the two columns is set.
 *
 * `patient.age_years` and `patient.birth_date` are alternatives, not a pair:
 * most Indian OPD patients give an age, and somebody who knows their birthday
 * gives that instead. Anything that wants to SHOW an age has to read both.
 *
 * SEND THIS, NOT THE DATE. A date of birth is a materially stronger identifier
 * than "47y" — it is the field that turns a name into a match against other
 * records — and the screens that show an age never need more than the number.
 * The day board alone goes to six roles, so a birth date on that payload is a
 * birth date in front of every person in the clinic, to draw a figure that
 * fits in three characters. Worked out here and sent as a number instead.
 */
export function ageFrom(
  ageYears: number | null | undefined,
  birthDate: Date | string | null | undefined,
  /**
   * The CLINIC's timezone, not the server's.
   *
   * This read `new Date()` in UTC until 30 Oct 2026, and the clinic is in
   * Asia/Kolkata — so for the five and a half hours after midnight IST, UTC was
   * still on yesterday's date and every patient whose birthday was today came
   * back a year younger. Reported from the clinic: a patient born 30 Oct 2001
   * showed 25 on the registration screen, which works in the browser's own
   * time, and 24 everywhere the server had worked it out.
   *
   * A date of birth is a calendar fact, so it has to be compared against the
   * calendar the clinic is living in.
   */
  timeZone: string,
): number | null {
  if (ageYears !== null && ageYears !== undefined) return ageYears;
  if (!birthDate) return null;

  const dob = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return null;

  /*
   * `birth_date` is a DATE column, which arrives as midnight UTC — so its
   * calendar parts are the UTC ones and must NOT be shifted into a timezone.
   * Only "today" needs converting.
   */
  const bornYear = dob.getUTCFullYear();
  const bornMonth = dob.getUTCMonth() + 1;
  const bornDay = dob.getUTCDate();

  const today = clinicDateParts(new Date(), timeZone);
  if (!today) return null;

  let years = today.year - bornYear;
  // Not yet had this year's birthday.
  if (today.month < bornMonth || (today.month === bornMonth && today.day < bornDay)) {
    years -= 1;
  }

  return years >= 0 && years <= 130 ? years : null;
}

/**
 * Today's calendar parts in a given timezone.
 *
 * `en-CA` formats as `YYYY-MM-DD`, which is the one locale that needs no
 * parsing games. Returns null rather than throwing on an unknown zone, because
 * an age is decoration and a bad tenant setting should not take a screen down.
 */
function clinicDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } | null {
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    return null;
  }

  const [year, month, day] = formatted.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  return { year, month, day };
}
