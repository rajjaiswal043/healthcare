import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export enum PaymentModeDto {
  CASH = 'CASH',
  UPI = 'UPI',
  CARD = 'CARD',
  BANK_TRANSFER = 'BANK_TRANSFER',
  OTHER = 'OTHER',
}

/**
 * One crore in paise — ₹10,00,000.
 *
 * An upper bound on any single amount. Not because a clinic could not legitimately
 * bill more, but because a typo of a few extra zeroes on a consultation fee should
 * be refused at the door rather than corrected in the ledger afterwards.
 */
const MAX_PAISE = 100_000_000;

export class AddLineDto {
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;

  /** In paise. ₹350.00 is 35000 — see docs/04-billing-plan.md section 2. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_PAISE)
  unitPricePaise?: number;
}

export class CollectPaymentDto {
  @IsEnum(PaymentModeDto)
  mode!: PaymentModeDto;

  @IsInt()
  @Min(1)
  @Max(MAX_PAISE)
  amountPaise!: number;

  /** UPI transaction id, card approval code, cheque number. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

/** Why a compensating entry exists. See `payment.correction_kind`. */
export enum PaymentCorrectionKindDto {
  PATIENT_REFUND = 'PATIENT_REFUND',
  RECORDED_IN_ERROR = 'RECORDED_IN_ERROR',
}

export class RefundDto {
  @IsEnum(PaymentModeDto)
  mode!: PaymentModeDto;

  @IsInt()
  @Min(1)
  @Max(MAX_PAISE)
  amountPaise!: number;

  /** Required. Money leaving with no explanation is money nobody can account for. */
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;

  /**
   * Which kind of correction this is.
   *
   * Required, with no default, deliberately. Both kinds net to the same figure —
   * `PATIENT_REFUND` is money that LEFT the drawer, `RECORDED_IN_ERROR` is money
   * that was never in it — and an owner counting cash at closing needs to know
   * which. A default would silently pick one of those answers for somebody.
   */
  @IsEnum(PaymentCorrectionKindDto)
  kind!: PaymentCorrectionKindDto;
}

export class InvoiceExceptionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

export class DayCollectionQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

/**
 * The finance report's range (FR-FIN-03).
 *
 * Both optional and both clinic-local dates. Omitting them reports on today,
 * which is what the desk asks for most often and means the endpoint is useful
 * with no parameters at all. Giving `from` alone reports that single day.
 */
export class FinanceReportQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}
