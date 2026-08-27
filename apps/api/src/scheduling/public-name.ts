/**
 * A patient's name, shortened for a screen a whole waiting room can read.
 *
 * "Kavita Sharma" becomes "Kavita S." — enough for the person it belongs to to
 * recognise themselves from across the room, not enough for a stranger to
 * identify them, repeat them, or look them up afterwards.
 *
 * **Masking happens here, on the server, and the full name never leaves it.**
 * That is the whole point and it is not a rendering preference: a payload that
 * carries "Kavita Sharma" to an unauthenticated screen has already disclosed it,
 * whatever the television chooses to paint. `display.e2e.test.ts` asserts the
 * surname is absent from the response body rather than absent from the markup.
 *
 * Narveer asked for names on the board on 26 Aug 2026, having originally had it
 * built with numbers only. This is the middle ground he chose.
 */
export function publicPatientName(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);

  const first = words[0];
  if (!first) return '';

  // One word is all we were given. Nothing to abbreviate, and inventing an
  // initial would be worse than showing what the clinic recorded.
  if (words.length === 1) return first;

  const last = words[words.length - 1];

  // The LAST word, not the second: "Farida Sheikh Khan" is Farida K., which is
  // how she would be addressed. Taking the middle name would be wrong in a way
  // nobody would report as a bug — they would just stop trusting the board.
  return `${first} ${(last ?? '').charAt(0).toUpperCase()}.`;
}
