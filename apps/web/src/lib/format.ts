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
