/**
 * A clinic's patient ID format, as the browser previews it.
 *
 * A mirror, not the authority. The database decides: `next_uhid()` builds the
 * ID and CHECK constraints on `tenant` refuse a bad format. The API states the
 * same rules in `apps/api/src/platform/tier/uhid-format.ts` to word its errors.
 * This copy exists so somebody choosing a format can SEE it before it is
 * permanent — the requirement's whole point: a format you cannot see is a
 * format you choose wrong. If a rule changes, change all three.
 */
export const UHID_PREFIX_MAX = 8;
export const UHID_WIDTH_MIN = 3;
export const UHID_WIDTH_MAX = 8;
export const UHID_WIDTH_DEFAULT = 5;

/**
 * What the ID for patient `n` will be.
 *
 * Padded when short, and NEVER cut when long — exactly as `next_uhid()` does
 * since 15 Sep 2026. DRVIV-9999 is followed by DRVIV-10000, not by DRVIV-1000
 * a second time.
 */
export function formatUhid(prefix: string, width: number, n: number): string {
  const digits = String(n);
  return prefix + (digits.length < width ? digits.padStart(width, '0') : digits);
}

/**
 * The prefix a clinic gets when nobody chooses one: three letters of its name.
 * Mirrors `defaultPrefix` in the onboarding service.
 */
export function derivePrefix(clinicName: string): string {
  const letters = clinicName.replace(/[^a-zA-Z]/g, '');
  return (letters.slice(0, 3) || 'HC').toUpperCase();
}

/**
 * Everything wrong with a prefix, in words, or an empty list.
 *
 * Every problem at once rather than the first, so fixing one does not uncover
 * the next only after another round trip.
 */
export function uhidPrefixProblems(prefix: string): string[] {
  const problems: string[] = [];

  if (prefix === '') return ['Give the patient IDs a prefix.'];
  if (prefix.length > UHID_PREFIX_MAX) problems.push(`At most ${UHID_PREFIX_MAX} characters.`);
  if (!/^[A-Z0-9/-]*$/.test(prefix)) problems.push('Only letters, digits, - and /.');
  if (!/^[A-Z]/.test(prefix)) problems.push('Must start with a letter.');
  // The one that matters: DRV1 + 05 and DRV + 105 are both DRV105.
  if (/[0-9]$/.test(prefix))
    problems.push('Cannot end in a digit — put a - or / after it, like DRV1-.');

  return problems;
}
