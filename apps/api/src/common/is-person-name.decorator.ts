import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * At least two letters, in any script.
 *
 * Exported for the tests, which assert the rule directly as well as through
 * the endpoints that use it.
 */
export function looksLikeAPersonName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return countLetters(value) >= 2;
}

function countLetters(value: string): number {
  return (value.match(/\p{L}/gu) ?? []).length;
}

/**
 * A person's name has letters in it.
 *
 * `@MinLength(2)` alone accepted "12345" as a member of staff, reported by the
 * front desk on 28 Sep 2026. The failure it guards against is somebody typing a
 * mobile number or a patient ID into the name box — which produces a record
 * nobody can search for, greet, or merge, and which reads as a bug in whatever
 * screen shows it next.
 *
 * **Two letters, not "no digits".** The defect is a name with no name in it, not
 * the presence of a numeral: "Ram 2nd" is unusual and real, while a mistyped
 * mobile number has no letters at all. Banning digits would refuse the first to
 * catch the second.
 *
 * **`\p{L}`, not `[A-Za-z]`.** A clinic recording a patient in Devanagari,
 * Tamil or Bengali is doing nothing wrong, and an ASCII-only rule would reject
 * every one of those names while accepting "..." — precisely backwards for an
 * Indian product.
 *
 *     rejects   "12345"   "999"   "..."   "@@"   "7"   "   "
 *     accepts   "Ram"   "D'Souza"   "Anne-Marie"   "Dr. A.P.J. Kalam"   "नरवीर"
 *
 * Used for people only. Promotions, services, departments and rooms legitimately
 * carry digits and no letters — "CAMP50", "Ward 3" — and must not get this rule.
 */
export function IsPersonName(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isPersonName',
      target: object.constructor,
      propertyName,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => looksLikeAPersonName(value),
        defaultMessage: () => 'must be a name — it needs at least two letters in it',
      },
    });
  };
}
