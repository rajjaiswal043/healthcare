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
