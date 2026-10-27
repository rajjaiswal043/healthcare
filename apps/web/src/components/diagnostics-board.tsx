'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  api,
  ApiRequestError,
  type ClinicalDocument,
  type Department,
  type DiagnosticOrder,
} from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { genderInitial } from '@/lib/format';

import { IconAlert, IconCheck, IconCheckCircle, IconReceipt } from '@/components/icons';
import { TestBillingBadge, testIsBlocked } from '@/components/test-billing-badge';
import { DiagnosticReportPrint } from '@/components/diagnostic-report-print';
import { DATE_RE, DayPicker, dayLabel } from '@/components/day-picker';
import { worksOneDepartment } from '@/lib/roles';
/**
 * Age from the order payload alone.
 *
 * `formatAge` wants a birth date, and the order deliberately does not carry one:
 * this list needs just enough to match a request to the person at the machine.
 * Widening the payload to make a shared helper fit would be the wrong way round.
 */
function ageLabel(years: number | null): string {
  return years === null ? '' : `${years}y`;
}

/** Whole minutes since an instant. Negative clocks read as nought. */
function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

/** "12m", "1h 05m" — short enough to sit in a badge. */
function waitLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * One department, as a tab across the top.
 *
 * THE DEPARTMENT IS THE AXIS, not a filter on a list of tests. It is where the
 * work physically happens, and it is the only axis that grows without code: a
 * clinic that adds Physiotherapy under Settings gets a Physiotherapy tab with
 * everybody waiting for it, and nothing here has to know what a physio session
 * is. That is why this stopped being a pill filed to the right of the status
 * and became the first choice on the screen.
 *
 * EVERY ACTIVE DEPARTMENT GETS ONE, including the ones with nothing on them.
 * Tabs that come and go as the day fills would move under the hand of somebody
 * who reaches for the same place every morning — and an empty X-ray at four in
 * the afternoon is itself worth knowing.
 */
function DeptTab({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={on}
      onClick={onClick}
      className={[
        'rounded-pill px-3 py-1.5 text-[13px] font-semibold transition-colors',
        on
          ? 'bg-ink text-white'
          : /* A department with nothing on it stays reachable and stops
               competing for the eye. The tab is still there, still in the same
               place, just quiet. */
            count === 0
            ? 'bg-ink/[0.04] text-ink-40 hover:bg-ink/10 hover:text-ink'
            : 'bg-ink/6 text-ink-60 hover:bg-ink/10 hover:text-ink',
      ].join(' ')}
    >
      {label}
      <span className={`ml-1.5 font-mono tabular-nums ${on ? 'text-white/70' : 'text-ink-40'}`}>
        {count}
      </span>
    </button>
  );
}

/**
 * What is known about this patient's allergies, and whether anybody asked.
 *
 * THE RADIOGRAPHER IS WHO THIS FIELD WAS CAPTURED FOR. Contrast is the one
 * thing a department gives that can hurt somebody on its own, so the answer
 * belongs on the worklist rather than one screen away.
 *
 * Three states, not two, and the difference between the last two is the whole
 * reason the schema has a second column: an allergy recorded, nothing recorded
 * because somebody asked and the answer was none, and nothing recorded because
 * nobody has ever asked. Only the first is a warning; only the third is a
 * question still open.
 */
function AllergyStrip({
  patient,
}: {
  patient: { allergies: string | null; allergiesReviewedAt: string | null };
}) {
  if (patient.allergies) {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 rounded-panel border border-coral/25 bg-coral/8 px-2.5 py-1 text-[12.5px] font-semibold text-coral-text">
        <span className="mt-0.5 shrink-0">
          <IconAlert size={12} />
        </span>
        <span>Allergies: {patient.allergies}</span>
      </p>
    );
  }

  if (patient.allergiesReviewedAt) {
    return <p className="mt-1 text-[12px] text-green-text">No known allergies</p>;
  }

  return (
    <p className="mt-1 text-[12px] text-amber-text">Allergies not recorded. Ask before contrast.</p>
  );
}

/**
 * WHAT COLOUR A PATIENT'S CARD IS, and why there are only three.
 *
 * The same device the patient board uses: the tint answers "what is the state
 * of this one" from across the room, before anybody has read a word of it. The
 * tokens are the same ones too — one theme, and two colour schemes for one
 * idea would be worse than none.
 *
 *   held     coral  — something here is blocked on money. The patient is
 *                     standing there and cannot be done; it is the only state
 *                     somebody has to go and FIX rather than work through.
 *   waiting  amber  — past half an hour, which is when people come to ask.
 *   done     iris   — finished. Never green: green is money in this console,
 *                     and a finished film is not a payment.
 *   plain    white  — waiting, and not long enough to shout about.
 *
 * Ordered worst-first, because a card with one blocked study and one perfectly
 * fine one is a card somebody has to deal with.
 */
function cardTone(tests: DiagnosticOrder[], waitedMinutes: number): string {
  if (tests.some((o) => testIsBlocked(o.billing))) return 'bg-coral/[0.06]';
  if (tests.every((o) => o.status === 'COMPLETED')) return 'bg-iris-soft/50';
  if (tests.some((o) => o.status === 'PENDING') && waitedMinutes >= 30) return 'bg-amber-soft/35';
  return '';
}

/** How often the list refreshes itself, like the queue board. */
const POLL_MS = 20000;

/**
 * The diagnostic department's day.
 *
 * Deliberately shaped like the OPD queue rather than like a settings screen:
 * this is a work list somebody stands at a machine and reads, so the patient and
 * the study are the largest things on it and everything else is small.
 *
 * THIS IS THE HOME PAGE FOR SOMEBODY WHO WORKS A MACHINE. A technician signing
 * in has no use for a list of who is expected at the front desk — their day is
 * the films waiting to be taken — so the console hands them this instead of the
 * patient board. Same chrome, same filters along the top, same day picker: one
 * theme, one set of habits, a different list. See `app/(app)/page.tsx` for the
 * one line that decides which board somebody gets.
 *
 * WHICH DAY LIVES IN THE URL, exactly as it does on the patient board, so the
 * two behave identically and a day can be linked to or reloaded into.
 *
 * What it does not show: a diagnosis, a prescription, a bill. The Diagnostics
 * role can reach a patient's record (docs/09 section 4), but nothing on this
 * screen puts clinical history in front of somebody whose job is the film.
 */
export function DiagnosticsBoard() {
  const { can, session } = useAuth();
  const params = useSearchParams();
  const router = useRouter();

  const [departments, setDepartments] = useState<Department[]>([]);
  /**
   * OPENS ON YOUR OWN ROOM.
   *
   * A technician belongs to a department, so the list they arrive at is the
   * one they work in — and the pills still reach the others, because somebody
   * covering a shift should not need a second login.
   *
   * Initialised from the session rather than set by an effect: an effect would
   * show the whole clinic's worklist for a frame and then snap, which reads as
   * a bug on the screen where a technician is deciding what to do next.
   */
  const [departmentId, setDepartmentId] = useState(session?.department?.id ?? '');
  const [status, setStatus] = useState<'PENDING' | 'COMPLETED' | 'DECLINED'>('PENDING');
  const [orders, setOrders] = useState<DiagnosticOrder[]>([]);
  /** The clinic's own today, as the server reported it. Null until it has. */
  const [serverToday, setServerToday] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  /** The order being worked on, expanded with whatever is attached to it. */
  const [openOrder, setOpenOrder] = useState<
    (DiagnosticOrder & { documents: ClinicalDocument[] }) | null
  >(null);
  const [note, setNote] = useState('');
  /** Who took the report. Its own field — the handover is a separate act. */
  const [handedTo, setHandedTo] = useState('');
  /** Whether the printable sheet is mounted. Only ever true for `openOrder`. */
  const [printing, setPrinting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const mayResult = can('diagnostic:result');

  /**
   * Somebody who works one room, rather than somebody covering the clinic.
   *
   * What it changes: their own department comes first and is already chosen,
   * and the To do / Done / Declined control is not shown at all — their board
   * IS the work waiting for them, and three states to choose between is an
   * administrator's question asked of somebody standing at a machine.
   */
  const ownsOneRoom = worksOneDepartment(session?.roles);

  /**
   * WHICH DAY, read off the URL.
   *
   * The ABSENCE of a date means today, not today's date written out: the live
   * board has to be the plain URL, or a tab left open overnight would quietly
   * keep showing yesterday.
   *
   * THE TO-DO LIST DEFAULTS TO EVERY DAY, which is the one place this differs
   * from the patient board. A film ordered at six last night and not taken is
   * still waiting at nine this morning, and a list that hid it because the
   * calendar had rolled over would lose that patient. Pick a day and you get
   * that day; leave it alone and you get everything still outstanding.
   */
  const dateParam = params.get('date');
  const date = dateParam && DATE_RE.test(dateParam) ? dateParam : null;
  const isToday = date === null;
  const shownDate = date ?? serverToday ?? '';

  /**
   * Put the day in the URL, or take it out.
   *
   * Today is the absence of the parameter rather than today's date, so picking
   * today from the calendar lands on the same URL as the Today button.
   */
  const goToDay = useCallback(
    (to: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (to !== null && to !== serverToday) next.set('date', to);
      else next.delete('date');
      const query = next.toString();
      router.replace(query ? `?${query}` : '?', { scroll: false });
    },
    [params, router, serverToday],
  );

  /**
   * Fetched by STATUS only; the department is a filter in the browser.
   *
   * The department used to be a server filter, which meant the pills could
   * never say how much was waiting anywhere else — the one number a technician
   * arriving at a machine actually wants. A day's worklist is tens of rows, not
   * thousands, so holding it all and filtering here costs nothing and makes
   * switching department instant instead of a round trip.
   */
  const load = useCallback(async () => {
    try {
      const waiting = await api.diagnosticWorklist({
        status,
        ...(date ? { date } : {}),
      });

      /**
       * FINISHED WORK STAYS ON THE BOARD.
       *
       * A patient does not leave the list the moment their film is taken. The
       * card turns iris and stays put, because the twenty minutes after a scan
       * is exactly when somebody asks "is Divya's chest done?" — and a list
       * that answers by having nothing on it is a list that sends them to
       * another screen to find out.
       *
       * SCOPED TO THE DAY, which is the difference from the waiting half.
       * Outstanding work carries over from yesterday because it is still owed;
       * finished work does not, or the board would grow all week and the
       * morning's real queue would sink under it.
       *
       * Only for somebody who works one room. An administrator has the
       * To do / Done / Declined control and is asking a narrower question with
       * it; answering a third thing they did not ask would be noise.
       */
      const finished =
        ownsOneRoom && status === 'PENDING' && (date ?? serverToday)
          ? await api.diagnosticWorklist({
              status: 'COMPLETED',
              date: (date ?? serverToday) as string,
            })
          : { orders: [] };

      setOrders([...waiting.orders, ...finished.orders]);
      setRefreshedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the list.');
    }
  }, [status, date, ownsOneRoom, serverToday]);

  useEffect(() => {
    void (async () => {
      try {
        setDepartments((await api.diagnosticDepartments()).departments);
      } catch {
        // The list still works without the filter.
      }
    })();
  }, []);

  /**
   * The clinic's own today, so the picker does not show the browser's.
   *
   * Asked of the board rather than computed here: a clinic in Pune and a laptop
   * left on UTC disagree about what day it is for five and a half hours every
   * night, and the day picker must agree with the server that files the work.
   */
  useEffect(() => {
    void (async () => {
      try {
        setServerToday((await api.dayBoard()).date);
      } catch {
        // Falls back to the browser's idea of today, which is right all day
        // for anybody in the clinic's own timezone.
        setServerToday(new Date().toISOString().slice(0, 10));
      }
    })();
  }, []);

  useEffect(() => {
    void load();
    // A finished day cannot change, so polling one is a request per twenty
    // seconds that can only ever return the same rows.
    if (!isToday) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, isToday]);

  async function openDetail(id: string) {
    setError(null);
    try {
      const order = await api.diagnosticOrder(id);
      setOpenOrder(order);
      // A sheet armed for the previous order must not follow us to this one.
      setPrinting(false);
      setNote(order.resultNote ?? '');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not open that order.');
    }
  }

  async function attach(file: File) {
    if (!openOrder) return;
    setBusy('attach');
    setError(null);
    try {
      await api.attachResult(openOrder.id, file);
      await openDetail(openOrder.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not attach that file.');
    } finally {
      setBusy(null);
      // Cleared so the same file can be chosen again after a failure.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function complete() {
    if (!openOrder) return;
    setBusy('complete');
    setError(null);
    try {
      await api.completeDiagnosticOrder(openOrder.id, note.trim());
      setOpenOrder(null);
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not mark it done.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Reveal the hidden sheet and print it.
   *
   * The sheet renders from what is already on screen, so there is nothing to
   * fetch — only a paint to wait for before the browser takes its snapshot.
   * The same 60ms the receipt waits, for the same reason.
   */
  function closeDialog() {
    setOpenOrder(null);
    setPrinting(false);
    setHandedTo('');
  }

  async function printReport() {
    setPrinting(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    window.print();
  }

  async function handOver() {
    if (!openOrder) return;
    setBusy('handover');
    setError(null);
    try {
      // Kept open rather than closed: the person at the counter has just
      // handed something over and should see it recorded, not watch the
      // dialog vanish and have to reopen it to check.
      const updated = await api.recordHandover(openOrder.id, handedTo.trim());
      setOpenOrder({ ...openOrder, ...updated });
      setHandedTo('');
      await load();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not record the handover.',
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * Open a file in a new tab.
   *
   * The URL is fetched at click time rather than rendered into the page,
   * because it expires in five minutes — a link put in the HTML would be dead by
   * the time somebody came back from lunch and clicked it.
   */
  async function openDocument(id: string) {
    try {
      const { url } = await api.documentUrl(id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not open that file.');
    }
  }

  const shown = departmentId ? orders.filter((o) => o.department.id === departmentId) : orders;

  /**
   * THE PATIENT IS THE ROW, and their tests are listed inside it.
   *
   * A department calls a person in, not a film. Somebody sent for a knee and a
   * lumbar spine used to appear as two rows with the same name and the same
   * token, and the radiographer had to notice they were one visit — then call
   * them twice, or work it out and not. One card says "this person, these
   * studies", which is what actually happens in the room.
   *
   * ACTIONS STAY PER TEST, because attaching a film and completing an order
   * are per order and always will be: the knee can be done while the spine
   * waits on its bill.
   *
   * Ordered by the OLDEST request in the card, so the longest wait is at the
   * top — a patient who has been there an hour does not drop down the list
   * because a second test was added for them five minutes ago.
   */
  const byPatient = (() => {
    const cards = new Map<
      string,
      { patient: DiagnosticOrder['patient']; tests: DiagnosticOrder[] }
    >();

    for (const o of shown) {
      const card = cards.get(o.patient.id);
      if (card) card.tests.push(o);
      else cards.set(o.patient.id, { patient: o.patient, tests: [o] });
    }

    return [...cards.values()].sort(
      (a, b) =>
        new Date(a.tests[0]!.createdAt).getTime() - new Date(b.tests[0]!.createdAt).getTime(),
    );
  })();

  /**
   * THEIR OWN ROOM FIRST.
   *
   * The tab they want is the one they work in, and a technician should not
   * have to find it among six every morning. Everybody else gets the clinic's
   * own order, which is the order the departments were put in deliberately
   * under Settings and the order every other picker shows them in.
   */
  const ownDepartmentId = session?.department?.id ?? null;
  const tabs = ownDepartmentId
    ? [
        ...departments.filter((d) => d.id === ownDepartmentId),
        ...departments.filter((d) => d.id !== ownDepartmentId),
      ]
    : departments;

  /** The department being looked at, for the heading. Null means all of them. */
  const shownDepartment = departments.find((d) => d.id === departmentId) ?? null;

  /**
   * What each department still has to do.
   *
   * Counts only what is OUTSTANDING, even though finished work is now on the
   * board: the number beside a tab answers "how much is waiting for me", and
   * one that climbed as the day was cleared would be telling the opposite
   * story.
   */
  const countsByDepartment = new Map<string, number>();
  for (const o of orders) {
    if (o.status !== 'PENDING') continue;
    countsByDepartment.set(o.department.id, (countsByDepartment.get(o.department.id) ?? 0) + 1);
  }

  /**
   * The longest anybody on this list has been waiting.
   *
   * Measured from when the test was ORDERED, which is when the clinic started
   * owing them something. Shown only on the to-do list: a wait on a finished
   * test is a number nobody can act on.
   */
  return (
    <div className="space-y-4">
      {/* One line instead of an eyebrow, a 30px heading and a sentence. This is
          a screen somebody stands at a machine and reads: the list is the
          point, and three lines of chrome above it is three lines of worklist
          they cannot see. */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-[24px] font-bold">
            {/* THE ROOM'S OWN NAME. "Tests to do" was the wrong frame: a physio
                session is not a test, and a patient sent for an ECG and a blood
                sample is at two departments rather than on one list. The room
                is what the person reading this stands in. */}
            {shownDepartment?.name ?? 'Every department'}
            {/* Named rather than left implicit: on any other day a heading that
                says nothing about which day is a list somebody will start
                working from by mistake. */}
            {!isToday && shownDate ? ` · ${dayLabel(shownDate)}` : ''}
          </h1>
          {/* Said once, so nobody wonders why yesterday's films are on
              today's list. */}
          <p className="text-[13.5px] text-ink-60">
            {status === 'PENDING' && ownsOneRoom
              ? 'Waiting, and what you have finished today'
              : status === 'PENDING' && isToday
                ? 'Everything still outstanding'
                : status === 'COMPLETED'
                  ? 'Finished work'
                  : status === 'DECLINED'
                    ? 'Turned down by the patient'
                    : ''}
          </p>
        </div>

        <span className="ml-auto">
          <DayPicker
            shownDate={shownDate}
            isToday={isToday}
            onPick={goToDay}
            refreshedAt={refreshedAt}
            onRefresh={() => void load()}
          />
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/*
          WHICH DEPARTMENT — the first choice on the screen.

          Every active one, each carrying its own count, so the question a
          technician asks on arriving ("how much is waiting for me") is answered
          before they touch anything, and the load in the next room is visible
          without going there.
        */}
        <nav className="flex flex-wrap gap-1" aria-label="Department">
          {tabs.map((d) => (
            <DeptTab
              key={d.id}
              label={d.name}
              count={countsByDepartment.get(d.id) ?? 0}
              on={departmentId === d.id}
              onClick={() => setDepartmentId(d.id)}
            />
          ))}
          {/* Last rather than first, and only where it is useful: an
              administrator covering the whole clinic wants one list, and a
              technician who works one room never needs this. */}
          {departments.length > 1 && (
            <DeptTab
              label="All"
              count={orders.filter((o) => o.status === 'PENDING').length}
              on={departmentId === ''}
              onClick={() => setDepartmentId('')}
            />
          )}
        </nav>

        {/*
          To do / Done / Declined — FOR WHOEVER COVERS MORE THAN ONE ROOM.

          Not shown to somebody who works a single department: their board is
          the work waiting for them, and asking them which of three states they
          would like is an administrator's question. An administrator keeps it,
          because "Done" is how a finished result is found again and "Declined"
          answers "what happened to the X-ray I was expecting" — and the
          clinic has one screen for both, so what differs is what is shown, not
          what exists.

          Note the consequence, which is deliberate: a technician cannot reach
          their completed work from this board. If that turns out to bite, the
          fix is to put the control back for them rather than to give them a
          different screen.
        */}
        {!ownsOneRoom && (
          <nav className="ml-auto flex flex-wrap gap-1" aria-label="Which work">
            {(
              [
                ['PENDING', 'To do'],
                ['COMPLETED', 'Done'],
                ['DECLINED', 'Declined'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-current={status === key}
                onClick={() => setStatus(key)}
                className={[
                  'rounded-pill border-[1.5px] px-2.5 py-1 text-[12.5px] font-semibold transition-colors',
                  status === key
                    ? 'border-clinical bg-clinical-tint text-clinical-text'
                    : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25 hover:text-ink',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3.5 py-2.5 text-[13px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={14} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {byPatient.length === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="font-display text-[18px] font-bold">
            {status === 'PENDING'
              ? 'Nobody waiting'
              : status === 'COMPLETED'
                ? 'Nothing done yet'
                : 'Nothing declined'}
          </p>
          <p className="mt-1 text-[13.5px] text-ink-40">
            {status === 'PENDING'
              ? `Patients appear here as doctors send them to ${
                  shownDepartment?.name ?? 'a department'
                }.`
              : 'Finished work will be listed here.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {byPatient.map(({ patient, tests }) => {
            /* The clock runs from the FIRST thing they were sent for. A second
               test added later does not reset how long they have been sitting
               there. */
            const waited = minutesSince(tests[0]!.createdAt);
            const token = tests[0]!.appointment?.tokenNumber ?? null;
            const tone = cardTone(tests, waited);

            return (
              <li key={patient.id} className={`card overflow-hidden ${tone}`}>
                {/* --- who is waiting ----------------------------------- */}
                <div className="flex flex-wrap items-start gap-4 px-5 py-4">
                  {/*
                    THE TOKEN, in the largest type on the card.

                    It is how the patient is called, and the number they are
                    holding — a department that shouts a name across a waiting
                    room is a department mispronouncing it. A walk-in test joins
                    no queue and has no token, which is said rather than left
                    blank.
                  */}
                  <div className="shrink-0">
                    {token === null ? (
                      <span className="flex h-[52px] w-[52px] items-center justify-center rounded-panel border border-dashed border-ink/20 text-center text-[10.5px] font-semibold uppercase leading-tight tracking-wide text-ink-40">
                        walk
                        <br />
                        in
                      </span>
                    ) : (
                      <span className="flex h-[52px] w-[52px] flex-col items-center justify-center rounded-panel bg-ink text-white">
                        <span className="font-mono text-[21px] font-bold leading-none tabular-nums">
                          {token}
                        </span>
                        <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-white/60">
                          token
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* The person first. The studies are underneath, because a
                        department calls a patient in and then does whatever is
                        on their list. */}
                    <p className="font-display text-[17px] font-bold leading-tight">
                      {patient.name}
                    </p>

                    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                      <span className="text-ink-40">
                        {ageLabel(patient.ageYears)} {genderInitial(patient.gender)}
                      </span>
                      <span className="font-mono text-[12px] text-ink-40">{patient.uhid}</span>
                      {/* The fix for a patient who wandered off between paying
                          and being called is a phone call, not a search of the
                          corridor. */}
                      <span className="font-mono text-[12px] text-ink-40">{patient.mobile}</span>
                      {tests[0]!.appointment?.reasonForVisit && (
                        <>
                          <span aria-hidden="true" className="h-1 w-1 rounded-full bg-ink/20" />
                          {/* Why they came, in the doctor's own words. "X-ray —
                              left wrist" plus "fell off a scooter" is a
                              different instruction from the first alone. */}
                          <span className="text-ink-60">
                            {tests[0]!.appointment.reasonForVisit}
                          </span>
                        </>
                      )}
                    </p>

                    <AllergyStrip patient={patient} />
                  </div>

                  {/* How long they have been waiting. Amber past half an
                      hour, which is when somebody usually comes to ask. Gone
                      once everything on the card is done: a wait on finished
                      work is a number nobody can act on. */}
                  {tests.some((o) => o.status === 'PENDING') && (
                    <span
                      className={`badge shrink-0 ${waited >= 30 ? 'badge-amber' : 'badge-neutral'}`}
                      title={`Sent at ${new Date(tests[0]!.createdAt).toLocaleTimeString('en-IN', {
                        timeStyle: 'short',
                      })}`}
                    >
                      {waitLabel(waited)}
                    </span>
                  )}
                </div>

                {/* --- what they are here for --------------------------- */}
                <ul className="divide-y divide-ink/8 border-t border-ink/8">
                  {tests.map((o, i) => (
                    <li
                      key={o.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-white/55 px-5 py-3"
                    >
                      {/* Numbered only when there is more than one, because
                          "1." above a single study is a list of one pretending
                          to be a list. Two films on one person is exactly when
                          the radiographer needs to count them off. */}
                      {tests.length > 1 && (
                        <span className="mono-label w-4 shrink-0 !text-ink-20">{i + 1}</span>
                      )}

                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-semibold leading-snug text-ink">
                          {o.description}
                        </p>
                        <p className="mt-0.5 text-[12px] text-ink-40">
                          {/* Which room, only where it is not already the
                              heading — on All, one card can span two. */}
                          {departmentId === '' && (
                            <span className="font-semibold text-ink-60">
                              {o.department.name} ·{' '}
                            </span>
                          )}
                          Asked by {o.orderedBy.fullName} at{' '}
                          {new Date(o.createdAt).toLocaleTimeString('en-IN', {
                            timeStyle: 'short',
                          })}
                          {o.referralSource === 'EXTERNAL_DOCTOR' && o.referrerName && (
                            <span> · referred by {o.referrerName}</span>
                          )}
                        </p>

                        {/* The reading, once there is one. The commonest thing
                            anybody wants from the Done list is what it said. */}
                        {o.resultNote && (
                          <p className="mt-1 text-[12.5px] text-ink-60">{o.resultNote}</p>
                        )}
                      </div>

                      <span className="flex flex-wrap items-center justify-end gap-1.5">
                        {/* Decision (c): the row stays visible. A patient
                            standing at the counter must not disappear from the
                            list because their bill is open — what is withheld
                            is the result, not the fact of the request. */}
                        <TestBillingBadge billing={o.billing} />

                        {o._count.documents > 0 && (
                          <span className="badge-clinical">
                            {o._count.documents} {o._count.documents === 1 ? 'file' : 'files'}
                          </span>
                        )}

                        {o.status === 'COMPLETED' && (
                          <span className="badge-green">
                            <IconCheck size={11} /> done
                          </span>
                        )}

                        {/* Its own words. "Cancelled" would say the clinician
                            called it off; this says the request stood and the
                            patient said no. */}
                        {o.status === 'DECLINED' && (
                          <span className="badge-neutral">declined by patient</span>
                        )}

                        {/* Which reports are still sitting on the counter. The
                            Done tab otherwise looks finished while a stack of
                            films waits to be collected — and an uncollected
                            film is the complaint. */}
                        {o.status === 'COMPLETED' &&
                          (o.handedOverAt ? (
                            <span className="badge-neutral">given out</span>
                          ) : (
                            <span className="badge-amber">not collected</span>
                          ))}
                      </span>

                      {/* PER TEST, because attaching a film and completing an
                          order are per order: the knee can be finished while
                          the spine waits on its bill. */}
                      <button
                        type="button"
                        // Thumb height on a phone; unchanged under a mouse.
                        className="btn-secondary shrink-0 !py-2 !text-[13px] md:!py-1.5"
                        onClick={() => void openDetail(o.id)}
                      >
                        {o.status === 'PENDING' && mayResult ? 'Attach result' : 'Open'}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      {refreshedAt && (
        <p className="mono-label">
          Updated {refreshedAt.toLocaleTimeString('en-IN', { timeStyle: 'short' })}
        </p>
      )}

      {printing && openOrder && (
        <DiagnosticReportPrint order={openOrder} documents={openOrder.documents} />
      )}

      {/* --- the one order being worked on ---------------------------------- */}
      {openOrder && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={openOrder.description}
          className="fixed inset-0 z-[60] !m-0 grid place-items-center bg-ink/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
          }}
        >
          <div className="card max-h-[85vh] w-full max-w-lg overflow-y-auto p-6">
            <p className="mono-label">{openOrder.department.name}</p>
            <h2 className="mt-1 font-display text-[21px] font-bold">{openOrder.description}</h2>
            <p className="mt-1 text-[13.5px] text-ink-60">
              {openOrder.patient.name} · {ageLabel(openOrder.patient.ageYears)}{' '}
              {genderInitial(openOrder.patient.gender)} ·{' '}
              <span className="font-mono text-[12px]">{openOrder.patient.uhid}</span>
            </p>

            <div className="mt-5">
              <p className="field-label">Attached</p>
              {openOrder.documents.length === 0 ? (
                <p className="text-[13px] text-ink-40">Nothing yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {openOrder.documents.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-[13.5px]">
                        {d.fileName}
                        <span className="ml-2 text-[12px] text-ink-40">
                          {Math.max(1, Math.round(d.sizeBytes / 1024))} KB
                        </span>
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-[12.5px] font-semibold text-clinical-text underline underline-offset-2"
                        onClick={() => void openDocument(d.id)}
                      >
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {openOrder.status === 'PENDING' && mayResult ? (
              <>
                {testIsBlocked(openOrder.billing) && (
                  <div
                    role="alert"
                    className="mt-4 flex items-start gap-2 rounded-panel border border-coral/30 bg-coral/8 p-3 text-[13px] text-coral-text"
                  >
                    <span className="mt-0.5 shrink-0">
                      <IconAlert size={13} />
                    </span>
                    <span>
                      {openOrder.billing.status === 'VOID' ? (
                        <>
                          The bill for this test was cancelled. Send the patient to the finance desk
                          to have the charge raised again.
                        </>
                      ) : (
                        <>
                          This test has not been paid for. Send the patient to the finance desk. The
                          result cannot go out until the bill is cleared.
                        </>
                      )}
                    </span>
                  </div>
                )}

                <div className="mt-4">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy !== null || testIsBlocked(openOrder.billing)}
                    onClick={() => fileInput.current?.click()}
                  >
                    {busy === 'attach' ? 'Uploading…' : 'Add a file'}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/tiff,application/pdf"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void attach(file);
                    }}
                  />
                  <p className="field-hint">PDF or image, up to 25MB.</p>
                </div>

                <div className="mt-4">
                  <label htmlFor="resultNote" className="field-label">
                    Report
                  </label>
                  <textarea
                    id="resultNote"
                    rows={4}
                    maxLength={2000}
                    className="field-input text-[16px] md:text-[13.5px]"
                    placeholder="No fracture. Mild effusion."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  {/* Said plainly, because the server refuses it and a silent
                      400 at this point is infuriating. */}
                  <p className="field-hint">
                    Attach a file or write a report. An order cannot be marked done with neither.
                  </p>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={
                      busy !== null ||
                      testIsBlocked(openOrder.billing) ||
                      (note.trim() === '' && openOrder.documents.length === 0)
                    }
                    onClick={() => void complete()}
                  >
                    <IconCheckCircle size={15} />
                    {/*
                      THE ROOM'S OWN NAME, the same rule as the doctor's "OPD
                      done". "Mark done" said nothing about what was being
                      signed off, which matters most to somebody covering a
                      shift in a department that is not theirs: the button
                      names the room they are about to sign off.
                    */}
                    {busy === 'complete' ? 'Saving…' : `${openOrder.department.name} done`}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={closeDialog}
                    disabled={busy !== null}
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                {openOrder.resultNote && (
                  <div className="mt-4">
                    <p className="field-label">Report</p>
                    <p className="whitespace-pre-wrap text-[13.5px]">{openOrder.resultNote}</p>
                  </div>
                )}
                {openOrder.completedBy && (
                  <p className="mt-3 text-[12.5px] text-ink-40">
                    Completed by {openOrder.completedBy.fullName}
                  </p>
                )}

                {/* FR-DIA-13. A walk-in patient leaves with a sheet of paper,
                    and "I paid and never got my film" has no answer unless
                    somebody wrote down who took it. */}
                {openOrder.status === 'COMPLETED' &&
                  mayResult &&
                  (openOrder.handedOverAt ? (
                    <p className="mt-3 rounded-panel border border-green/30 bg-green-soft/40 px-3 py-2 text-[12.5px]">
                      Given to <strong>{openOrder.handedOverTo}</strong> on{' '}
                      {new Date(openOrder.handedOverAt).toLocaleString('en-IN', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                      {openOrder.handedOverBy && <> · {openOrder.handedOverBy.fullName}</>}
                    </p>
                  ) : (
                    <div className="mt-4">
                      <label htmlFor="handedOverTo" className="field-label">
                        Report handed to
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <input
                          id="handedOverTo"
                          className="field-input !py-2 max-w-[260px]"
                          value={handedTo}
                          onChange={(e) => setHandedTo(e.target.value)}
                          placeholder="The patient"
                          maxLength={160}
                        />
                        <button
                          type="button"
                          className="btn-secondary !py-2"
                          disabled={busy !== null || handedTo.trim().length < 2}
                          onClick={() => void handOver()}
                        >
                          {busy === 'handover' ? 'Saving…' : 'Record handover'}
                        </button>
                      </div>
                      <p className="field-hint">
                        Recorded once. Name whoever physically took it: the patient, or the relative
                        who collected it.
                      </p>
                    </div>
                  ))}

                <div className="mt-5 flex flex-wrap gap-2">
                  {/* The document the patient takes away. Only once there is
                      something to report — printing a blank sheet is worse
                      than the button being absent. */}
                  {openOrder.status === 'COMPLETED' && (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void printReport()}
                    >
                      <IconReceipt size={15} />
                      Print report
                    </button>
                  )}
                  <button type="button" className="btn-secondary" onClick={closeDialog}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
