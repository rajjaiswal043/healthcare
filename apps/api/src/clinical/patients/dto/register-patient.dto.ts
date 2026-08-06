import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export enum GenderDto {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
  UNKNOWN = 'UNKNOWN',
}

export enum BloodGroupDto {
  A_POSITIVE = 'A_POSITIVE',
  A_NEGATIVE = 'A_NEGATIVE',
  B_POSITIVE = 'B_POSITIVE',
  B_NEGATIVE = 'B_NEGATIVE',
  AB_POSITIVE = 'AB_POSITIVE',
  AB_NEGATIVE = 'AB_NEGATIVE',
  O_POSITIVE = 'O_POSITIVE',
  O_NEGATIVE = 'O_NEGATIVE',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Normalises an Indian mobile number to bare 10 digits.
 *
 * Front desks type these every way imaginable: "+91 98765 43210",
 * "098765-43210", "91 9876543210". Normalising on the way in is what makes
 * duplicate detection work at all — otherwise the same person registers three
 * times and nobody notices until their allergy history is split across records.
 */
export function normaliseMobile(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const digits = value.replace(/\D/g, '');

  // Strip the country code / trunk prefix if present.
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);

  return digits;
}

export class RegisterPatientDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  name!: string;

  @IsEnum(GenderDto)
  gender!: GenderDto;

  /**
   * Date of birth OR age, not necessarily both. Many Indian OPD patients do not
   * know their date of birth, and forcing one produces a register full of
   * 01/01/1980. At least one is required — see the check below.
   */
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ValidateIf((o: RegisterPatientDto) => !o.birthDate)
  @IsInt()
  @Min(0)
  @Max(130)
  @Type(() => Number)
  ageYears?: number;

  @IsString()
  @Transform(({ value }) => normaliseMobile(value))
  @Matches(/^[6-9]\d{9}$/, {
    message: 'mobile must be a 10-digit Indian mobile number starting 6-9',
  })
  mobile!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  addressLine?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'postalCode must be a 6-digit Indian PIN code' })
  postalCode?: string;

  @IsOptional()
  @IsEnum(BloodGroupDto)
  bloodGroup?: BloodGroupDto;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => normaliseMobile(value))
  @Matches(/^[6-9]\d{9}$/, { message: 'emergencyContactMobile must be a 10-digit mobile number' })
  emergencyContactMobile?: string;

  /**
   * DPDP consent captured at registration (BRD FR-CON-01).
   *
   * Care delivery is required — we cannot treat someone without it. Marketing is
   * separate and optional, because bundling them is exactly what the DPDP Act
   * prohibits: consent must be purpose-wise and freely given per purpose.
   */
  @IsBoolean()
  consentCareDelivery!: boolean;

  @IsOptional()
  @IsBoolean()
  consentMarketing?: boolean;

  /**
   * Set when the front desk has reviewed the duplicate warnings and is
   * deliberately creating a new record anyway. Without it, a likely duplicate is
   * rejected rather than silently created (FR-P36-03).
   */
  @IsOptional()
  @IsBoolean()
  confirmedNotDuplicate?: boolean;
}
