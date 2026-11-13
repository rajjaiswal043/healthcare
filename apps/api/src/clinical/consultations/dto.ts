import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsClinicalText } from '../../common/is-clinical-text.decorator.js';

/**
 * A date, or nothing at all.
 *
 * A bare `^\d{4}-\d{2}-\d{2}$` made clearing a follow-up date impossible, found
 * by a test on 27 Oct 2026. The service has handled `''` as "take the date off" all along;
 * the DTO refused it with a 400 before the service ever saw it, so the browser
 * — which sends `''` when the field is emptied on blur — could set a review
 * date and never remove one.
 */
const DATE_OR_BLANK_RE = /^$|^\d{4}-\d{2}-\d{2}$/;

export enum MedicationFormDto {
  TABLET = 'TABLET',
  CAPSULE = 'CAPSULE',
  SYRUP = 'SYRUP',
  INJECTION = 'INJECTION',
  DROPS = 'DROPS',
  OINTMENT = 'OINTMENT',
  INHALER = 'INHALER',
  SACHET = 'SACHET',
  OTHER = 'OTHER',
}

export enum MedicationRouteDto {
  ORAL = 'ORAL',
  TOPICAL = 'TOPICAL',
  INTRAVENOUS = 'INTRAVENOUS',
  INTRAMUSCULAR = 'INTRAMUSCULAR',
  SUBCUTANEOUS = 'SUBCUTANEOUS',
  INHALED = 'INHALED',
  OPHTHALMIC = 'OPHTHALMIC',
  OTIC = 'OTIC',
  NASAL = 'NASAL',
  RECTAL = 'RECTAL',
  OTHER = 'OTHER',
}

export class OpenEncounterDto {
  @IsUUID()
  appointmentId!: string;
}

export class UpdateEncounterDto {
  /*
   * The four narrative fields carry `IsClinicalText` as of 27 Oct 2026: the
   * testing team got "123" accepted as a chief complaint, which then prints on
   * the prescription as the reason the patient came. `prescriptionNote` is
   * deliberately left out — it was not reported, and a note reading "1-0-1"
   * beside a drug is how dosing is actually written.
   */
  @IsOptional()
  @IsString()
  @IsClinicalText()
  @MaxLength(500)
  chiefComplaint?: string;

  @IsOptional()
  @IsString()
  @IsClinicalText()
  @MaxLength(5000)
  historyOfPresentIllness?: string;

  @IsOptional()
  @IsString()
  @IsClinicalText()
  @MaxLength(5000)
  examinationFindings?: string;

  @IsOptional()
  @IsString()
  @IsClinicalText()
  @MaxLength(5000)
  advice?: string;

  /**
   * FR-CON-11. Printed under its own heading, below Advice.
   *
   * 1000 rather than the 5000 the other narrative fields allow: this prints,
   * and a note long enough to push the prescription onto a second sheet is a
   * note the clinic will stop using. The database carries the same bound as a
   * CHECK, so it holds for any caller that reaches the column another way.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  prescriptionNote?: string;

  @IsOptional()
  @Matches(DATE_OR_BLANK_RE, { message: 'followUpDate must be YYYY-MM-DD, or empty to clear it' })
  followUpDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  followUpNote?: string;

  /**
   * Ask the patient how they are every N days until the review — docs/10.
   * Null switches it off. Scheduled at signing, not here, so a draft that
   * changes its mind five times schedules nothing.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  checkInIntervalDays?: number | null;
}

/**
 * Vitals.
 *
 * The bounds here are the same ones the database CHECK constraints enforce, and
 * they are deliberately generous — they reject impossibilities, not unusual
 * patients. A 500 kg weight is refused; a 180 kg one is accepted and left for a
 * human to notice. Validating in both places is not duplication: this one
 * produces a readable message on the form, and the constraint is what holds when
 * a future caller skips this DTO.
 */
export class RecordVitalsDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(20)
  @Max(275)
  heightCm?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.3)
  @Max(500)
  weightKg?: number;

  @IsOptional()
  @IsInt()
  @Min(40)
  @Max(300)
  systolicMmHg?: number;

  @IsOptional()
  @IsInt()
  @Min(20)
  @Max(200)
  diastolicMmHg?: number;

  @IsOptional()
  @IsInt()
  @Min(20)
  @Max(300)
  pulseBpm?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(25)
  @Max(45)
  temperatureC?: number;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(100)
  spo2Percent?: number;

  @IsOptional()
  @IsInt()
  @Min(4)
  @Max(90)
  respiratoryRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class DiagnosisInputDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  codeSystem?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  code?: string;

  /*
   * The last narrative field without a rule, reported 28 Oct 2026: a diagnosis
   * of "123" saved and printed. The ICD code fields above are deliberately
   * left alone — a code legitimately has no letters in it.
   */
  @IsString()
  @IsClinicalText()
  @MinLength(2)
  @MaxLength(300)
  display!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  @IsClinicalText()
  @MaxLength(500)
  notes?: string;
}

export class SetDiagnosesDto {
  @IsArray()
  // Ten is already an unusual visit. The cap exists so a runaway client cannot
  // write an unbounded list into a clinical record.
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DiagnosisInputDto)
  diagnoses!: DiagnosisInputDto[];
}

export class PrescriptionInputDto {
  @IsOptional()
  @IsUUID()
  formularyItemId?: string;

  /*
   * A drug name has letters in it. "123456" was accepted and printed on a
   * prescription, reported from the clinic on 28 Oct 2026. Two letters, any
   * script, so "B12", "Vitamin D3" and a name written in Devanagari all pass.
   */
  @IsString()
  @IsClinicalText()
  @MinLength(2)
  @MaxLength(200)
  drugName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  strength?: string;

  @IsOptional()
  @IsEnum(MedicationFormDto)
  form?: MedicationFormDto;

  /*
   * A dose is letters or digits — "500mg", "1-0-1", "5 ml", "SOS". The rule is
   * deliberately weaker than the drug name's: dosing is written in a shorthand
   * that is mostly numbers, so requiring letters would refuse the commonest
   * forms. What it stops is "@@@###", which was accepted and printed.
   */
  @IsString()
  @Matches(/[\p{L}\p{N}]/u, { message: 'dose must contain a letter or a number' })
  @MinLength(1)
  @MaxLength(60)
  dose!: string;

  @IsString()
  @Matches(/[\p{L}\p{N}]/u, { message: 'frequency must contain a letter or a number' })
  @MinLength(1)
  @MaxLength(60)
  frequency!: string;

  @IsOptional()
  @IsEnum(MedicationRouteDto)
  route?: MedicationRouteDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  instructions?: string;
}

export class SetPrescriptionsDto {
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PrescriptionInputDto)
  prescriptions!: PrescriptionInputDto[];
}

export class AddendumDto {
  @IsString()
  @MinLength(3)
  @MaxLength(5000)
  text!: string;
}

export class FormularySearchDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
