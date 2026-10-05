'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { ClinicLogo } from '@/components/clinic-logo';

/**
 * The waiting-room screen.
 *
 * Runs unattended on a television all day, so it is built around the two things
 * that actually go wrong in a clinic: the network drops, and nobody notices.
 * A board that silently keeps painting five-minute-old numbers is worse than one
 * that admits it — patients act on what they read here.
 *
 * It shows TOKENS AND DOCTORS. Never a patient name: this screen faces a room
 * full of strangers, and the API will not send one.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';

/** How often the screen asks. Five seconds is well inside a patient's patience. */
const POLL_MS = 5000;

/** After this long without a successful poll, say so rather than keep pretending. */
const STALE_MS = 30000;

/** A doctor who has not called anyone in this long is running late, and the room can tell. */
const LATE_MINUTES = 20;

interface DisplayDoctor {
  name: string;
  specialty: string | null;
  nowServing: number | null;
  /**
   * Already shortened by the API to "Kavita S." — the surname never reaches
   * this screen. Do not try to expand it; there is nothing here to expand.
   */
  nowServingName: string | null;
  next: Array<{ token: number | null; name: string }>;
  waiting: number;
  minutesSinceLastCall: number | null;
  /** For somebody arriving now. Null when nobody is ahead. docs/10. */
  estimatedWaitMinutes?: number | null;
  /** Booked today and not here yet — waiting from home. A count, never names. */
  atHome?: number;
  onTheWay?: number;
}

interface DisplayBoard {
  clinic: string;
  clinicSlug: string;
  clinicLogoVersion: string | null;
  location: string | null;
  generatedAt: string;
  doctors: DisplayDoctor[];
}

export default function DisplayPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);

  const [board, setBoard] = useState<DisplayBoard | null>(null);
  const [refused, setRefused] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Kept out of state: it changes on every poll and nothing renders from it.
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`${API_BASE}/display/${encodeURIComponent(key)}`, {
        cache: 'no-store',
      });

      if (res.status === 401 || res.status === 404) {
        setRefused(true);
        return;
      }
      if (!res.ok) return;

      setBoard((await res.json()) as DisplayBoard);
      setLastOkAt(Date.now());
      setRefused(false);
    } catch {
      // Network down. Leave the last good board on screen and let the staleness
      // banner appear — a blank screen tells a waiting room nothing at all.
    } finally {
      inFlight.current = false;
    }
  }, [key]);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // A second, slower tick so the staleness banner appears even while polls are
  // failing — the poll itself cannot re-render the page when it never resolves.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const stale = lastOkAt !== null && now - lastOkAt > STALE_MS;

  if (refused) {
    return (
      <main className="grid min-h-screen place-items-center bg-bg p-10 text-center">
        <div className="card max-w-lg p-8">
          <p className="eyebrow justify-center">Waiting room</p>
          <p className="mt-3 font-display text-[26px] font-bold">This screen is not paired</p>
          <p className="mt-2 text-[16px] text-ink-60">
            Ask the front desk to set it up again from Settings → Waiting-room screens.
          </p>
        </div>
      </main>
    );
  }

  if (!board) {
    return (
      <main className="grid min-h-screen place-items-center bg-bg">
        <p className="text-[22px] text-ink-40">Connecting…</p>
      </main>
    );
  }

  return (
    /**
     * The clinic's own paper, at four metres.
     *
     * This used to be a dark board on the argument that a wall-mounted screen
     * wants maximum contrast. It read as a different product — Narveer's point,
     * and the right one: a patient looking up from the bench and a receptionist
     * looking at the queue should recognise the same clinic. So it uses the same
     * tokens as every other screen, and buys its legibility from SIZE instead:
     * the served token is the biggest thing in the room, and everything else is
     * deliberately quiet around it.
     */
    <main className="flex min-h-screen flex-col bg-bg px-[3vw] pt-[3vh]">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-ink/10 pb-[2vh]">
        <div className="flex items-center gap-[1.6vw]">
          {/* No white chip needed now: the logo's own background and the card
              behind it are the same white, so a JPEG with no transparency sits
              flush instead of reading as a pasted rectangle. */}
          <span className="grid shrink-0 place-items-center rounded-panel border border-ink/8 bg-card p-[0.6vw] shadow-sm">
            <ClinicLogo
              clinic={{ slug: board.clinicSlug, logoVersion: board.clinicLogoVersion }}
              size={56}
            />
          </span>

          <div>
            <p className="eyebrow">Now serving</p>
            <h1 className="mt-1 font-display text-[clamp(28px,3.2vw,52px)] font-bold leading-none tracking-display">
              {board.clinic}
            </h1>
            {board.location && (
              <p className="mt-2 text-[clamp(14px,1.2vw,22px)] text-ink-40">{board.location}</p>
            )}
          </div>
        </div>

        {/* The screen says when it last heard from the clinic, and only when that
            stops being "just now". Silence is the failure mode being designed
            against. Amber here is the same amber that means "needs attention"
            everywhere else in the product. */}
        {stale && (
          <p className="rounded-pill bg-amber-soft px-5 py-2 text-[clamp(13px,1.1vw,19px)] font-semibold text-amber-text">
            Reconnecting — showing the board from{' '}
            {new Date(board.generatedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}
          </p>
        )}
      </header>

      <div
        className={[
          'mt-[3vh] grid gap-[2vw]',
          board.doctors.length === 1
            ? 'grid-cols-1'
            : board.doctors.length === 2
              ? 'grid-cols-1 lg:grid-cols-2'
              : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
        ].join(' ')}
      >
        {board.doctors.map((d) => (
          <DoctorCard key={d.name} doctor={d} />
        ))}
      </div>

      {board.doctors.length === 0 && (
        <p className="mt-[10vh] text-center text-[clamp(18px,2vw,32px)] text-ink-40">
          No clinics running right now.
        </p>
      )}

      {/* A thank-you, in English and Hindi, at the foot of the screen a room
          stares at all morning. The one line on this board that is not
          information, and on purpose. */}
      <footer className="sticky bottom-0 -mx-[3vw] mt-auto bg-amber px-[3vw] py-[2.2vh] text-center text-ink">
        <p className="font-display text-[clamp(18px,1.8vw,32px)] font-bold">
          Thank you for your patience
          {homeCount(board.doctors) > 0 &&
            ` · ${homeCount(board.doctors)} more ${homeCount(board.doctors) === 1 ? 'patient is' : 'patients are'} waiting from home`}
        </p>
        <p lang="hi" className="mt-[0.4vh] text-[clamp(15px,1.4vw,26px)] font-semibold">
          आपके धैर्य के लिए धन्यवाद
        </p>
      </footer>
    </main>
  );
}

function DoctorCard({ doctor: d }: { doctor: DisplayDoctor }) {
  const late = d.minutesSinceLastCall !== null && d.minutesSinceLastCall >= LATE_MINUTES;

  return (
    <section className="card overflow-hidden">
      {/* The doctor's name sits on the same soft header strip every panel in the
          console uses, so a patient and a receptionist are looking at one thing
          drawn one way. */}
      <header className="flex items-center gap-[1vw] border-b border-ink/8 bg-bg-soft px-[2vw] py-[1.6vh]">
        {/* A face for the name. Initials until doctors can upload a photo
            (docs/10 section 3) — patients relax when they can see who they are
            waiting for, and a coloured disc with "AM" is a start. */}
        <span
          aria-hidden="true"
          className="grid h-[clamp(40px,3.6vw,68px)] w-[clamp(40px,3.6vw,68px)] shrink-0 place-items-center rounded-full bg-clinical font-display text-[clamp(15px,1.4vw,26px)] font-bold text-white"
        >
          {doctorInitials(d.name)}
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-display text-[clamp(18px,1.7vw,30px)] font-bold tracking-display">
            {d.name}
          </h2>
          {d.specialty && <p className="text-[clamp(12px,1vw,17px)] text-ink-40">{d.specialty}</p>}
        </div>
      </header>

      <div className="px-[2vw] py-[2vh]">
        <p className="mono-label">Now serving</p>

        {/* The one number the room is looking at, and the whole reason this
            screen can be light: it wins on size, not on contrast tricks. */}
        <p
          className={[
            'font-mono font-bold leading-[0.9]',
            d.nowServing === null
              ? 'text-[clamp(48px,6vw,110px)] text-ink-20'
              : 'text-[clamp(72px,10vw,190px)] text-clinical',
          ].join(' ')}
        >
          {d.nowServing ?? '—'}
        </p>

        {/* Under the number, not beside it. The token is what the room scans
            for; the name is the confirmation once a number has caught somebody's
            eye, so it must not compete with it for size. */}
        {d.nowServingName && (
          <p className="mt-[0.5vh] text-[clamp(20px,2.2vw,42px)] font-semibold leading-tight text-ink">
            {d.nowServingName}
          </p>
        )}

        {late && (
          <p className="mt-[1vh] inline-flex rounded-pill bg-amber-soft px-3 py-1 text-[clamp(12px,1vw,18px)] font-semibold text-amber-text">
            Running late — last called {d.minutesSinceLastCall} minutes ago
          </p>
        )}

        <div className="mt-[2vh] border-t border-ink/8 pt-[2vh]">
          <p className="mono-label">Next</p>

          {d.next.length === 0 ? (
            <p className="mt-2 text-[clamp(16px,1.4vw,26px)] text-ink-20">Nobody waiting</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-end gap-[1vw]">
              {d.next.map((entry, i) => (
                <span
                  key={`${entry.token}-${i}`}
                  className="rounded-panel bg-clinical-soft px-[1.4vw] py-[0.6vh] text-center"
                >
                  <span className="block font-mono text-[clamp(24px,3vw,56px)] font-bold leading-none text-clinical-text">
                    {entry.token ?? '—'}
                  </span>
                  {entry.name && (
                    <span className="mt-[0.4vh] block text-[clamp(11px,1vw,18px)] font-semibold text-clinical-text/70">
                      {entry.name}
                    </span>
                  )}
                </span>
              ))}
              {d.waiting > d.next.length && (
                <span className="pb-[0.8vh] text-[clamp(13px,1.1vw,20px)] text-ink-40">
                  +{d.waiting - d.next.length} more
                </span>
              )}
            </div>
          )}
        </div>

        {(d.estimatedWaitMinutes != null || (d.atHome ?? 0) > 0) && (
          <div className="mt-[2vh] flex flex-wrap gap-x-[2vw] gap-y-1 border-t border-ink/8 pt-[1.6vh] text-[clamp(13px,1.1vw,20px)]">
            {d.estimatedWaitMinutes != null && (
              <p>
                <span className="text-ink-40">Wait if you arrive now: </span>
                <strong className="font-semibold text-amber-text">
                  about {d.estimatedWaitMinutes} min
                </strong>
              </p>
            )}
            {(d.atHome ?? 0) > 0 && (
              <p className="text-ink-40">
                {d.atHome} waiting from home
                {(d.onTheWay ?? 0) > 0 ? `, ${d.onTheWay} on the way` : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** "Dr Anjali Mehta" → "AM". The honorific is not part of anyone's face. */
function doctorInitials(name: string): string {
  const words = name
    .replace(/^(dr|prof)\.?\s+/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '·';
}

function homeCount(doctors: DisplayDoctor[]): number {
  return doctors.reduce((sum, d) => sum + (d.atHome ?? 0), 0);
}
