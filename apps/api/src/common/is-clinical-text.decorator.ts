import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * At least two letters, in any script.
 *
 * Exported for the tests, which assert the rule directly as well as through the
 * endpoints that use it.
 */
export function looksLikeClinicalText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Empty is somebody clearing the field, which is not the same as nonsense.
  if (value.trim() === '') return true;

  return (value.match(/\p{L}/gu) ?? []).length >= 2;
}

/**
 * A diagnostic report says something.
 *
 * Three letters rather than two, which is the whole difference from
 * `looksLikeClinicalText`: "EE" was accepted as a complete X-ray report and
 * reported from the clinic on 28 Oct 2026. Three lets through the short reports
 * a radiologist genuinely writes — NAD, "Normal" — and stops a keyboard mash.
 *
 * It cannot make a report MEANINGFUL. "AAAA" passes this and passes any rule
 * that could reasonably be written; what stops that is the doctor who reads it.
 */
export function looksLikeAReport(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Blank is a result that is an image and nothing else, which is legitimate:
  // the service refuses an order with neither a file nor a note.
  if (value.trim() === '') return true;

  return (value.match(/\p{L}/gu) ?? []).length >= 3;
}

export function IsReportText(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isReportText',
      target: object.constructor,
      propertyName,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => looksLikeAReport(value),
        defaultMessage: () => 'needs at least three letters in it',
      },
    });
  };
}

/**
 * A clinical narrative has words in it.
 *
 * `@IsString() @MaxLength()` accepted "123" as a chief complaint, reported by
 * the testing team on 27 Oct 2026. What it guards against is a number typed
 * into the wrong box — a token, a reading, a mobile — which then prints on the
 * prescription as the reason the patient came.
 *
 * **Two letters, not "no digits".** The same reasoning as `IsPersonName`, and
 * it matters more here: "2 days of knee pain", "BP 140/90 since Jan" and
 * "T2DM x 5y" are exactly how a doctor writes, and a rule against numerals
 * would refuse the real notes to catch the empty ones.
 *
 * **`\p{L}`, not `[A-Za-z]`.** A doctor writing in Hindi or Marathi is doing
 * nothing wrong, and an ASCII rule would reject those while accepting "...".
 *
 * **Blank passes.** Clearing a field is a legitimate edit; these fields are all
 * optional, and refusing "" would make a mistyped line impossible to delete.
 *
 *     rejects   "123"   "9"   "..."   "@@"   "1/2"
 *     accepts   ""   "2 days of knee pain"   "T2DM x 5y"   "घुटने में दर्द"
 */
export function IsClinicalText(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isClinicalText',
      target: object.constructor,
      propertyName,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => looksLikeClinicalText(value),
        defaultMessage: () => 'needs at least two letters in it, not only numbers',
      },
    });
  };
}
