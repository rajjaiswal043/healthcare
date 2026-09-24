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
export function formatAge(p: { ageYears: number | null; birthDate: string | null }): string {
  if (p.ageYears !== null) return `${p.ageYears}y`;
  if (!p.birthDate) return '—';

  const years = Math.floor(
    (Date.now() - new Date(p.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000),
  );
  return Number.isFinite(years) ? `${years}y` : '—';
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
