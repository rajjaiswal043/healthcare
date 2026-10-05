'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiRequestError,
  type FollowUpBoard,
  type FollowUpRow,
  type FollowUpStatus,
} from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { formatPaise } from '@/lib/format';
import { IconAlert, IconChat, IconPhone, IconPulse, IconRefresh } from '@/components/icons';

const STATUS: Record<FollowUpStatus, { label: string; badge: string }> = {
  FLAGGED: { label: 'Pain rising', badge: 'badge-coral' },
  OVERDUE: { label: 'Overdue', badge: 'badge-amber' },
  DUE: { label: 'Due', badge: 'badge-neutral' },
  BOOKED: { label: 'Booked', badge: 'badge-clinical' },
  CAME_BACK: { label: 'Came back', badge: 'badge-green' },
};

/**
 * The follow-up board — docs/10.
 *
 * Read in the order a front desk works it: the patient whose pain is rising
 * first (somebody calls them now), then the overdue (a reminder, or a call),
 * then this week's reviews. The return rate is at the side, for the owner; the
 * list is the job.
 */
export default function FollowUpsPage() {
  const { can } = useAuth();
  const mayManage = can('followup:manage');

  const [board, setBoard] = useState<FollowUpBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await api.followUps());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load follow-ups.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    try {
      setNotice(await fn());
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  const remind = (row: FollowUpRow) =>
    act(`remind-${row.encounterId}`, async () => {
      const { status } = await api.remindReview(row.encounterId);
      return status === 'SENT'
        ? `Reminder sent to ${firstName(row.patient.name)}.`
        : `${firstName(row.patient.name)} has not agreed to WhatsApp messages. Call them on ${row.patient.mobile}.`;
    });

  const clear = (row: FollowUpRow) =>
    row.flag &&
    act(`clear-${row.encounterId}`, async () => {
      await api.clearFlag(row.flag!.checkinId);
      return `Marked as called back: ${row.patient.name}.`;
    });

  if (!board && !error) return <p className="text-[14px] text-ink-60">Loading…</p>;

  const s = board?.stats;
  const returnRate = s && s.dueThisWeek > 0 ? Math.round((s.cameBack / s.dueThisWeek) * 100) : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Between visits</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">Follow-ups</h1>
          <p className="mt-1 text-[14px] text-ink-60">
            {board
              ? `This week, ${formatDay(board.weekStart)} – ${formatDay(board.weekEnd)}. Who is due back, who came back, and who needs a nudge.`
              : 'Who is due back, who came back, and who needs a nudge.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary !px-3"
            onClick={() => void load()}
            aria-label="Refresh"
            title="Refresh"
          >
            <IconRefresh size={16} />
          </button>
          {mayManage && (
            <>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy !== null}
                onClick={() =>
                  void act('dispatch', async () => {
                    const { sent } = await api.dispatchCheckins();
                    return sent === 0
                      ? 'No check-ins are due right now.'
                      : `Sent ${sent} check-in${sent === 1 ? '' : 's'}.`;
                  })
                }
              >
                <IconPulse size={15} />
                Send due check-ins now
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || !s || s.overdue === 0}
                onClick={() =>
                  void act('remind-all', async () => {
                    const { sent, skipped } = await api.remindAllOverdue();
                    return `Reminded ${sent}.${skipped > 0 ? ` ${skipped} need a call instead — no WhatsApp consent, or reminded in the last day.` : ''}`;
                  })
                }
              >
                <IconChat size={15} />
                Remind everyone overdue{s && s.overdue > 0 ? ` (${s.overdue})` : ''}
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-coral/30 bg-coral/8 p-3 text-[13.5px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={15} />
          </span>
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-card border border-green/30 bg-green-soft/40 p-3 text-[13.5px]"
        >
          {notice}
        </div>
      )}

      {board && s && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Reviews due this week" value={String(s.dueThisWeek)} />
            <Tile
              label="Came back"
              value={String(s.cameBack)}
              suffix={returnRate !== null ? `${returnRate}%` : undefined}
              tone="green"
            />
            <Tile
              label="Overdue, last 30 days"
              value={String(s.overdue)}
              suffix={s.flagged > 0 ? `${s.flagged} pain rising` : undefined}
              tone={s.overdue + s.flagged > 0 ? 'coral' : undefined}
            />
            <Tile
              label="Waited from home today"
              value={
                s.waitedFromHome.total > 0
                  ? `${Math.round((s.waitedFromHome.opened / s.waitedFromHome.total) * 100)}%`
                  : '—'
              }
              suffix={
                s.waitedFromHome.total > 0
                  ? `${s.waitedFromHome.opened} of ${s.waitedFromHome.total}`
                  : undefined
              }
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-[1fr_1.35fr]">
            <section className="card p-5">
              <p className="mono-label">Came back for review</p>
              <p className="mt-1 text-[13px] text-ink-60">
                Share of reviews kept, week by week. A review counts once its date has passed.
              </p>
              <TrendChart trend={board.trend} />
              <p className="mt-3 border-t border-ink/8 pt-3 text-[13.5px]">
                Reviews kept this week:{' '}
                <strong className="font-semibold">{formatPaise(s.valueKeptPaise)}</strong>
                <span className="text-ink-40"> billed on return visits</span>
              </p>
            </section>

            <section className="card p-5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="mono-label">Needs a look</p>
                <span className="text-[12.5px] text-ink-40">
                  {board.rows.length} patient{board.rows.length === 1 ? '' : 's'}
                </span>
              </div>

              {board.rows.length === 0 ? (
                <EmptyBoard />
              ) : (
                <ul className="mt-3 space-y-2">
                  {board.rows.map((row) => (
                    <FollowUpItem
                      key={row.encounterId}
                      row={row}
                      mayManage={mayManage}
                      busy={busy}
                      onRemind={() => void remind(row)}
                      onClear={() => void clear(row)}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function FollowUpItem({
  row,
  mayManage,
  busy,
  onRemind,
  onClear,
}: {
  row: FollowUpRow;
  mayManage: boolean;
  busy: string | null;
  onRemind: () => void;
  onClear: () => void;
}) {
  const status = STATUS[row.status];
  const c = row.checkins;

  return (
    <li
      className={[
        'rounded-panel border px-3.5 py-3',
        row.status === 'FLAGGED' ? 'border-coral/30 bg-coral/5' : 'border-ink/8 bg-white',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={[
              'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold',
              row.status === 'FLAGGED'
                ? 'bg-coral-soft text-coral-text'
                : row.status === 'CAME_BACK'
                  ? 'bg-green-soft text-green-text'
                  : 'bg-ink/6 text-ink-60',
            ].join(' ')}
          >
            {initials(row.patient.name)}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/patients/${row.patient.id}`}
                className="truncate text-[14px] font-semibold hover:text-clinical-text hover:underline"
              >
                {row.patient.name}
              </Link>
              <span className={status.badge}>{status.label}</span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-ink-60">{describe(row)}</p>
            {c.answered > 0 && (
              <p className="mt-0.5 text-[12.5px] text-ink-40">
                Pain {c.firstPain} → <strong className="text-ink-60">{c.lastPain}</strong> over{' '}
                {c.answered} check-in{c.answered === 1 ? '' : 's'}
                {c.exercisesAnswered > 0 &&
                  ` · exercises ${c.exercisesDone} of ${c.exercisesAnswered} days`}
                {c.missed > 0 && ` · ${c.missed} missed`}
              </p>
            )}
            <p className="mt-0.5 text-[12px] text-ink-40">{row.practitioner.fullName}</p>
          </div>
        </div>

        {mayManage && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <a
              href={`tel:+91${row.patient.mobile}`}
              className="btn-ghost !px-2.5 !py-1.5 text-[12.5px]"
              title={`Call ${row.patient.mobile}`}
            >
              <IconPhone size={14} />
              <span className="font-mono">{row.patient.mobile}</span>
            </a>
            {row.status === 'FLAGGED' && (
              <button
                type="button"
                className="btn-secondary !px-3 !py-1.5 text-[12.5px]"
                disabled={busy !== null}
                onClick={onClear}
              >
                Called back
              </button>
            )}
            {(row.status === 'OVERDUE' || row.status === 'DUE') && (
              <button
                type="button"
                className="btn-secondary !px-3 !py-1.5 text-[12.5px]"
                disabled={busy !== null}
                onClick={onRemind}
                title={
                  row.lastRemindedAt
                    ? `Last reminded ${new Date(row.lastRemindedAt).toLocaleString('en-IN')}`
                    : undefined
                }
              >
                <IconChat size={14} />
                Remind
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** One line that says what is going on with this patient, in words. */
function describe(row: FollowUpRow): string {
  const review = row.reviewDate ? formatDay(row.reviewDate) : 'no review date';
  switch (row.status) {
    case 'FLAGGED':
      return `${row.flag?.reason ?? 'Flagged'} · review ${review}`;
    case 'OVERDUE':
      return `Review was ${review}, ${row.daysOverdue} day${row.daysOverdue === 1 ? '' : 's'} ago${
        row.lastRemindedAt ? ` · reminded ${formatDay(row.lastRemindedAt.slice(0, 10))}` : ''
      }`;
    case 'BOOKED':
      return `Review ${review} · booked for ${row.bookedFor ? new Date(row.bookedFor).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}`;
    case 'CAME_BACK':
      return `Came back ${row.cameBackAt ? formatDay(row.cameBackAt.slice(0, 10)) : ''}${
        row.valuePaise > 0 ? ` · ${formatPaise(row.valuePaise)}` : ''
      }`;
    default:
      return `Review ${review}`;
  }
}

function Tile({
  label,
  value,
  suffix,
  tone,
}: {
  label: string;
  value: string;
  suffix?: string | undefined;
  tone?: 'green' | 'coral' | undefined;
}) {
  const colour =
    tone === 'green' ? 'text-green-text' : tone === 'coral' ? 'text-coral-text' : 'text-ink';
  return (
    <div className="card p-4">
      <p className="text-[12.5px] text-ink-60">{label}</p>
      <p className="mt-2 flex items-baseline gap-2">
        <span className={`font-display text-[30px] font-bold leading-none ${colour}`}>{value}</span>
        {suffix && <span className="text-[12.5px] text-ink-40">{suffix}</span>}
      </p>
    </div>
  );
}

/**
 * Ten weeks of return rate. Hand-drawn SVG rather than a chart library — one
 * line on one scale does not justify a dependency.
 */
function TrendChart({ trend }: { trend: FollowUpBoard['trend'] }) {
  const W = 360;
  const H = 170;
  const left = 34;
  const right = 12;
  const top = 14;
  const bottom = 26;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const x = (i: number) => left + (trend.length <= 1 ? 0 : (i / (trend.length - 1)) * plotW);
  const y = (rate: number) => top + plotH - (rate / 100) * plotH;

  const points = trend
    .map((t, i) => (t.rate === null ? null : { x: x(i), y: y(t.rate), rate: t.rate }))
    .filter((p): p is { x: number; y: number; rate: number } => p !== null);
  const last = points.at(-1);

  if (points.length === 0) {
    return (
      <p className="mt-6 rounded-panel bg-bg-soft px-4 py-8 text-center text-[13px] text-ink-40">
        No review dates have passed yet. The line starts once the first one has.
      </p>
    );
  }

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const area = `${line} L${points.at(-1)!.x},${top + plotH} L${points[0]!.x},${top + plotH} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-3 w-full"
      role="img"
      aria-label="Return rate by week"
    >
      {[0, 50, 100].map((v) => (
        <g key={v}>
          <line
            x1={left}
            x2={W - right}
            y1={y(v)}
            y2={y(v)}
            stroke="currentColor"
            className="text-ink/10"
          />
          <text
            x={left - 6}
            y={y(v) + 3}
            textAnchor="end"
            className="fill-ink-40 font-mono text-[9px]"
          >
            {v}%
          </text>
        </g>
      ))}
      <path d={area} className="fill-clinical/10" />
      <path
        d={line}
        fill="none"
        strokeWidth={2.5}
        strokeLinejoin="round"
        className="stroke-clinical"
      />
      {points.map((p) => (
        <circle
          key={p.x}
          cx={p.x}
          cy={p.y}
          r={3}
          className="fill-white stroke-clinical"
          strokeWidth={2}
        />
      ))}
      {last && (
        <>
          <circle cx={last.x} cy={last.y} r={5} className="fill-clinical" />
          <text
            x={last.x - 4}
            y={last.y < top + 16 ? last.y + 18 : last.y - 10}
            textAnchor="end"
            className="fill-clinical-text font-display text-[13px] font-bold"
          >
            {last.rate}%
          </text>
        </>
      )}
      {trend.map((t, i) =>
        i % 3 === 0 || i === trend.length - 1 ? (
          <text
            key={t.weekStart}
            x={x(i)}
            y={H - 8}
            textAnchor="middle"
            className="fill-ink-40 font-mono text-[9px]"
          >
            {formatDay(t.weekStart)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function EmptyBoard() {
  return (
    <div className="mt-4 flex flex-col items-center rounded-panel bg-bg-soft px-6 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-clinical-soft text-clinical-text">
        <IconPulse size={20} />
      </span>
      <p className="mt-3 font-display text-[16px] font-semibold">Everyone is on track</p>
      <p className="mt-1 max-w-[42ch] text-[13px] text-ink-60">
        No reviews due this week, nobody overdue, and no rising pain. Set a follow-up date and
        check-ins when you sign a consultation, and they will show up here.
      </p>
    </div>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    (words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

function formatDay(date: string): string {
  return new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
