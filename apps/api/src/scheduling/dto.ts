import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum VisitTypeDto {
  NEW = 'NEW',
  FOLLOW_UP = 'FOLLOW_UP',
  PROCEDURE = 'PROCEDURE',
}

/** "YYYY-MM-DD" in the clinic's timezone, not an instant. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class AvailabilityQueryDto {
  @IsUUID()
  practitionerId!: string;

  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsEnum(VisitTypeDto)
  visitType?: VisitTypeDto;
}

export class BookAppointmentDto {
  @IsUUID()
  patientId!: string;

  @IsUUID()
  practitionerId!: string;

  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  /** Slot start as an ISO instant — exactly as the availability endpoint returned it. */
  @IsISO8601()
  startAt!: string;

  @IsOptional()
  @IsEnum(VisitTypeDto)
  visitType?: VisitTypeDto;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reasonForVisit?: string;
}

export class WalkInDto {
  @IsUUID()
  patientId!: string;

  @IsUUID()
  practitionerId!: string;

  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsEnum(VisitTypeDto)
  visitType?: VisitTypeDto;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reasonForVisit?: string;
}

export class CancelAppointmentDto {
  /**
   * Required, and deliberately so: FR-APT-03 asks for reason codes, and a
   * cancellation history of empty strings tells the clinic nothing about why
   * their slots are going unused.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

export class RescheduleAppointmentDto {
  @IsISO8601()
  startAt!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

export class QueueQueryDto {
  @IsUUID()
  practitionerId!: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
