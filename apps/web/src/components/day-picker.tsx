'use client';

import { IconCalendar, IconChevronRight, IconRefresh } from '@/components/icons';

/** `2026-10-22`, the only date shape the board's URL ever carries. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The same day, some days either side. Noon UTC, so no timezone can shift it. */
export function stepDay(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** "Tue 13 Oct" — enough to know which day you are looking at. */
export function dayLabel(date: string): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}

/**
 * WHICH DAY, and when it was last looked at.
 *
 * A day at a time with the arrows, any day at all with the calendar, and one
 * press back to today. Three ways because the questions are different: "what
 * did yesterday look like" is a step, "who owed us on the 3rd" is a jump, and
 * "take me back to the live board" is the one people need most and should never
 * have to think about.
 *
 * SHARED BY EVERY BOARD, which is why it is a component rather than markup
 * repeated per screen. The front desk's day and the X-ray room's day are the
 * same day and must be moved through the same way — a second copy of this is
 * how one of them quietly grows an off-by-one or loses the Today button.
 */
export function DayPicker({
  shownDate,
  isToday,
  onPick,
  refreshedAt,
  onRefresh,
}: {
  shownDate: string;
  isToday: boolean;
  /** Null means today — the absence of a date, not today's date. */
  onPick: (date: string | null) => void;
  refreshedAt: Date | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-1 items-center gap-1 rounded-pill border border-ink/12 bg-white p-0.5 md:flex-none">
        <button
          type="button"
          className="btn-ghost !rounded-pill !px-2 !py-1"
          aria-label="The day before"
          title="The day before"
          onClick={() => onPick(stepDay(shownDate, -1))}
        >
          <span className="inline-flex rotate-180">
            <IconChevronRight size={14} />
          </span>
        </button>

        <label className="relative flex items-center">
          <span className="sr-only">Show another day</span>
          <span className="pointer-events-none absolute left-2 text-ink-40">
            <IconCalendar size={13} />
          </span>
          {/*
            The native picker. A hand-built calendar would be prettier and
            would also have to reinvent keyboard entry, locale and the
            mobile wheel — and the desk types dates faster than it clicks
            them.
          */}
          <input
            type="date"
            value={shownDate}
            onChange={(e) => e.target.value && onPick(e.target.value)}
            className="w-full rounded-pill border-0 bg-transparent py-1 pl-7 pr-2 font-mono text-[16px] tabular-nums text-ink focus:outline-none md:w-[150px] md:text-[12.5px]"
          />
        </label>

        <button
          type="button"
          className="btn-ghost !rounded-pill !px-2 !py-1"
          aria-label="The day after"
          title="The day after"
          onClick={() => onPick(stepDay(shownDate, 1))}
        >
          <IconChevronRight size={14} />
        </button>
      </div>

      {/* Only when it would do something. */}
      {!isToday && (
        <button
          type="button"
          className="btn-secondary !py-1.5 !text-[12.5px]"
          onClick={() => onPick(null)}
        >
          Today
        </button>
      )}

      <button type="button" className="btn-ghost !py-1.5 !text-[12.5px]" onClick={onRefresh}>
        <IconRefresh size={14} />
        {/* The time is only worth printing while the board is live. On a
            past day it would read as "this might have changed", and it
            cannot have. */}
        {isToday && refreshedAt
          ? `Updated ${refreshedAt.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
            })}`
          : 'Refresh'}
      </button>
    </div>
  );
}
