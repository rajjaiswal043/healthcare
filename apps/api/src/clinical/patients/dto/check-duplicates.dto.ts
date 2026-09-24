import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { normaliseMobile } from './register-patient.dto.js';

export class CheckDuplicatesDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  name!: string;

  @IsString()
  @Transform(({ value }) => normaliseMobile(value))
  @Matches(/^[6-9]\d{9}$/, { message: 'mobile must be a 10-digit Indian mobile number' })
  mobile!: string;
}
