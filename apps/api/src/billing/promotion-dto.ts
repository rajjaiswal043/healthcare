import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  ValidateIf,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { MAX_PAISE } from './promotion-maths.js';

export enum PromotionTypeDto {
  PERCENTAGE = 'PERCENTAGE',
  FLAT = 'FLAT',
  /** No stored value: the amount is typed at the desk, per bill. */
  CUSTOM = 'CUSTOM',
}

/**
 * `value` means two different things, so its bound depends on `type`.
 *
 * A custom constraint rather than two stacked `@ValidateIf` decorators. That was
 * the first attempt and it silently does nothing: `ValidateIf` is a property-level
 * setting, so a second one replaces the first, every rule on the property is
 * skipped for one of the two branches, and a percentage of 101 sails through the
 * pipe to be caught by the database CHECK — arriving at the client as a 500 with
 * a constraint name in it. The integration test for that case is what found it.
 */
function IsPromotionValue(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isPromotionValue',
      target: object.constructor,
      propertyName,
      options: options ?? {},
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const type = (args.object as { type?: string }).type;

          // CUSTOM has no value to bound — it must be ABSENT, which is what the
          // database CHECK requires too. Sending one is refused rather than
          // ignored: a figure stored against a type that never reads it is a
          // number waiting to be believed by something later.
          if (type === PromotionTypeDto.CUSTOM) return value === undefined || value === null;

          if (!Number.isInteger(value)) return false;
          const amount = value as number;

          return type === PromotionTypeDto.PERCENTAGE
            ? amount >= 1 && amount <= 100
            : amount >= 1 && amount <= MAX_PAISE;
        },
        defaultMessage(args: ValidationArguments): string {
          const type = (args.object as { type?: string }).type;
          if (type === PromotionTypeDto.CUSTOM) {
            return 'A custom promotion takes no value — the amount is entered when it is applied.';
          }
          return type === PromotionTypeDto.PERCENTAGE
            ? 'A percentage promotion is a whole number between 1 and 100.'
            : 'A flat promotion is an amount in paise between 1 and one crore.';
        },
      },
    });
  };
}

/**
 * A cap belongs to the two types that have a value, and to no other.
 *
 * Written as its own validator rather than `@ValidateIf`, which was the first
 * attempt and does the OPPOSITE of what it reads like: `@ValidateIf(o => o.type
 * !== CUSTOM)` SKIPS every rule on the property for a CUSTOM promotion, so a cap
 * sent with one sailed through the pipe and was caught by the database CHECK —
 * arriving at the client as a 500 with a constraint name in it. The integration
 * test for that case is what found it, the same way it found the `value` bug
 * this file already documents.
 */
function IsPromotionCap(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isPromotionCap',
      target: object.constructor,
      propertyName,
      options: options ?? {},
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (value === undefined || value === null) return true;

          const type = (args.object as { type?: string }).type;
          if (type === PromotionTypeDto.CUSTOM) return false;

          return (
            Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PAISE
          );
        },
        defaultMessage(args: ValidationArguments): string {
          return (args.object as { type?: string }).type === PromotionTypeDto.CUSTOM
            ? 'A custom promotion cannot have a maximum discount — its amount is typed in full each time.'
            : 'An uncapped promotion leaves this out — a cap of zero discounts nothing.';
        },
      },
    });
  };
}

/**
 * Promotion codes are INTERNAL (decision 4, 3 Sep 2026).
 *
 * Staff type them at the billing desk; a patient is never told one. That is what
 * lets this be a plain readable string with no usage limit and no guessing
 * resistance — the code is behind the auth guard, so its secrecy is not what
 * protects it. Upper-cased on the way in so `camp50` and `CAMP50` cannot become
 * two promotions in the same clinic.
 */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class CreatePromotionDto {
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  @Matches(CODE_PATTERN, {
    message: 'A code is letters, digits, hyphen and underscore — for example CAMP50.',
  })
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsEnum(PromotionTypeDto)
  type!: PromotionTypeDto;

  /**
   * 1–100 for a percentage, paise for a flat amount.
   *
   * One column with a branching bound, because the database holds one `value`
   * with a CHECK that branches the same way — a DTO shaped differently from the
   * table is how the two drift.
   */
  @IsPromotionValue()
  value?: number;

  /**
   * In paise. Null or absent means uncapped, and CUSTOM must leave it out.
   *
   * The refusal is the database's as well — `promotion_value_within_bounds`
   * requires `max_discount_paise IS NULL` for CUSTOM — but arriving at a CHECK
   * constraint means the client gets a 500 with a constraint name in it. This
   * is the same rule, said early and in words.
   */
  @IsPromotionCap()
  maxDiscountPaise?: number;

  /** `YYYY-MM-DD`, read in the clinic's own timezone. */
  @IsISO8601()
  validFrom!: string;

  @IsOptional()
  @IsISO8601()
  validTo?: string;
}

/**
 * What may be edited, and only while the promotion has never been used.
 *
 * `code` and `type` are absent on purpose. Changing either turns the promotion
 * into a different thing under the same row, and every report that ever grouped
 * by it would silently re-group. Switch it off and make a new one.
 */
export class UpdatePromotionDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAISE)
  value?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAISE)
  maxDiscountPaise?: number;

  @IsOptional()
  @IsISO8601()
  validFrom?: string;

  @IsOptional()
  @IsISO8601()
  validTo?: string;
}

export class SetPromotionActiveDto {
  @IsBoolean()
  isActive!: boolean;
}

export class ListPromotionsQueryDto {
  /**
   * `true` narrows to what the finance desk could actually use right now:
   * switched on, and today inside its validity window.
   *
   * A string rather than a boolean because this is a query parameter — `?applicable=true`
   * arrives as text, and the global validation pipe transforms rather than guesses.
   */
  @IsOptional()
  @IsString()
  @Matches(/^(true|false)$/)
  applicable?: string;
}

/**
 * Applying a promotion to a bill (FR-PRO-02).
 *
 * The promotion may be named by code — what the finance person reads off a note
 * — or by id, which is what a list-then-pick screen will send. One or the other,
 * never neither.
 */
export class ApplyPromotionDto {
  @ValidateIf((o: ApplyPromotionDto) => !o.promotionId)
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  code?: string;

  @IsOptional()
  @IsUUID()
  promotionId?: string;

  /**
   * Who said to give this discount. MANDATORY (decision 3, 3 Sep 2026).
   *
   * A staff user in this clinic, not free text. The instruction arrives by
   * telephone so the system cannot observe it — and without a named approver the
   * record shows the finance person gave away money and shows nothing about the
   * instruction they were following. The person most exposed by that gap is the
   * finance person, which is why this is not optional.
   */
  @IsUUID()
  authorisedByUserId!: string;

  /**
   * The amount, for a CUSTOM promotion and for no other kind.
   *
   * PERCENTAGE and FLAT carry their own answer; sending one of those a figure
   * would be asking the desk to overrule a discount an administrator defined,
   * which is a different feature with different approvals. The service refuses
   * it rather than ignoring it — silently dropping a number somebody typed is
   * how a bill ends up not matching what the person at the desk saw.
   *
   * `@Min(1)` is one paisa: zero is refused for the same reason the other two
   * types refuse a value of zero. A discount worth nothing is not a discount, it
   * is a record claiming one was given.
   *
   * The upper bound HERE is only the absolute ceiling shared with every other
   * money field. The real limit is the bill itself, which this shape cannot see
   * — that check lives in the service, where the invoice is.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAISE)
  customDiscountPaise?: number;
}

export enum PromotionReversalKindDto {
  APPLIED_IN_ERROR = 'APPLIED_IN_ERROR',
  AUTHORISATION_WITHDRAWN = 'AUTHORISATION_WITHDRAWN',
}

/**
 * Taking a discount back off a bill, before any money has moved.
 *
 * The kind is optional and defaults to `APPLIED_IN_ERROR`, which is what almost
 * every undo at a busy desk actually is — the wrong code typed, or the wrong
 * bill open. `AUTHORISATION_WITHDRAWN` is there because the two are genuinely
 * different to whoever reads the day's discounts: one should never have
 * happened, the other happened properly and was called back.
 *
 * No approver field. The reversal inherits the authoriser of the discount it
 * withdraws — naming a fresh one would put somebody against an instruction
 * nobody gave.
 */
export class ReversePromotionDto {
  @IsOptional()
  @IsEnum(PromotionReversalKindDto)
  reversalKind?: PromotionReversalKindDto;
}
