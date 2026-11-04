'use client';

import { useRef } from 'react';
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
  const dateRef = useRef<HTMLInputElement>(null);

  /**
   * Open the native picker.
   *
   * Reported on 27 Oct 2026: the calendar icon did not open a calendar. It was
   * a decorative span with `pointer-events-none`, so a click fell through to
   * the label and merely focused the field — and focusing a date input opens
   * nothing. The picker was reachable only from the browser's own small
   * indicator at the far end of the field, which is not where the icon is.
   *
   * `showPicker` throws where it is unsupported or not tied to a real click,
   * and focusing the field is the honest fallback: the date can still be typed.
   */
  const openCalendar = () => {
    const input = dateRef.current;
    if (!input) return;

    try {
      input.showPicker();
    } catch {
      input.focus();
    }
  };

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

        {/* A div, not a label: the icon is a button now, and a button inside a
            label fires the label's own focus as well as its click. */}
        <div className="relative flex items-center">
          <button
            type="button"
            aria-label="Open the calendar"
            title="Open the calendar"
            className="absolute left-2 flex text-ink-40 transition-colors hover:text-ink"
            onClick={openCalendar}
          >
            <IconCalendar size={13} />
          </button>
          {/*
            The native picker. A hand-built calendar would be prettier and
            would also have to reinvent keyboard entry, locale and the
            mobile wheel — and the desk types dates faster than it clicks
            them.
          */}
          <input
            ref={dateRef}
            type="date"
            aria-label="Show another day"
            value={shownDate}
            onChange={(e) => e.target.value && onPick(e.target.value)}
            className="w-full rounded-pill border-0 bg-transparent py-1 pl-7 pr-2 font-mono text-[16px] tabular-nums text-ink focus:outline-none md:w-[150px] md:text-[12.5px]"
          />
        </div>

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
