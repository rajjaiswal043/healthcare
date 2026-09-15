import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * The rules for a clinic's patient ID format, stated once for the API.
 *
 * The database is the authority: CHECK `tenant_uhid_prefix_format` and
 * `tenant_uhid_padding_range` refuse anything outside these whatever the
 * caller. These decorators exist so a person gets a SENTENCE naming what is
 * wrong with what they typed, instead of a constraint violation surfacing as a
 * 500. The web console mirrors the same rules in `apps/web/src/lib/uhid-format.ts`
 * for its live preview; if one changes, all three must.
 *
 * Onboarding uses these now; changing the format later (phase P3) will too.
 */
export const UHID_PREFIX_MAX = 8;
export const UHID_WIDTH_MIN = 3;
export const UHID_WIDTH_MAX = 8;
export const UHID_WIDTH_DEFAULT = 5;

/**
 * Whether a field may be left out.
 *
 * A parameter, not a separate `@IsDefined` stacked on the property. That was
 * tried and does not work: class-validator checks `IsOptional` first and stops
 * the moment the value is missing — before `IsDefined` is ever consulted — so a
 * required field built from optional pieces lets `undefined` straight through.
 * It reached the database as NULL and came back as a 500.
 */
export interface UhidFieldOptions {
  /** Onboarding: false, the server has a default. Changing the format: true. */
  required?: boolean;
}

/**
 * The prefix, one rule per message.
 *
 * Several `@Matches` rather than the single CHECK pattern, because one pattern
 * can only say "invalid". Split, each failure names itself — and the one people
 * trip on, the trailing digit, says how to fix it.
 *
 * Uppercased and trimmed before validating, because the database uppercases it
 * anyway: refusing `drviv-` for being lowercase would reject what the clinic
 * will end up with. A blank becomes absent, so the default prefix applies
 * rather than an error about an empty string nobody meant to send.
 */
export function IsUhidPrefix(options: UhidFieldOptions = {}): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toUpperCase() || undefined : value,
    ),
    // A blank has just become `undefined` above, so when required it is refused
    // here as missing, with a sentence, rather than as a malformed prefix.
    options.required ? IsDefined({ message: 'Give the patient IDs a prefix.' }) : IsOptional(),
    IsString(),
    MaxLength(UHID_PREFIX_MAX, {
      message: `The patient ID prefix can be at most ${UHID_PREFIX_MAX} characters.`,
    }),
    Matches(/^[A-Z0-9/-]*$/, {
      message: 'The patient ID prefix may use only letters, digits, - and /.',
    }),
    Matches(/^[A-Z]/, {
      message: 'The patient ID prefix must start with a letter.',
    }),
    /**
     * The rule that matters. A prefix ending in a digit lets a later format
     * change re-issue an ID that already exists: DRV1 + 05 and DRV + 105 are
     * both DRV105. The suggested fix keeps the digit the clinic wanted.
     */
    Matches(/[^0-9]$/, {
      message: 'The patient ID prefix cannot end in a digit — put a - or / after it, like DRV1-.',
    }),
  );
}

/** How many digits the number is padded to. A minimum: longer numbers are written in full. */
export function IsUhidWidth(options: UhidFieldOptions = {}): PropertyDecorator {
  const message = `The patient number width must be a whole number from ${UHID_WIDTH_MIN} to ${UHID_WIDTH_MAX}.`;
  return applyDecorators(
    options.required
      ? IsDefined({ message: 'Choose how many digits the patient number has.' })
      : IsOptional(),
    IsInt({ message }),
    Min(UHID_WIDTH_MIN, { message }),
    Max(UHID_WIDTH_MAX, { message }),
  );
}

/**
 * What the ID for patient `n` looks like in a given format.
 *
 * Pads a short number and never cuts a long one — exactly what `next_uhid()`
 * does since 15 Sep 2026: DRVIV-9999 is followed by DRVIV-10000, not by
 * DRVIV-1000 again. Used wherever the API shows a format rather than issuing
 * an ID; issuing is only ever the database function's job.
 */
export function formatUhid(prefix: string, width: number, n: number): string {
  const digits = String(n);
  return prefix + (digits.length < width ? digits.padStart(width, '0') : digits);
}
