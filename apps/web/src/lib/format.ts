/**
 * Display helpers.
 *
 * Lives here rather than in a page file because Next.js App Router restricts
 * page modules to a known set of exports — a stray named export is a build
 * error, not a lint warning.
 */

/**
 * Age for display.
 *
 * Prefers the recorded age over a computed one: if the patient told us "about
 * 45", showing 45 is more honest than deriving a false precision from a date of
 * birth nobody was sure of.
 */
/*
 * `birthDate` is optional because most payloads no longer carry one: the server
 * works the age out and sends the number, so a date of birth does not travel to
 * every screen that draws "47y". The patient's own record still has both.
 */
export function formatAge(p: { ageYears: number | null; birthDate?: string | null }): string {
  if (p.ageYears !== null) return `${p.ageYears}y`;
  if (!p.birthDate) return '—';

  /*
   * CALENDAR ARITHMETIC, not a division.
   *
   * This divided the elapsed milliseconds by 365.25 days until 30 Oct 2026, and
   * that is off by one on the day it matters most. Somebody born exactly 25
   * years ago has lived 9131 days — 25 × 365 plus six leap days — while
   * 25 × 365.25 is 9131.25, so the division floored to 24 ON THEIR BIRTHDAY.
   * Reported from the clinic alongside the server's own age bug: a patient born
   * 30 Oct 2001 read 25 on the registration screen and 24 once saved.
   *
   * An age is "how many birthdays have happened", which is a question about the
   * calendar and cannot be answered by averaging the length of a year.
   */
  const dob = new Date(p.birthDate);
  if (Number.isNaN(dob.getTime())) return '—';

  const now = new Date();
  let years = now.getFullYear() - dob.getUTCFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const bornMonth = dob.getUTCMonth() + 1;
  const bornDay = dob.getUTCDate();
  if (month < bornMonth || (month === bornMonth && day < bornDay)) years -= 1;

  return years >= 0 && years <= 130 ? `${years}y` : '—';
}

export function genderInitial(gender: string): string {
  return gender === 'UNKNOWN' ? '?' : (gender.charAt(0) ?? '?');
}

/**
 * Paise → "₹500.00".
 *
 * The ONLY place money becomes a display string. Everything else — the API, the
 * client, the components — works in integer paise, because a division scattered
 * through the UI is a rounding error waiting to disagree with the cash drawer.
 *
 * Indian digit grouping (₹1,00,000 rather than ₹100,000) comes from the en-IN
 * locale, which is what a clinic expects to read.
 */
export function formatPaise(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(paise / 100);
}

/**
 * "500" or "500.50" → paise, or null if it is not a number.
 *
 * Parsing happens once, here, on the way in. `Math.round` is what stops
 * `4.35 * 100 = 434.99999999999994` becoming 434 paise.
 */
export function parseRupeesToPaise(input: string): number | null {
  const trimmed = input.trim().replace(/[₹,\s]/g, '');
  if (trimmed === '') return null;

  const rupees = Number(trimmed);
  if (!Number.isFinite(rupees) || rupees < 0) return null;

  return Math.round(rupees * 100);
}

/**
 * How a doctor is named on screen.
 *
 * Just the name as the clinic typed it. There is a `prefix` column that used to
 * be rendered in front of this and defaulted to "Dr"; it produced
 * "Dr Dr. Vivek Swarnkar" for any administrator who typed the honorific
 * themselves, and it was wrong for a physiotherapist. The clinic knows who is a
 * Dr and who is a Ms, so the clinic types it.
 *
 * A function rather than reading `.fullName` at each of a dozen call sites,
 * because "how is a doctor named" is one decision and this is where it lives.
 */
export function doctorName(practitioner: { fullName: string } | null | undefined): string {
  return practitioner?.fullName ?? '';
}

/**
 * CASH -> "Cash", BANK_TRANSFER -> "Bank transfer".
 *
 * Derived rather than mapped, so a payment mode added to the enum reads
 * correctly on every screen the day it exists instead of falling through to a
 * raw SHOUTING_CASE string.
 */
export function payMethodLabel(mode: string): string {
  const words = mode.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
