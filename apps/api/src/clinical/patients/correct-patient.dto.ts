import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Correcting a patient registered earlier — FR-P36-20.
 *
 * **Note what is absent, because absence is the enforcement.** There is no
 * `uhid`, no `abhaNumber`, no `abhaAddress` on this shape, and the global
 * ValidationPipe runs with `forbidNonWhitelisted`, so a request carrying one is
 * rejected outright rather than quietly ignored. A field the UI does not show is
 * not a field the server declines; this is where it declines.
 *
 * The UHID is printed on the patient's card and quoted on paper. ABHA is a
 * government identifier verified at registration — changing it is a
 * re-verification, not a typo fix. The database has the same rule as a CHECK on
 * `patient_correction.field`.
 *
 * Every field optional: a correction is a patch, and sending only the mobile
 * must not blank out the address.
 */
export class CorrectPatientDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'])
  gender?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'birthDate must be YYYY-MM-DD' })
  birthDate?: string;

  /**
   * Kept alongside `birthDate` rather than derived, because many patients do not
   * know their date of birth and an approximate age is better than a made-up
   * date — the same reason registration accepts either. The service keeps the
   * two from contradicting each other.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(130)
  ageYears?: number;

  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, {
    message: 'mobile must be a 10-digit Indian mobile number starting 6-9',
  })
  mobile?: string;

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
  @MaxLength(12)
  postalCode?: string;

  @IsOptional()
  @IsIn(['A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG', 'UNKNOWN'])
  bloodGroup?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  emergencyContactName?: string;

  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, {
    message: 'emergencyContactMobile must be a 10-digit Indian mobile number starting 6-9',
  })
  emergencyContactMobile?: string;
}
