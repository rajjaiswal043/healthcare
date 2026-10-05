'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { ClinicLogo } from '@/components/clinic-logo';

/**
 * The page a patient opens from WhatsApp — docs/10.
 *
 * No login, no cookies: the key in the URL is the whole credential, exactly as
 * for a waiting-room screen. It is read on a phone, often an older one, often
 * by an older person, so everything here is large, one column, and asks for
 * taps rather than typing.
 *
 * What it can show is decided by the API, not here: a first name, a token, a
 * wait, the doctor, and on a recovery link the advice already printed on their
 * prescription. There is nothing more in the response to accidentally render.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';

/** A live place in line, refreshed while the page is open. */
const POLL_MS = 20000;

interface Header {
  clinic: { name: string; slug: string; logoVersion: string | null };
  patientFirstName: string;
  generatedAt: string;
}

interface VisitView extends Header {
  purpose: 'VISIT';
  visit: {
    token: number | null;
    status: string;
    isToday: boolean;
    date: string | null;
    time: string | null;
    doctor: { name: string; specialty: string | null };
    nowServing: number | null;
    ahead: number | null;
    etaMinutes: number | null;
    arrivalIntent: 'ON_THE_WAY' | 'RUNNING_LATE' | null;
  };
}

interface RecoveryData {
  doctor: string;
  visitDate: string;
  reviewDate: string | null;
  intervalDays: number | null;
  advice: string | null;
  instructions: string | null;
  answeredToday: boolean;
  history: Array<{ date: string; painScore: number | null; exercisesDone: boolean | null }>;
}

interface RecoveryView extends Header {
  purpose: 'RECOVERY';
  recovery: RecoveryData;
}

type View = VisitView | RecoveryView;

export default function PatientLinkPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const [view, setView] = useState<View | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`${API_BASE}/p/${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (res.status === 410) {
        setProblem(
          'This link has expired. The clinic will send you a new one with your next visit.',
        );
        return;
      }
      if (!res.ok) {
        setProblem(
          'This link does not work. Please check you opened the whole link from the message.',
        );
        return;
      }
      setView((await res.json()) as View);
      setProblem(null);
    } catch {
      // Offline for a moment. Keep what is on screen.
    } finally {
      inFlight.current = false;
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view?.purpose !== 'VISIT') return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [view?.purpose, load]);

  if (problem && !view) {
    return (
      <Shell>
        <div className="card p-6 text-center">
          <p className="font-display text-[20px] font-bold">Sorry</p>
          <p className="mt-2 text-[15px] text-ink-60">{problem}</p>
        </div>
      </Shell>
    );
  }

  if (!view) {
    return (
      <Shell>
        <p className="py-16 text-center text-[16px] text-ink-40">Opening…</p>
      </Shell>
    );
  }

  return (
    <Shell clinic={view.clinic}>
      {view.purpose === 'VISIT' ? (
        <VisitCard view={view} linkKey={key} onChanged={load} />
      ) : (
        <RecoveryCard
          view={view}
          linkKey={key}
          onAnswered={(r) => setView({ ...view, recovery: r })}
        />
      )}
    </Shell>
  );
}

// --- the visit ----------------------------------------------------------------

function VisitCard({
  view,
  linkKey,
  onChanged,
}: {
  view: VisitView;
  linkKey: string;
  onChanged: () => Promise<void>;
}) {
  const v = view.visit;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function say(intent: 'ON_THE_WAY' | 'RUNNING_LATE') {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/p/${encodeURIComponent(linkKey)}/arrival`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'That did not go through. Please try again.');
      }
      await onChanged();
    } finally {
      setSending(false);
    }
  }

  const headline =
    v.status === 'IN_PROGRESS'
      ? 'It is your turn now'
      : v.status === 'FULFILLED'
        ? 'Your visit is done'
        : v.status === 'CANCELLED' || v.status === 'NO_SHOW'
          ? 'This visit is no longer booked'
          : v.status === 'ARRIVED'
            ? 'You are checked in'
            : !v.isToday
              ? 'Your visit is booked'
              : v.etaMinutes !== null && v.etaMinutes <= 30
                ? 'Time to set off'
                : 'Wait from home';

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[16px] text-ink-60">Namaste {view.patientFirstName},</p>
        <h1 className="font-display text-[28px] font-bold leading-tight">{headline}</h1>
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-4 p-5">
          <div>
            <p className="mono-label">Your token</p>
            <p className="font-display text-[64px] font-extrabold leading-none text-clinical">
              {v.token ?? '—'}
            </p>
          </div>
          {v.isToday && (v.status === 'BOOKED' || v.status === 'ARRIVED') && (
            <div className="text-right">
              <p className="font-display text-[22px] font-bold">
                {v.ahead === 0 ? 'You are next' : `${v.ahead} ahead`}
              </p>
              {v.etaMinutes !== null && (
                <p className="text-[15px] text-ink-60">about {v.etaMinutes} min</p>
              )}
            </div>
          )}
        </div>

        {v.isToday && (v.status === 'BOOKED' || v.status === 'ARRIVED') && v.ahead !== null && (
          <div className="flex items-center gap-2 px-5 pb-4" aria-hidden="true">
            {Array.from({ length: Math.min(v.ahead, 8) }).map((_, i) => (
              <span key={i} className="h-3.5 w-3.5 rounded-full bg-ink/15" />
            ))}
            {v.ahead > 8 && <span className="text-[12px] text-ink-40">+{v.ahead - 8}</span>}
            <span className="rounded-pill bg-clinical px-2.5 py-0.5 text-[12px] font-semibold text-white">
              You
            </span>
          </div>
        )}

        <div className="border-t border-ink/8 bg-bg-soft px-5 py-3 text-[14px]">
          <p className="font-semibold">{v.doctor.name}</p>
          <p className="text-ink-60">
            {[v.doctor.specialty, v.isToday ? 'today' : v.date ? formatDate(v.date) : null, v.time]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {v.nowServing !== null && v.isToday && (
            <p className="mt-1 text-ink-60">
              Now seeing token <strong className="text-ink">{v.nowServing}</strong>
            </p>
          )}
        </div>
      </section>

      {v.status === 'BOOKED' && v.isToday && (
        <section className="space-y-2">
          <p className="text-[14px] text-ink-60">Let the clinic know:</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={
                v.arrivalIntent === 'ON_THE_WAY' ? 'btn-primary !py-3.5' : 'btn-secondary !py-3.5'
              }
              disabled={sending}
              onClick={() => void say('ON_THE_WAY')}
            >
              I&apos;m on my way
            </button>
            <button
              type="button"
              className={
                v.arrivalIntent === 'RUNNING_LATE' ? 'btn-primary !py-3.5' : 'btn-secondary !py-3.5'
              }
              disabled={sending}
              onClick={() => void say('RUNNING_LATE')}
            >
              Running late
            </button>
          </div>
          {v.arrivalIntent && (
            <p className="text-[13.5px] text-green-text">
              Thank you. The front desk can see you are{' '}
              {v.arrivalIntent === 'ON_THE_WAY' ? 'on your way' : 'running late'}.
            </p>
          )}
          {error && <p className="text-[13.5px] text-coral-text">{error}</p>}
        </section>
      )}

      <p className="text-center text-[12.5px] text-ink-40">
        Times are an estimate and can change. This page updates by itself.
      </p>
    </div>
  );
}

// --- recovery -------------------------------------------------------------

function RecoveryCard({
  view,
  linkKey,
  onAnswered,
}: {
  view: RecoveryView;
  linkKey: string;
  onAnswered: (r: RecoveryData) => void;
}) {
  const r = view.recovery;
  const [pain, setPain] = useState<number | null>(null);
  const [exercises, setExercises] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ clinicWillCall: boolean; previous: number | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const dayNumber = Math.max(
    1,
    Math.round((Date.now() - Date.parse(`${r.visitDate}T00:00:00Z`)) / 86400000),
  );

  async function submit() {
    if (pain === null) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/p/${encodeURIComponent(linkKey)}/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          painScore: pain,
          ...(exercises !== null ? { exercisesDone: exercises } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        clinicWillCall?: boolean;
        previousPainScore?: number | null;
        recovery?: RecoveryData;
        error?: { message?: string };
      } | null;
      if (!res.ok || !body?.recovery) {
        setError(body?.error?.message ?? 'That did not go through. Please try again.');
        return;
      }
      setResult({
        clinicWillCall: Boolean(body.clinicWillCall),
        previous: body.previousPainScore ?? null,
      });
      onAnswered(body.recovery);
    } finally {
      setSending(false);
    }
  }

  const done = result !== null || r.answeredToday;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[16px] text-ink-60">Namaste {view.patientFirstName},</p>
        <h1 className="font-display text-[28px] font-bold leading-tight">
          {done ? 'Thank you' : `Day ${dayNumber}: how are you today?`}
        </h1>
        <p className="mt-1 text-[14px] text-ink-60">
          {r.doctor} asked us to check on you
          {r.reviewDate ? ` until your review on ${formatDate(r.reviewDate)}` : ''}.
        </p>
      </div>

      {done ? (
        <section className="card space-y-3 p-5">
          {result?.clinicWillCall ? (
            <>
              <p className="font-display text-[20px] font-bold text-coral-text">
                Someone from the clinic will call you today.
              </p>
              <p className="text-[15px] text-ink-60">
                If the pain is very bad, or you have fever, swelling or numbness, call the clinic or
                go to the nearest emergency.
              </p>
            </>
          ) : (
            <p className="text-[16px]">
              {result && result.previous !== null && pain !== null && pain < result.previous
                ? `Better than last time (${result.previous}). Keep going.`
                : `${r.doctor} will see your answers before your next visit.`}
            </p>
          )}
          {r.reviewDate && (
            <p className="rounded-panel bg-clinical-tint px-3 py-2 text-[14px]">
              Your review: <strong>{formatDate(r.reviewDate)}</strong>
            </p>
          )}
          <PainHistory history={r.history} />
        </section>
      ) : (
        <section className="card space-y-5 p-5">
          <div>
            <p className="text-[16px] font-semibold">How much pain do you have today?</p>
            <p className="text-[13px] text-ink-60">0 = no pain · 10 = the worst pain</p>
            <div
              className="mt-3 grid grid-cols-6 gap-2"
              role="radiogroup"
              aria-label="Pain from 0 to 10"
            >
              {Array.from({ length: 11 }, (_, n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={pain === n}
                  onClick={() => setPain(n)}
                  className={[
                    'h-12 rounded-panel font-display text-[18px] font-bold transition-colors',
                    pain === n
                      ? 'bg-clinical text-white'
                      : n >= 8
                        ? 'bg-coral/8 text-coral-text'
                        : 'bg-bg-soft text-ink',
                  ].join(' ')}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[16px] font-semibold">Did you do your exercises today?</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {[
                { v: true, label: 'Yes' },
                { v: false, label: 'Not today' },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={exercises === o.v}
                  onClick={() => setExercises(o.v)}
                  className={exercises === o.v ? 'btn-primary !py-3' : 'btn-secondary !py-3'}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="note" className="text-[16px] font-semibold">
              Anything to tell the doctor?{' '}
              <span className="font-normal text-ink-40">(optional)</span>
            </label>
            <textarea
              id="note"
              rows={2}
              maxLength={300}
              className="field-input mt-2"
              placeholder="Stairs are still hard in the morning"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {error && <p className="text-[13.5px] text-coral-text">{error}</p>}

          <button
            type="button"
            className="btn-primary w-full !py-3.5 text-[16px]"
            disabled={pain === null || sending}
            onClick={() => void submit()}
          >
            {sending ? 'Sending…' : 'Send to the clinic'}
          </button>
        </section>
      )}

      {(r.advice || r.instructions) && (
        <section className="card-flat p-5 text-[14px]">
          <p className="mono-label">What {r.doctor} asked you to do</p>
          {r.advice && <p className="mt-2 whitespace-pre-wrap">{r.advice}</p>}
          {r.instructions && <p className="mt-2 whitespace-pre-wrap">{r.instructions}</p>}
        </section>
      )}
    </div>
  );
}

function PainHistory({ history }: { history: RecoveryData['history'] }) {
  const scores = history.filter((h) => h.painScore !== null);
  if (scores.length < 2) return null;
  return (
    <div>
      <p className="mono-label">Your pain so far</p>
      <div className="mt-2 flex items-end gap-1.5" aria-label="Pain scores so far">
        {scores.map((h) => (
          <div key={h.date} className="flex flex-1 flex-col items-center gap-1">
            <div
              className={`w-full rounded-t ${(h.painScore ?? 0) >= 8 ? 'bg-coral' : 'bg-clinical/70'}`}
              style={{ height: `${Math.max(6, (h.painScore ?? 0) * 7)}px` }}
            />
            <span className="font-mono text-[11px] text-ink-60">{h.painScore}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Shell({ clinic, children }: { clinic?: Header['clinic']; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-bg px-4 py-5">
      <div className="mx-auto max-w-md space-y-5">
        {clinic && (
          <header className="flex items-center gap-3">
            <ClinicLogo clinic={clinic} size={36} />
            <p className="font-display text-[16px] font-bold">{clinic.name}</p>
          </header>
        )}
        {children}
      </div>
    </main>
  );
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
