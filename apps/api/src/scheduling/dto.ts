import {
  IsBoolean,
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

/**
 * Why a patient is being moved to the front.
 *
 * Mirrors the QueuePriorityReason enum in the schema. Duplicated here rather
 * than imported from the Prisma client because a DTO is the API's contract with
 * its callers, and that contract should not silently change shape the day a
 * database enum gains a value.
 */
export enum QueuePriorityReasonDto {
  BACK_FROM_TESTS = 'BACK_FROM_TESTS',
  EMERGENCY = 'EMERGENCY',
  FRAIL_OR_DISTRESSED = 'FRAIL_OR_DISTRESSED',
  DOCTOR_REQUESTED = 'DOCTOR_REQUESTED',
  CLINIC_ERROR = 'CLINIC_ERROR',
}

export class SendForTestsDto {
  /**
   * Required. The front desk is about to be asked "what are they waiting for?"
   * by the patient's family, and "the doctor sent them somewhere" is not an
   * answer.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}

export class ReturnFromTestsDto {
  /**
   * Where they land, decided at the desk (or by the doctor) rather than by the
   * software. True puts them in front of everyone waiting; false puts them
   * behind, in their return order.
   */
  @IsBoolean()
  seeNext!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class PrioritiseDto {
  @IsEnum(QueuePriorityReasonDto)
  reasonCode!: QueuePriorityReasonDto;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class QueueQueryDto {
  @IsUUID()
  practitionerId!: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
