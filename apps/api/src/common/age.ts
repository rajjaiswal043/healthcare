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
): number | null {
  if (ageYears !== null && ageYears !== undefined) return ageYears;
  if (!birthDate) return null;

  const dob = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return null;

  const now = new Date();
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const months = now.getUTCMonth() - dob.getUTCMonth();
  // Not yet had this year's birthday.
  if (months < 0 || (months === 0 && now.getUTCDate() < dob.getUTCDate())) years -= 1;

  return years >= 0 && years <= 130 ? years : null;
}
