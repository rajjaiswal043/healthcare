import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `GET /patients/all?page=N`.
 *
 * A page number rather than an offset, so the URL the screen puts in the
 * address bar is one a person can read and share — "page 4", not "skip 90".
 *
 * Query parameters arrive as text; `@Type(() => Number)` converts before the
 * checks run, so `?page=abc` becomes NaN and is refused by `@IsInt` rather
 * than being quietly read as page 1. A page past the last one is NOT refused —
 * that answer is an empty page with the real total, which the screen turns into
 * "the last page is 9" (decision d, 21 Sep 2026). A page that is not a positive
 * whole number is a malformed request, which is a different thing.
 *
 * The upper bound is a guard on the OFFSET, not a statement about clinics: a
 * page of a hundred thousand is thirty lakh patients, and past that the number
 * is a typo or a probe.
 */
export class ListPatientsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be a whole number' })
  @Min(1, { message: 'page starts at 1' })
  @Max(100_000)
  page?: number;
}
