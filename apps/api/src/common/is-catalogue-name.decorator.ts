import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * At least two letters, in any script.
 *
 * Exported for the tests, which assert the rule directly as well as through the
 * endpoints that use it.
 */
export function looksLikeAThingName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return (value.match(/\p{L}/gu) ?? []).length >= 2;
}

/**
 * A test, service or price in the catalogue has a NAME, not a number.
 *
 * `@MinLength(2)` alone accepted "12", "999" and "@@" as the name of a test,
 * reported from the clinic on 30 Oct 2026 from two screens that write the same
 * column: Settings → Departments → add a test, and Settings → Prices. What it
 * produces is a line on a patient's bill, a row on the department's worklist and
 * an entry in a dropdown, none of which anybody can read, search for or explain
 * afterwards.
 *
 * **Two letters, not "no digits".** Catalogue names carry digits constantly and
 * must go on doing so — "2D Echo", "12-lead ECG", "X-Ray Chest PA", "Vitamin
 * B12", "CAMP50". The defect is a name with no name in it, and banning numerals
 * would refuse all of those to catch "999".
 *
 * **`\p{L}`, not `[A-Za-z]`.** Same reasoning as the person-name rule: a clinic
 * naming a test in Devanagari is doing nothing wrong, and an ASCII-only rule
 * would reject it while accepting "...".
 *
 *     rejects   "12"   "999"   "..."   "@@"   "--"   "   "
 *     accepts   "2D Echo"   "12-lead ECG"   "X-Ray Chest PA"   "CAMP50"   "रक्त जाँच"
 *
 * SEPARATE FROM `IsPersonName` on purpose, though the test is the same today.
 * That one guards a human being's name and its examples are apostrophes and
 * hyphens; this one guards a catalogue entry and its examples are digits. They
 * will not necessarily move together, and a shared decorator would make either
 * change silently alter the other.
 */
export function IsCatalogueName(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isCatalogueName',
      target: object.constructor,
      propertyName,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => looksLikeAThingName(value),
        defaultMessage: () => 'must be a name: it needs at least two letters in it',
      },
    });
  };
}
