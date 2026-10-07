import { IsOptional, IsString, IsISO8601, MaxLength } from 'class-validator';

/**
 * Where to continue the timeline from.
 *
 * Both halves or neither. The feed is ordered by `(at, id)` and paged on that
 * pair, so a cursor carrying only a timestamp cannot resolve two events
 * recorded in the same millisecond — which is exactly what a registration and
 * its first appointment look like when a walk-in is registered and booked in
 * one flow.
 */
export class TimelineQueryDto {
  @IsOptional()
  @IsISO8601()
  cursorAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursorId?: string;
}
