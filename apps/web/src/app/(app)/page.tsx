'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  api,
  ApiRequestError,
  type DayBoard,
  type DayBoardRow,
  type DayBucket,
  type FeeTag,
  type Invoice,
  type NextStep,
} from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { Pagination } from '@/components/pagination';
import { SendForTestDialog } from '@/components/send-for-test-dialog';
import { RecordResultDialog } from '@/components/record-result-dialog';
import { PaymentDialog } from '@/components/payment-dialog';
import { PrintReceiptButton } from '@/components/receipt-button';
import { firstDoableStep, stepLabel } from '@/components/next-step';
import { formatAge, formatPaise, genderInitial, payMethodLabel } from '@/lib/format';
import {
  IconAlert,
  IconCalendar,
  IconChevronRight,
  IconRefresh,
  IconSearch,
  IconUserPlus,
  IconUsers,
} from '@/components/icons';

/** How often the board refreshes while somebody is actually looking at it. */
const POLL_MS = 30000;
const PAGE_SIZE = 12;

type TabKey = 'everyone' | 'expected' | 'waiting' | 'with-doctor' | 'at-department' | 'done';

const TABS: Array<{ key: TabKey; label: string; bucket: DayBucket | null }> = [
  { key: 'everyone', label: 'Everyone', bucket: null },
  { key: 'expected', label: 'Expected', bucket: 'EXPECTED' },
  { key: 'waiting', label: 'Waiting', bucket: 'WAITING' },
  { key: 'with-doctor', label: 'With the doctor', bucket: 'WITH_DOCTOR' },
  { key: 'at-department', label: 'At a department', bucket: 'AT_DEPARTMENT' },
  { key: 'done', label: 'Done', bucket: 'DONE' },
];

const COUNT_KEY: Record<DayBucket, keyof DayBoard['counts']> = {
  EXPECTED: 'expected',
  WAITING: 'waiting',
  WITH_DOCTOR: 'with_doctor',
  AT_DEPARTMENT: 'at_department',
  DONE: 'done',
  NOT_ATTENDING: 'not_attending',
};

const BUCKET_LABEL: Record<DayBucket, string> = {
  EXPECTED: 'Expected',
  WAITING: 'Waiting',
  WITH_DOCTOR: 'With the doctor',
  AT_DEPARTMENT: 'At a department',
  DONE: 'Done',
  NOT_ATTENDING: 'Not attending',
};

/**
 * THE WHOLE ROW, tinted by where the patient is in the clinic.
 *
 * A chip in the last column answers "what stage is this patient at" only once
 * you have found the chip. A doctor scanning twenty-eight rows for "which of
 * these have I finished" was reading twenty-eight chips. The tint answers it
 * from across the desk.
 *
 * ONE COLOUR PER STAGE, and each is the journey rather than decoration:
 *
 *   EXPECTED       plain white — not in the building yet, nothing to see
 *   WAITING        amber — somebody is sitting out there, which is the one
 *                  state that is nobody's fault and everybody's problem
 *   WITH_DOCTOR    clinical teal — in the room, being seen
 *   AT_DEPARTMENT  grey — still here, but not in the OPD; out at a machine
 *   DONE           iris — finished and gone
 *
 * NOT GREEN FOR DONE, twice over. `clinical` is itself a teal-green, so
 * finished and with-the-doctor were two greens a metre from a doctor's eyes.
 * And green already means MONEY on this very row — a paid fee, a settled bill
 * — so spending it on a second meaning made both weaker.
 *
 * Every tint is held under a tenth so text contrast is untouched, and the Stage
 * chip still carries the word for anybody who cannot separate two of them.
 */
const ROW_TONE: Partial<Record<DayBucket, string>> = {
  WAITING: 'bg-amber-soft/35 hover:bg-amber-soft/55',
  WITH_DOCTOR: 'bg-clinical-tint/60 hover:bg-clinical-tint/80',
  AT_DEPARTMENT: 'bg-ink/[0.045] hover:bg-ink/[0.07]',
  DONE: 'bg-iris-soft/60 hover:bg-iris-soft/80',
};

/**
 * The same five colours as the rows, on the chip that names them.
 *
 * Chip and row agree deliberately: the tint says where the patient is from
 * across the desk, the chip says it in a word for anybody close enough to read
 * — and two different colour schemes for one fact would be worse than none.
 *
 * AT_DEPARTMENT used to be a second teal, a shade off WITH_DOCTOR, which made
 * "in the room" and "out at the X-ray machine" the hardest pair on the board to
 * tell apart — and they are the two a doctor most needs to tell apart.
 */
const BUCKET_TONE: Record<DayBucket, string> = {
  EXPECTED: 'bg-ink/8 text-ink-60',
  WAITING: 'bg-amber-soft text-amber-text',
  WITH_DOCTOR: 'bg-clinical-soft text-clinical-text',
  AT_DEPARTMENT: 'bg-ink/14 text-ink-60',
  // Iris, not green: green is money settled on this very row, and `clinical` is
  // itself a teal-green — so finished needs a hue of its own to be seen at all.
  DONE: 'bg-iris-soft text-iris-text',
  NOT_ATTENDING: 'bg-ink/8 text-ink-20',
};

/**
 * The home screen: everybody in the clinic today, as a table.
 *
 * It was four cards linking to pages already in the left menu. Those went on 29
 * Sep 2026, replaced by the thing people were opening this screen to find out.
 *
 * **One row per patient.** Somebody who sees a doctor and has an X-ray the same
 * day is one person in the building, and appears once carrying both tags.
 *
 * **The tab and the page live in the URL**, so Back walks between them, a
 * refresh stays put, and a row opened from page 2 comes back to page 2. The
 * search box does not: it is a way of finding a row on a screen you are already
 * looking at, not a place you navigate to.
 *
 * **What a doctor sees is decided by the server**, not by hiding rows here —
 * their response contains only their own patients, and this renders whatever it
 * is given.
 */
export default function HomePage() {
  // `useSearchParams` needs a boundary, or the build refuses to prerender this
  // route at all.
  return (
    <Suspense fallback={<BoardSkeleton />}>
      <DayBoardScreen />
    </Suspense>
  );
}

/** `YYYY-MM-DD`, and nothing else. A URL is somewhere anybody can type. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function DayBoardScreen() {
  const { can, session } = useAuth();
  const params = useSearchParams();
  const router = useRouter();

  const [board, setBoard] = useState<DayBoard | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  /**
   * The clinic's own today, as the server reported it.
   *
   * Learned rather than computed: the first load with no date comes back
   * stamped with the day the clinic is having, in its own timezone. Used only
   * to recognise that a date picked from the calendar IS today, so the board
   * can drop back to the live, polling view instead of pinning itself to a
   * date that will be yesterday by tomorrow morning.
   *
   * Null when somebody opened a dated URL directly and we have never asked for
   * today. Everything still works — the Today button clears the parameter,
   * which needs no knowledge of the date at all.
   */
  const [serverToday, setServerToday] = useState<string | null>(null);

  /**
   * Sending somebody for a test from the row, without reopening the
   * consultation. `notice` is held until dismissed: the sentence it carries
   * says money has been added to a patient's bill, which is not something to
   * flash past.
   */
  const [sendingFor, setSendingFor] = useState<DayBoardRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The row being acted on, and what it opened.
   *
   * `acting` is the patient id rather than a boolean, so one row's button says
   * "…" while the rest of the board stays usable — a desk with twelve people on
   * screen should not freeze because one of them is being checked in.
   */
  const [acting, setActing] = useState<string | null>(null);
  const [collecting, setCollecting] = useState<Invoice | null>(null);
  const [recording, setRecording] = useState<{ row: DayBoardRow; orderId: string } | null>(null);

  /**
   * WHICH DAY, AND HOW "TODAY" IS DECIDED.
   *
   * No `date` in the URL means today — and that is the whole definition. The
   * clinic runs on IST and the browser may not, so asking the server for "no
   * date" and letting it resolve its own today is the only way to be right for
   * a desk in Pune and a laptop set to London. Nothing here does date
   * arithmetic to work out what today is; it only steps a day at a time from
   * the date the server sent back.
   *
   * It lives in the URL beside `tab` and `page`, so a day survives a refresh
   * and can be sent to somebody.
   */
  const dateParam = params.get('date');
  const date = dateParam && DATE_RE.test(dateParam) ? dateParam : null;
  const isToday = date === null;

  const tab: TabKey = TABS.find((t) => t.key === params.get('tab'))?.key ?? 'everyone';
  const pageParam = Number(params.get('page') ?? '1');
  const requestedPage = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  // Read through a ref inside the interval, so the timer is never torn down and
  // rebuilt just because a render produced a new function.
  const loadRef = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    try {
      const next = await api.dayBoard(date ?? undefined);
      setBoard(next);
      if (date === null) setServerToday(next.date);
      setRefreshedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load that day.');
    }
  }, [date]);

  useEffect(() => {
    loadRef.current = () => void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Refresh every 30 seconds — but only while this tab is on screen, and only
   * on today.
   *
   * A board left open on a background tab polled all afternoon for nobody, and
   * browsers throttle those timers anyway, so the first thing somebody saw on
   * returning was stale. Coming back refetches immediately rather than waiting
   * out the interval, which is the case that reads as "it did not update".
   *
   * A past day does not change, so polling one is a request a minute for an
   * answer that cannot move. The Refresh button is still there for the rare
   * case of somebody editing history from another screen.
   */
  useEffect(() => {
    if (!isToday) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(() => loadRef.current(), POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        loadRef.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [isToday]);

  const active = TABS.find((t) => t.key === tab) ?? TABS[0]!;

  const filtered = useMemo(() => {
    const rows = (board?.rows ?? []).filter((r) =>
      active.bucket === null ? r.bucket !== 'NOT_ATTENDING' : r.bucket === active.bucket,
    );

    const needle = query.trim().toLowerCase();
    if (!needle) return rows;

    return rows.filter(
      (r) =>
        r.patient.name.toLowerCase().includes(needle) ||
        r.patient.uhid.toLowerCase().includes(needle) ||
        String(r.token ?? '').includes(needle) ||
        (r.withWhom ?? '').toLowerCase().includes(needle),
    );
  }, [board, active.bucket, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamped rather than trusted: a page number can come from a URL somebody
  // edited, or from a filter that just shortened the list under them.
  const page = Math.min(requestedPage, totalPages);
  const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const first = filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = first + shown.length - 1;

  /**
   * Go to a day, keeping the tab and dropping the page.
   *
   * The page is dropped deliberately: page 4 of Tuesday is not page 4 of
   * Wednesday, and landing on an empty page reads as an empty day.
   *
   * `null` means today, which is the absence of the parameter rather than a
   * date — see the note on `dateParam`. Picking today's own date from the
   * calendar lands on the same URL as the Today button, so the board starts
   * polling again instead of sitting still on a date that happens to be today.
   */
  const goToDay = useCallback(
    (to: string | null) => {
      const next = new URLSearchParams();
      const tabParam = params.get('tab');
      if (tabParam) next.set('tab', tabParam);
      if (to !== null && to !== serverToday) next.set('date', to);

      const qs = next.toString();
      router.push(qs ? `/?${qs}` : '/');
    },
    [params, router, serverToday],
  );

  /**
   * Doing the step.
   *
   * Three shapes, and the difference is the point of the whole exercise:
   *
   *   CHECK_IN happens where you are standing — one call, one refresh, no
   *   screen in between, because there is nothing to decide;
   *
   *   COLLECT and RECORD_RESULT open a dialog OVER the board, because there is
   *   something to decide and the board behind it is the context;
   *
   *   START and RESUME navigate, because writing a consultation is not dialog
   *   work and never will be.
   *
   * RECEIPT is absent here: it is rendered as its own button, since printing
   * owns a hidden sheet and a print log of its own.
   */
  const doStep = useCallback(
    async (row: DayBoardRow, step: NextStep) => {
      setActing(row.patient.id);
      setError(null);

      try {
        switch (step.kind) {
          case 'CHECK_IN':
            await api.checkIn(step.appointmentId);
            setNotice(`${row.patient.name} is checked in.`);
            await load();
            break;

          case 'COLLECT':
            setCollecting(await api.invoice(step.invoiceId));
            break;

          case 'START':
          case 'RESUME': {
            // Opening and resuming are the same call — the server returns the
            // encounter that exists, or makes one.
            const encounter = await api.openEncounter(step.appointmentId);
            router.push(`/consultations/${encounter.id}`);
            break;
          }

          case 'FINISH':
            await api.completeVisit(step.appointmentId);
            setNotice(`${row.patient.name}’s visit is finished.`);
            await load();
            break;

          case 'RECORD_RESULT':
            setRecording({ row, orderId: step.orderId });
            break;

          case 'RECEIPT':
            break;
        }
      } catch (err) {
        setError(
          err instanceof ApiRequestError ? err.error.message : `Could not ${stepLabel(step)}.`,
        );
      } finally {
        setActing(null);
      }
    },
    [load, router],
  );

  /**
   * The day on screen, as a date string.
   *
   * From the BOARD, not from the URL: on today the URL has no date at all, and
   * the server's answer is the only thing that knows what the clinic's today
   * is. Falls back to the URL while the first load is in flight, so the picker
   * is never momentarily blank on a dated link.
   */
  const shownDate = board?.date ?? date ?? '';

  const mayOrderTests = can('diagnostic:order');

  /**
   * Figures, not permission, decide the column.
   *
   * `board.money` is null for a caller the server would not send amounts to, so
   * the column simply does not exist for a doctor or a nurse rather than being
   * rendered empty. Keyed on the payload instead of a second `can()` check, so
   * there is one rule and it is the server's.
   */
  const showsMoney = board?.money != null;

  /** What the current tab and search add up to, which is not the whole day. */
  const shownMoney = showsMoney
    ? filtered.reduce(
        (total, row) => ({
          billedPaise: total.billedPaise + (row.money?.billedPaise ?? 0),
          duePaise: total.duePaise + (row.money?.duePaise ?? 0),
        }),
        { billedPaise: 0, duePaise: 0 },
      )
    : null;

  /**
   * Sending somebody for a test belongs to today.
   *
   * Ordering an X-ray against a visit from last Tuesday raises a charge on a
   * bill nobody is standing at the desk to pay, and puts a patient who went
   * home days ago on the department's worklist. Money actions are a different
   * matter — an unpaid bill from last Tuesday is still owed, which is half the
   * reason to look at last Tuesday at all.
   */
  const mayAct = isToday;
  const showsSendForTest = mayOrderTests && mayAct;

  /**
   * Whether the actions column exists at all.
   *
   * Decided over the whole filtered list rather than the page on screen, so the
   * table does not grow and lose a column as somebody pages through it.
   * `firstDoableStep` is cheap — a find over at most a handful of steps.
   */
  const showsActions =
    showsSendForTest || filtered.some((r) => firstDoableStep(r.nextSteps, can, isToday) !== null);

  const columns = (active.bucket === null ? 9 : 8) + (showsActions ? 1 : 0) + (showsMoney ? 1 : 0);
  const notAttending = board?.counts.not_attending ?? 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* One line instead of three. The eyebrow and the count each had a row
            of their own, which cost about 60px above a table people open forty
            times a day to scan. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-[24px] font-bold">
            {/* Named rather than "Today", because on any other day "Today"
                would be a lie on the one screen people trust for where their
                patients are. */}
            {isToday ? 'Today' : dayLabel(shownDate)} at {session?.tenant.name ?? 'the clinic'}
          </h1>
          <p className="text-[13.5px] text-ink-60">
            {board
              ? `${board.counts.total} ${
                  board.counts.total === 1 ? 'patient' : 'patients'
                } expected`
              : 'Loading…'}
            {board?.scope === 'OWN' && ' · your list only'}
          </p>

          {/* The day's money, over the whole board rather than the open tab.
              Billed and collected are the two figures a clinic closes the day
              on; what is still due is the one somebody has to act on, so it
              only appears when there is some. */}
          {board?.money && (
            <p className="text-[13.5px] text-ink-60">
              <span className="font-mono font-semibold tabular-nums text-ink">
                {formatPaise(board.money.collectedPaise)}
              </span>{' '}
              collected of {formatPaise(board.money.billedPaise)}
              {board.money.duePaise > 0 && (
                <span className="font-semibold text-amber-text">
                  {' · '}
                  {formatPaise(board.money.duePaise)} due
                </span>
              )}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            WHICH DAY.

            A day at a time with the arrows, any day at all with the calendar,
            and one press back to today. Three ways because the questions are
            different: "what did yesterday look like" is a step, "who owed us
            on the 3rd" is a jump, and "take me back to the live board" is the
            one people need most and should never have to think about.
          */}
          <div className="flex flex-1 items-center gap-1 rounded-pill border border-ink/12 bg-white p-0.5 md:flex-none">
            <button
              type="button"
              className="btn-ghost !rounded-pill !px-2 !py-1"
              aria-label="The day before"
              title="The day before"
              onClick={() => goToDay(stepDay(shownDate, -1))}
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
                onChange={(e) => e.target.value && goToDay(e.target.value)}
                className="w-full rounded-pill border-0 bg-transparent py-1 pl-7 pr-2 font-mono text-[16px] tabular-nums text-ink focus:outline-none md:w-[150px] md:text-[12.5px]"
              />
            </label>

            <button
              type="button"
              className="btn-ghost !rounded-pill !px-2 !py-1"
              aria-label="The day after"
              title="The day after"
              onClick={() => goToDay(stepDay(shownDate, 1))}
            >
              <IconChevronRight size={14} />
            </button>
          </div>

          {/* Only when it would do something. */}
          {!isToday && (
            <button
              type="button"
              className="btn-secondary !py-1.5 !text-[12.5px]"
              onClick={() => goToDay(null)}
            >
              Today
            </button>
          )}

          <button
            type="button"
            className="btn-ghost !py-1.5 !text-[12.5px]"
            onClick={() => void load()}
          >
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

        {/*
          REGISTERING SOMEBODY, FROM THE SCREEN THEY ARE ALREADY ON.

          The commonest thing that happens at a front desk is a patient walking
          in who is not on the board — and the board was the one screen with no
          way to add them.

          ALONE ON THE RIGHT. Everything to its left — the day, the date picker,
          the refresh time — is a way of LOOKING at the day; this is the one
          control that changes it, so it is pushed away from them rather than
          filed among them. `ml-auto` on the button itself, so it stays at the
          right edge whether or not the rest has wrapped.

          Registration runs into booking, so this is the whole walk-in flow and
          not just a form.
        */}
        {can('patient:write') && (
          <Link
            href="/patients/register"
            className="btn-primary ml-auto whitespace-nowrap !py-1.5 !text-[12.5px]"
          >
            <IconUserPlus size={14} />
            Register a patient
          </Link>
        )}
      </header>

      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-card border border-clinical/30 bg-clinical-tint p-3 text-[13.5px]">
          <span>{notice}</span>
          <button
            type="button"
            className="shrink-0 text-ink-40 hover:text-ink"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            &times;
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-coral/30 bg-coral/8 p-3 text-[13.5px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={14} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {/* Stage first, then person: which part of the day, then who in it. */}
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Stage" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => {
            const count =
              t.bucket === null
                ? (board?.counts.total ?? 0)
                : (board?.counts[COUNT_KEY[t.bucket]] ?? 0);
            const on = tab === t.key;

            return (
              <Link
                key={t.key}
                href={`/?tab=${t.key}`}
                scroll={false}
                aria-current={on ? 'page' : undefined}
                className={[
                  'flex items-center gap-2 rounded-pill border-[1.5px] px-3.5 py-1.5 text-[13px] font-semibold transition-colors',
                  on
                    ? 'border-clinical bg-clinical text-white'
                    : 'border-ink/12 bg-card text-ink-60 hover:border-ink/25 hover:bg-bg-soft',
                ].join(' ')}
              >
                {t.label}
                <span
                  className={[
                    'rounded-pill px-1.5 text-[12px] font-bold tabular-nums',
                    on ? 'bg-white/20' : 'bg-ink/8 text-ink',
                  ].join(' ')}
                >
                  {count}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Its own full-width row on a phone — 230px beside six tabs is how a
            390px screen ends up scrolling sideways. Unchanged from md up. */}
        <label className="relative ml-auto w-full md:w-auto">
          <span className="sr-only">Find someone on this list</span>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-20">
            <IconSearch size={14} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, UHID or token"
            className="field-input !w-full !py-2 !pl-9 text-[16px] md:!w-[230px] md:!py-1.5 md:text-[13px]"
          />
        </label>
      </div>

      {!board ? (
        <BoardSkeleton />
      ) : (
        <>
          <div className="card overflow-hidden">
            {/*
              PHONE FIRST, THEN THE TABLE.

              Ten columns inside a sideways scroll means reading a name and
              swiping right to reach its button — on the screen the whole clinic
              lands on. Below `md` each patient is a card instead.

              THE TABLE'S MARKUP IS UNTOUCHED, and hidden rather than rebuilt
              responsively. A desk at 1280px must render exactly what it
              rendered yesterday, and the only way to be certain of that is for
              its markup to be the same markup. The cost is the rows appearing
              in two places; the rule that keeps that honest is that both read
              the same `shown` array and the same helpers — `Fee`, `Chip`,
              `ROW_TONE`, `NextStepAction` — so a fee tag is still defined once.
            */}
            <ul className="divide-y divide-ink/6 md:hidden">
              {shown.map((r) => (
                <DayBoardCard
                  key={r.patient.id}
                  row={r}
                  showsStage={active.bucket === null}
                  showsMoney={showsMoney}
                  can={can}
                  isToday={isToday}
                  busy={acting === r.patient.id}
                  onDo={(step) => void doStep(r, step)}
                  onSendForTest={
                    showsSendForTest && r.appointmentId && SENDABLE.has(r.bucket)
                      ? () => setSendingFor(r)
                      : null
                  }
                  onFinish={
                    mayAct &&
                    can('appointment:write') &&
                    r.bucket === 'WITH_DOCTOR' &&
                    r.appointmentId &&
                    firstDoableStep(r.nextSteps, can, isToday)?.kind !== 'FINISH'
                      ? () => void doStep(r, { kind: 'FINISH', appointmentId: r.appointmentId! })
                      : null
                  }
                />
              ))}

              {shown.length === 0 && (
                <li className="px-4 py-12 text-center text-[13.5px] text-ink-40">
                  {query.trim()
                    ? `Nobody on this list matches “${query.trim()}”.`
                    : isToday
                      ? emptyMessage(active.bucket)
                      : `Nothing on this list for ${dayLabel(shownDate)}.`}
                </li>
              )}
            </ul>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="border-b border-ink/8 bg-bg-soft text-left">
                    <Th className="w-[74px]">Time</Th>
                    <Th className="w-[70px]">Token</Th>
                    <Th>Patient</Th>
                    <Th className="w-[96px]">Age / Sex</Th>
                    <Th>With</Th>
                    <Th>Here for</Th>
                    <Th>Payment</Th>
                    <Th className="w-[120px]">Method</Th>
                    {showsMoney && <Th className="w-[112px] text-right">Amount</Th>}
                    {active.bucket === null && <Th className="w-[130px]">Stage</Th>}
                    {showsActions && (
                      <Th className="w-[190px]">
                        <span className="sr-only">Actions</span>
                      </Th>
                    )}
                  </tr>
                </thead>

                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={r.patient.id}
                      className={[
                        'border-b border-ink/6 transition-colors last:border-0',
                        ROW_TONE[r.bucket] ?? 'hover:bg-clinical-tint/60',
                      ].join(' ')}
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[12.5px] tabular-nums text-ink-60">
                        {r.time ?? '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {r.token === null ? (
                          // A walk-in test never had a token: tokens belong to a
                          // doctor's queue, and this patient is not in one.
                          <span className="text-ink-20">—</span>
                        ) : (
                          <span className="badge-neutral font-mono tabular-nums">#{r.token}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/patients/${r.patient.id}`}
                          className="font-semibold text-ink underline-offset-2 hover:text-clinical-text hover:underline"
                        >
                          {r.patient.name}
                        </Link>
                        <span className="block font-mono text-[11.5px] text-ink-40">
                          {r.patient.uhid}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-ink-60">
                        {r.patient.ageYears === null
                          ? '—'
                          : formatAge({ ageYears: r.patient.ageYears, birthDate: null })}
                        {' · '}
                        {genderInitial(r.patient.gender)}
                      </td>
                      <td className="px-4 py-3 text-ink-60">{r.withWhom ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1.5">
                          {r.hasVisit && (
                            <Chip tone="bg-clinical-soft text-clinical-text">Doctor visit</Chip>
                          )}
                          {r.hasTest && (
                            <Chip tone="bg-clinical-tint text-clinical-text">Test</Chip>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1.5">
                          <Fee label="Fee" state={r.visitFee} />
                          <Fee label="Tests" state={r.testFee} />
                          {r.visitFee === null && r.testFee === null && (
                            <span className="text-ink-20">—</span>
                          )}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-ink-60">
                        {r.paymentMethods.length === 0 ? (
                          <span className="text-ink-20">—</span>
                        ) : (
                          r.paymentMethods.map(payMethodLabel).join(', ')
                        )}
                      </td>
                      {showsMoney && (
                        <td className="whitespace-nowrap px-4 py-3 text-right">
                          {r.money && r.money.billedPaise > 0 ? (
                            <>
                              <span className="font-mono font-semibold tabular-nums">
                                {formatPaise(r.money.billedPaise)}
                              </span>
                              {/* Only what is still owed gets the colour. A
                                  settled bill needs no second line. */}
                              {r.money.duePaise > 0 && (
                                <span className="block font-mono text-[11.5px] font-semibold tabular-nums text-amber-text">
                                  {formatPaise(r.money.duePaise)} due
                                </span>
                              )}
                            </>
                          ) : (
                            // Nothing charged, which is not the same as nothing
                            // collected — a clinic that has priced nothing
                            // raises no bill at all.
                            <span className="text-ink-20">—</span>
                          )}
                        </td>
                      )}
                      {active.bucket === null && (
                        <td className="px-4 py-3">
                          <Chip tone={BUCKET_TONE[r.bucket]}>{BUCKET_LABEL[r.bucket]}</Chip>
                        </td>
                      )}
                      {showsActions && (
                        <td className="px-4 py-3">
                          <span className="flex flex-wrap items-center justify-end gap-1.5">
                            <NextStepAction
                              row={r}
                              can={can}
                              isToday={isToday}
                              busy={acting === r.patient.id}
                              onDo={(step) => void doStep(r, step)}
                            />

                            {/*
                              CLOSING THE OPD.

                              Offered beside the primary rather than as it: the
                              doctor's one button stays "open the consultation",
                              because finishing a visit cannot be undone and
                              should not be what a misplaced click does. For the
                              front desk, who hold no `consultation:write`, Done
                              IS the primary — and then this would be the same
                              button twice, so it is left out.
                            */}
                            {mayAct &&
                              can('appointment:write') &&
                              r.bucket === 'WITH_DOCTOR' &&
                              r.appointmentId &&
                              firstDoableStep(r.nextSteps, can, isToday)?.kind !== 'FINISH' && (
                                <button
                                  type="button"
                                  className="btn-ghost !px-2 !py-1 !text-[12px]"
                                  disabled={acting === r.patient.id}
                                  onClick={() =>
                                    void doStep(r, {
                                      kind: 'FINISH',
                                      appointmentId: r.appointmentId as string,
                                    })
                                  }
                                >
                                  Done
                                </button>
                              )}

                            {/* Beside the next step, not instead of it: sending
                                for a test is something the doctor decides to
                                add, not the thing the patient is waiting for.
                                Only for somebody actually here — ordering a
                                test for a patient who has not arrived raises a
                                bill for a visit that may never happen. */}
                            {showsSendForTest && r.appointmentId && SENDABLE.has(r.bucket) && (
                              <button
                                type="button"
                                className="btn-ghost !px-2 !py-1 !text-[12px]"
                                disabled={acting === r.patient.id}
                                onClick={() => setSendingFor(r)}
                              >
                                Send for a test
                              </button>
                            )}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}

                  {shown.length === 0 && (
                    <tr>
                      <td
                        colSpan={columns}
                        className="px-4 py-12 text-center text-[13.5px] text-ink-40"
                      >
                        {query.trim()
                          ? `Nobody on this list matches “${query.trim()}”.`
                          : isToday
                            ? emptyMessage(active.bucket)
                            : `Nothing on this list for ${dayLabel(shownDate)}.`}
                      </td>
                    </tr>
                  )}
                </tbody>

                {/*
                  THE TOTAL UNDER THE COLUMN, for everything the tab matches —
                  not just the page on screen, which would make the figure
                  change as somebody paged through it.

                  The day's total is in the header above; this one answers "how
                  much is sitting in the waiting room" and "what did we take off
                  the people who have gone home", which is what the tabs are
                  for.
                */}
                {shownMoney && shown.length > 0 && (
                  <tfoot>
                    <tr className="border-t-[1.5px] border-ink/10 bg-bg-soft">
                      <td colSpan={8} className="px-4 py-2.5 text-[12.5px] text-ink-60">
                        {active.label} — {filtered.length}{' '}
                        {filtered.length === 1 ? 'patient' : 'patients'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <span className="font-mono font-semibold tabular-nums">
                          {formatPaise(shownMoney.billedPaise)}
                        </span>
                        {shownMoney.duePaise > 0 && (
                          <span className="block font-mono text-[11.5px] font-semibold tabular-nums text-amber-text">
                            {formatPaise(shownMoney.duePaise)} due
                          </span>
                        )}
                      </td>
                      {/* The stage and action columns, left empty. */}
                      {columns > 9 && <td colSpan={columns - 9} />}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="field-hint !mt-0" role="status">
              {filtered.length === 0
                ? 'Nothing to show'
                : `Showing ${first}–${last} of ${filtered.length}`}
              {notAttending > 0 && (
                <span className="ml-2 inline-flex items-center gap-1.5 text-ink-40">
                  <IconUsers size={12} />
                  {notAttending} cancelled or did not turn up
                </span>
              )}
            </p>

            <Pagination
              page={page}
              totalPages={totalPages}
              hrefFor={(n) => `/?tab=${tab}${n > 1 ? `&page=${n}` : ''}`}
              label="Day board pages"
            />
          </div>
        </>
      )}

      {collecting && (
        /* The same dialog the queue and the finance desk use, rather than a
           third one that would drift from both. */
        <PaymentDialog
          invoice={collecting}
          onSettled={setCollecting}
          onClose={() => {
            setCollecting(null);
            // Money changes what the row needs next — a settled bill turns
            // Collect into Check in — so the board is re-read, not patched.
            void load();
          }}
        />
      )}

      {recording && (
        <RecordResultDialog
          row={recording.row}
          orderId={recording.orderId}
          onClose={() => setRecording(null)}
          onRecorded={(message) => {
            setRecording(null);
            setNotice(message);
            void load();
          }}
        />
      )}

      {sendingFor && (
        <SendForTestDialog
          row={sendingFor}
          onClose={() => setSendingFor(null)}
          onSent={(message) => {
            setSendingFor(null);
            setNotice(message);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Buckets a patient can be sent for a test from.
 *
 * DONE is in the list. A doctor finishes a consultation, the patient stands up,
 * and the doctor decides they want a film after all — which is a normal way for
 * an afternoon to go, and until this included DONE the only way to act on it
 * was to pretend the visit had not finished. The server has never minded:
 * `createOrder` reads the visit's id and patient and does not look at its
 * status.
 *
 * Ordering against a finished visit moves the patient back to "At a department"
 * on its own, because a pending order places there and that beats Done.
 *
 * EXPECTED is still out: a patient who has not arrived cannot be sent anywhere,
 * and raising a charge for one is how a bill exists for a visit that never
 * happens.
 */
const SENDABLE = new Set<DayBucket>(['WITH_DOCTOR', 'WAITING', 'AT_DEPARTMENT', 'DONE']);

/**
 * A day either side, in `YYYY-MM-DD`.
 *
 * Stepped through UTC midday on purpose. Building a Date from a bare date
 * string and adding 24 hours lands an hour out either side of a daylight-saving
 * change in any zone that has one — India has none today, but the clinic
 * timezone is a column in the database, and a board that skipped a day in a
 * clinic abroad would be an exceptionally quiet bug.
 */
function stepDay(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** "Tue 13 Oct" — enough to know which day you are looking at. */
function dayLabel(date: string): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}

function emptyMessage(bucket: DayBucket | null): string {
  switch (bucket) {
    case 'EXPECTED':
      return 'Nobody else is booked for today.';
    case 'WAITING':
      return 'Nobody is waiting.';
    case 'WITH_DOCTOR':
      return 'No consultation is in progress.';
    case 'AT_DEPARTMENT':
      return 'Nobody is having a test.';
    case 'DONE':
      return 'Nobody has finished yet.';
    default:
      return 'Nothing booked today, and nobody has walked in.';
  }
}

/**
 * The one button this person gets on this row.
 *
 * Nothing at all when there is nothing for them to do — an empty cell, not a
 * disabled button, because a greyed-out control invites somebody to work out
 * why and there is no answer worth reading.
 *
 * A receipt is its own component: printing owns a hidden sheet and a server
 * print log, and routing it through the same handler as the others would mean
 * duplicating both.
 */
function NextStepAction({
  row,
  can,
  isToday,
  busy,
  onDo,
}: {
  row: DayBoardRow;
  can: (permission: string) => boolean;
  isToday: boolean;
  busy: boolean;
  onDo: (step: NextStep) => void;
}) {
  const step = firstDoableStep(row.nextSteps, can, isToday);
  if (!step) return null;

  if (step.kind === 'RECEIPT') {
    return (
      <PrintReceiptButton
        paymentId={step.paymentId}
        className="btn-ghost !px-2.5 !py-1 !text-[12px]"
        label="Receipt"
        iconSize={13}
      />
    );
  }

  return (
    <button
      type="button"
      className="btn-secondary !px-3 !py-1 !text-[12.5px]"
      disabled={busy}
      onClick={() => onDo(step)}
    >
      {busy ? '…' : stepLabel(step)}
      {/* The figure, on the one step that is about money. Reading "Collect"
          and then meeting an amount in a dialog is a surprise; reading
          "Collect ₹500" is an instruction. */}
      {step.kind === 'COLLECT' && !busy && (
        <span className="font-mono tabular-nums"> {formatPaise(step.duePaise)}</span>
      )}
    </button>
  );
}

/**
 * One patient, as a card, for a phone.
 *
 * The same facts as the table row, ordered by what somebody standing up reads
 * first: who it is, then where they are, then what is owed, then the one thing
 * to do about it. The token keeps the prominence it has on the worklist — it is
 * what the patient is called by.
 *
 * Tinted by stage with `ROW_TONE`, exactly as the row is, so the two layouts
 * say the same thing in the same colours.
 *
 * The action is full width at the bottom. A 26px button in a table cell is fine
 * under a mouse; under a thumb, on the screen that takes the clinic's money, it
 * is not.
 */
function DayBoardCard({
  row,
  showsStage,
  showsMoney,
  can,
  isToday,
  busy,
  onDo,
  onSendForTest,
  onFinish,
}: {
  row: DayBoardRow;
  showsStage: boolean;
  showsMoney: boolean;
  can: (permission: string) => boolean;
  isToday: boolean;
  busy: boolean;
  onDo: (step: NextStep) => void;
  /** Null when this row may not be sent for a test. */
  onSendForTest: (() => void) | null;
  /** Null when Done is not an extra action here — see the table's note. */
  onFinish: (() => void) | null;
}) {
  const step = firstDoableStep(row.nextSteps, can, isToday);
  const hasExtra = onSendForTest !== null || onFinish !== null;

  return (
    <li className={`px-4 py-3.5 ${ROW_TONE[row.bucket] ?? ''}`}>
      <div className="flex items-start gap-3">
        {/* The number they are called by, and the time they are here for. */}
        <div className="w-[52px] shrink-0 text-center">
          {row.token === null ? (
            <span className="mono-label block !text-ink-20">walk-in</span>
          ) : (
            <span className="block font-mono text-[19px] font-bold leading-none tabular-nums">
              #{row.token}
            </span>
          )}
          {row.time && (
            <span className="mt-1 block font-mono text-[11px] tabular-nums text-ink-40">
              {row.time}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <Link
            href={`/patients/${row.patient.id}`}
            className="block truncate text-[15px] font-semibold text-ink"
          >
            {row.patient.name}
          </Link>

          <p className="mt-0.5 text-[12px] text-ink-40">
            <span className="font-mono">{row.patient.uhid}</span>
            {row.patient.ageYears !== null && (
              <>
                {' · '}
                {formatAge({ ageYears: row.patient.ageYears, birthDate: null })}{' '}
                {genderInitial(row.patient.gender)}
              </>
            )}
            {row.withWhom ? ` · ${row.withWhom}` : ''}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {showsStage && <Chip tone={BUCKET_TONE[row.bucket]}>{BUCKET_LABEL[row.bucket]}</Chip>}
            {row.hasVisit && <Chip tone="bg-clinical-soft text-clinical-text">Doctor visit</Chip>}
            {row.hasTest && <Chip tone="bg-clinical-tint text-clinical-text">Test</Chip>}
            <Fee label="Fee" state={row.visitFee} />
            <Fee label="Tests" state={row.testFee} />
          </div>

          {/* Money on its own line, right where the eye lands after the tags. */}
          {showsMoney && row.money && row.money.billedPaise > 0 && (
            <p className="mt-1.5 font-mono text-[12.5px] tabular-nums text-ink-60">
              {formatPaise(row.money.billedPaise)}
              {row.money.duePaise > 0 && (
                <span className="font-semibold text-amber-text">
                  {' · '}
                  {formatPaise(row.money.duePaise)} due
                </span>
              )}
              {row.paymentMethods.length > 0 && (
                <span className="text-ink-40">
                  {' '}
                  · {row.paymentMethods.map(payMethodLabel).join(', ')}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Full width, thumb height. The primary action first, the extras after. */}
      {(step || hasExtra) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {step &&
            (step.kind === 'RECEIPT' ? (
              <PrintReceiptButton
                paymentId={step.paymentId}
                className="btn-secondary flex-1 !py-2 !text-[13px]"
                label="Receipt"
                iconSize={14}
              />
            ) : (
              <button
                type="button"
                className="btn-primary flex-1 !py-2 !text-[13px]"
                disabled={busy}
                onClick={() => onDo(step)}
              >
                {busy ? '…' : stepLabel(step)}
                {step.kind === 'COLLECT' && !busy && (
                  <span className="font-mono tabular-nums"> {formatPaise(step.duePaise)}</span>
                )}
              </button>
            ))}

          {onFinish && (
            <button
              type="button"
              className="btn-secondary !py-2 !text-[13px]"
              disabled={busy}
              onClick={onFinish}
            >
              Done
            </button>
          )}

          {onSendForTest && (
            <button
              type="button"
              className="btn-secondary !py-2 !text-[13px]"
              disabled={busy}
              onClick={onSendForTest}
            >
              Send for a test
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`mono-label px-4 py-2.5 ${className}`}>
      {children}
    </th>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span
      className={`whitespace-nowrap rounded-pill px-2 py-0.5 text-[11.5px] font-semibold ${tone}`}
    >
      {children}
    </span>
  );
}

/**
 * "Fee paid" / "Fee pending", and nothing at all when nothing was charged.
 *
 * The third state is the important one: billing is opt-in per clinic, so a
 * clinic that has priced nothing would otherwise open this screen to a wall of
 * "pending" against patients who owe it nothing.
 */
function Fee({ label, state }: { label: string; state: FeeTag }) {
  if (state === null) return null;

  return (
    <Chip
      tone={state === 'PAID' ? 'bg-green-soft text-green-text' : 'bg-amber-soft text-amber-text'}
    >
      {label} {state === 'PAID' ? 'paid' : 'pending'}
    </Chip>
  );
}

function BoardSkeleton() {
  return (
    <div className="card overflow-hidden p-4">
      <div className="space-y-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-4">
            <div className="skeleton h-4 w-12" />
            <div className="skeleton h-4 w-10" />
            <div className="skeleton h-4 flex-1" />
            <div className="skeleton h-4 w-20" />
            <div className="skeleton h-4 w-28" />
            <div className="skeleton h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
