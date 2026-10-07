'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiRequestError, type DayBoard, type DayBucket, type FeeTag } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { Pagination } from '@/components/pagination';
import { formatAge, genderInitial } from '@/lib/format';
import { IconAlert, IconRefresh, IconSearch, IconUsers } from '@/components/icons';

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

/** One colour per stage, so the status column is readable without being read. */
const BUCKET_TONE: Record<DayBucket, string> = {
  EXPECTED: 'bg-ink/8 text-ink-60',
  WAITING: 'bg-amber-soft text-amber-text',
  WITH_DOCTOR: 'bg-clinical-soft text-clinical-text',
  AT_DEPARTMENT: 'bg-clinical-tint text-clinical-text',
  DONE: 'bg-green-soft text-green-text',
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

function DayBoardScreen() {
  const { session } = useAuth();
  const params = useSearchParams();

  const [board, setBoard] = useState<DayBoard | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const tab: TabKey = TABS.find((t) => t.key === params.get('tab'))?.key ?? 'everyone';
  const pageParam = Number(params.get('page') ?? '1');
  const requestedPage = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  // Read through a ref inside the interval, so the timer is never torn down and
  // rebuilt just because a render produced a new function.
  const loadRef = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    try {
      setBoard(await api.dayBoard());
      setRefreshedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load today.');
    }
  }, []);

  useEffect(() => {
    loadRef.current = () => void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Refresh every 30 seconds — but only while this tab is on screen.
   *
   * A board left open on a background tab polled all afternoon for nobody, and
   * browsers throttle those timers anyway, so the first thing somebody saw on
   * returning was stale. Coming back refetches immediately rather than waiting
   * out the interval, which is the case that reads as "it did not update".
   */
  useEffect(() => {
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
  }, []);

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

  const columns = active.bucket === null ? 9 : 8;
  const notAttending = board?.counts.not_attending ?? 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{board?.scope === 'OWN' ? 'Your patients' : 'The clinic'}</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">
            Today at {session?.tenant.name ?? 'the clinic'}
          </h1>
          <p className="mt-1 text-[14px] text-ink-60">
            {board
              ? `${board.counts.total} ${
                  board.counts.total === 1 ? 'patient' : 'patients'
                } expected today`
              : 'Loading today…'}
            {board?.scope === 'OWN' && ' · your list only'}
          </p>
        </div>

        <button
          type="button"
          className="btn-ghost !py-1.5 !text-[12.5px]"
          onClick={() => void load()}
        >
          <IconRefresh size={14} />
          {refreshedAt
            ? `Updated ${refreshedAt.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
              })}`
            : 'Refresh'}
        </button>
      </header>

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

        <label className="relative ml-auto">
          <span className="sr-only">Find someone on this list</span>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-20">
            <IconSearch size={14} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, UHID or token"
            className="field-input !w-[230px] !py-1.5 !pl-9 text-[13px]"
          />
        </label>
      </div>

      {!board ? (
        <BoardSkeleton />
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
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
                    {active.bucket === null && <Th className="w-[130px]">Stage</Th>}
                  </tr>
                </thead>

                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={r.patient.id}
                      className="border-b border-ink/6 transition-colors last:border-0 hover:bg-clinical-tint/60"
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
                      {active.bucket === null && (
                        <td className="px-4 py-3">
                          <Chip tone={BUCKET_TONE[r.bucket]}>{BUCKET_LABEL[r.bucket]}</Chip>
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
                          : emptyMessage(active.bucket)}
                      </td>
                    </tr>
                  )}
                </tbody>
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
    </div>
  );
}

/** CASH -> "Cash", BANK_TRANSFER -> "Bank transfer". */
function payMethodLabel(mode: string): string {
  const words = mode.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
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
