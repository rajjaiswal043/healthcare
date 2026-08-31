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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  @IsOptional()
  @IsString()
  @MaxLength(500)
  chiefComplaint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  historyOfPresentIllness?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  examinationFindings?: string;

  @IsOptional()
  @IsString()
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
  @Matches(DATE_RE, { message: 'followUpDate must be YYYY-MM-DD' })
  followUpDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  followUpNote?: string;
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

  @IsString()
  @MinLength(2)
  @MaxLength(300)
  display!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
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

  @IsString()
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

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  dose!: string;

  @IsString()
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
