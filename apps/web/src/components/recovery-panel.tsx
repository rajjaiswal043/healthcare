'use client';

import { useEffect, useState } from 'react';
import { api, ApiRequestError, type Recovery } from '@/lib/api';
import { IconAlert, IconPulse } from '@/components/icons';

/**
 * How the patient did since the last visit, from their own check-ins — docs/10.
 *
 * Above everything else on a follow-up, because it answers the first question
 * of one ("better or worse?") in the patient's words, collected on the days
 * they happened rather than remembered in the chair.
 *
 * Renders nothing on a first visit, or when the last one set no check-ins. An
 * empty chart is noise on the commonest case.
 */
export function RecoveryPanel({ encounterId }: { encounterId: string }) {
  const [recovery, setRecovery] = useState<Recovery | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRecovery((await api.recovery(encounterId)).recovery);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.error.message : 'Could not load check-ins.');
        setRecovery(null);
      }
    })();
  }, [encounterId]);

  if (recovery === undefined) return null;
  if (recovery === null && !error) return null;

  if (!recovery) {
    return (
      <section className="card p-5">
        <p className="flex items-start gap-2 text-[13px] text-coral-text">
          <IconAlert size={14} />
          {error}
        </p>
      </section>
    );
  }

  const s = recovery.summary;
  const answered = recovery.checkins.filter((c) => c.answeredAt && c.painScore !== null);
  const quotes = answered.filter((c) => c.note).slice(-2);
  const openFlags = recovery.checkins.filter((c) => c.flagOpen);

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-[17px] font-bold">
          <IconPulse size={16} />
          Since last visit
        </h2>
        <span className="text-[12.5px] text-ink-40">
          {new Date(recovery.since).toLocaleDateString('en-IN', { dateStyle: 'medium' })} · from{' '}
          {s.answered} WhatsApp check-in{s.answered === 1 ? '' : 's'}
        </span>
      </div>

      {openFlags.length > 0 && (
        <p className="mt-3 rounded-panel border border-coral/25 bg-coral/8 px-3 py-2 text-[12.5px] text-coral-text">
          {openFlags.map((f) => f.flagReason).join(' · ')} — not yet called back.
        </p>
      )}

      {answered.length === 0 ? (
        <p className="mt-3 rounded-panel bg-bg-soft px-3 py-4 text-[13px] text-ink-60">
          {s.missed > 0
            ? `${s.missed} check-in${s.missed === 1 ? ' was' : 's were'} sent and none answered. Worth asking why.`
            : 'No check-ins answered yet.'}
        </p>
      ) : (
        <>
          <p className="mt-3 text-[13px] font-semibold">
            Pain, 0 to 10:{' '}
            <span
              className={
                (s.lastPain ?? 0) < (s.firstPain ?? 0) ? 'text-green-text' : 'text-coral-text'
              }
            >
              {s.firstPain} → {s.lastPain}
            </span>
          </p>
          <PainChart points={answered.map((c) => ({ at: c.answeredAt!, pain: c.painScore! }))} />

          {s.exercisesAnswered > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-[12.5px]">
                <span className="font-semibold">Exercises done</span>
                <span className="text-ink-60">
                  {s.exercisesDone} of {s.exercisesAnswered} days asked
                </span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-ink/8">
                <div
                  className="h-2 rounded-full bg-clinical"
                  style={{ width: `${Math.round((s.exercisesDone / s.exercisesAnswered) * 100)}%` }}
                />
              </div>
            </div>
          )}

          {quotes.map((q) => (
            <blockquote
              key={q.id}
              className="mt-3 rounded-panel bg-bg-soft px-3.5 py-2.5 text-[13.5px]"
            >
              <p className="font-display font-semibold">“{q.note}”</p>
              <footer className="mt-0.5 text-[11.5px] text-ink-40">
                {new Date(q.answeredAt!).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
              </footer>
            </blockquote>
          ))}

          {s.missed > 0 && (
            <p className="mt-2 text-[12px] text-ink-40">
              {s.missed} check-in{s.missed === 1 ? '' : 's'} not answered.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Pain over time. The scale is fixed at 0–10 so two patients' charts read alike. */
function PainChart({ points }: { points: Array<{ at: string; pain: number }> }) {
  const W = 320;
  const H = 120;
  const left = 22;
  const right = 14;
  const top = 10;
  const bottom = 20;
  const plotW = W - left - right;
  const plotH = H - top - bottom;

  const times = points.map((p) => new Date(p.at).getTime());
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const x = (t: number) => left + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
  const y = (pain: number) => top + plotH - (pain / 10) * plotH;

  const xy = points.map((p) => ({ x: x(new Date(p.at).getTime()), y: y(p.pain), pain: p.pain }));
  const line = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const last = xy.at(-1)!;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 w-full"
      role="img"
      aria-label="Pain score by check-in"
    >
      {[0, 5, 10].map((v) => (
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
            x={left - 5}
            y={y(v) + 3}
            textAnchor="end"
            className="fill-ink-40 font-mono text-[8.5px]"
          >
            {v}
          </text>
        </g>
      ))}
      {xy.length > 1 && (
        <path
          d={`${line} L${last.x},${y(0)} L${xy[0]!.x},${y(0)} Z`}
          className="fill-clinical/10"
        />
      )}
      <path
        d={line}
        fill="none"
        strokeWidth={2.5}
        strokeLinejoin="round"
        className="stroke-clinical"
      />
      {xy.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={i === xy.length - 1 ? 4.5 : 3}
          className={
            p.pain >= 8
              ? 'fill-coral'
              : i === xy.length - 1
                ? 'fill-clinical'
                : 'fill-white stroke-clinical'
          }
          strokeWidth={2}
        />
      ))}
      <text
        x={last.x - 6}
        y={last.y < top + 14 ? last.y + 16 : last.y - 8}
        textAnchor="end"
        className="fill-clinical-text font-display text-[12px] font-bold"
      >
        {last.pain}
      </text>
      <text x={left} y={H - 5} className="fill-ink-40 font-mono text-[8.5px]">
        {new Date(t0).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
      </text>
      <text x={W - right} y={H - 5} textAnchor="end" className="fill-ink-40 font-mono text-[8.5px]">
        {new Date(t1).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
      </text>
    </svg>
  );
}
