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
  next: Array<number | null>;
  waiting: number;
  minutesSinceLastCall: number | null;
}

interface DisplayBoard {
  clinic: string;
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
      <main className="grid min-h-screen place-items-center bg-[#0d1b1a] p-10 text-center text-white">
        <div>
          <p className="text-[24px] font-semibold text-white/70">This screen is not paired</p>
          <p className="mt-3 text-[17px] text-white/40">
            Ask the front desk to set it up again from Settings → Waiting-room screens.
          </p>
        </div>
      </main>
    );
  }

  if (!board) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0d1b1a] text-white">
        <p className="text-[22px] text-white/50">Connecting…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0d1b1a] px-[3vw] py-[3vh] text-white">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-[2vh]">
        <div className="flex items-center gap-[1.6vw]">
          {/* On a white chip rather than bare on the dark ground.
              A JPEG carries no transparency, so its own background paints as a
              hard rectangle against this screen whatever colour it is; a
              deliberate white panel makes that read as a badge instead of an
              artefact, and it works for a dark logo, a light one and a colour
              one without anybody having to prepare the file. Inverting would
              have been fine for a monochrome mark and ruinous for this one. */}
          <span className="grid shrink-0 place-items-center rounded-[0.8vw] bg-white p-[0.5vw]">
            <ClinicLogo size={56} />
          </span>

          <div>
            <h1 className="font-display text-[clamp(28px,3.2vw,52px)] font-bold leading-none">
              {board.clinic}
            </h1>
            {board.location && (
              <p className="mt-2 text-[clamp(14px,1.2vw,22px)] text-white/45">{board.location}</p>
            )}
          </div>
        </div>

        {/* The screen says when it last heard from the clinic, and only when that
            stops being "just now". Silence is the failure mode being designed
            against. */}
        {stale && (
          <p className="rounded-full bg-amber-400/15 px-5 py-2 text-[clamp(13px,1.1vw,19px)] font-semibold text-amber-200">
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
        <p className="mt-[10vh] text-center text-[clamp(18px,2vw,32px)] text-white/40">
          No clinics running right now.
        </p>
      )}
    </main>
  );
}

function DoctorCard({ doctor: d }: { doctor: DisplayDoctor }) {
  const late = d.minutesSinceLastCall !== null && d.minutesSinceLastCall >= LATE_MINUTES;

  return (
    <section className="rounded-[1.5vw] border border-white/10 bg-white/[0.04] p-[2vw]">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[clamp(18px,1.7vw,30px)] font-bold">{d.name}</h2>
        {d.specialty && (
          <span className="text-[clamp(12px,1vw,17px)] text-white/40">{d.specialty}</span>
        )}
      </div>

      <p className="mt-[2vh] text-[clamp(11px,0.85vw,15px)] font-semibold uppercase tracking-[0.18em] text-white/35">
        Now serving
      </p>

      {/* The one number the room is looking at. Everything else on this screen is
          arranged around keeping it the biggest thing on it. */}
      <p
        className={[
          'font-mono font-bold leading-[0.9]',
          d.nowServing === null
            ? 'text-[clamp(48px,6vw,110px)] text-white/20'
            : 'text-[clamp(72px,10vw,190px)] text-[#5fe0c8]',
        ].join(' ')}
      >
        {d.nowServing ?? '—'}
      </p>

      {late && (
        <p className="mt-[1vh] text-[clamp(12px,1vw,18px)] text-amber-200/80">
          Running late — last called {d.minutesSinceLastCall} minutes ago
        </p>
      )}

      <div className="mt-[2vh] border-t border-white/10 pt-[2vh]">
        <p className="text-[clamp(11px,0.85vw,15px)] font-semibold uppercase tracking-[0.18em] text-white/35">
          Next
        </p>
        {d.next.length === 0 ? (
          <p className="mt-2 text-[clamp(16px,1.4vw,26px)] text-white/30">Nobody waiting</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-[1vw]">
            {d.next.map((token, i) => (
              <span
                key={`${token}-${i}`}
                className="rounded-[0.6vw] bg-white/8 px-[1.4vw] py-[0.6vh] font-mono text-[clamp(24px,3vw,56px)] font-bold text-white/85"
              >
                {token ?? '—'}
              </span>
            ))}
            {d.waiting > d.next.length && (
              <span className="self-end pb-[0.8vh] text-[clamp(13px,1.1vw,20px)] text-white/35">
                +{d.waiting - d.next.length} more
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
