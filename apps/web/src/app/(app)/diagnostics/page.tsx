'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiRequestError,
  type ClinicalDocument,
  type Department,
  type DiagnosticOrder,
} from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { genderInitial } from '@/lib/format';

import {
  IconAlert,
  IconCheck,
  IconCheckCircle,
  IconReceipt,
  IconRefresh,
} from '@/components/icons';
import { TestBillingBadge, testIsBlocked } from '@/components/test-billing-badge';
import { DiagnosticReportPrint } from '@/components/diagnostic-report-print';
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
 * A department filter that also says how much is on it.
 *
 * The count is of everything with the current status, not of what is on screen
 * — the point is to see the other department's load without going there.
 */
function DeptPill({
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
      aria-pressed={on}
      onClick={onClick}
      className={[
        'rounded-pill border-[1.5px] px-2.5 py-1 text-[12.5px] font-semibold transition-colors',
        on
          ? 'border-clinical bg-clinical-tint text-clinical-text'
          : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25 hover:text-ink',
      ].join(' ')}
    >
      {label}
      <span className={`ml-1.5 font-mono tabular-nums ${on ? '' : 'text-ink-40'}`}>{count}</span>
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
    <p className="mt-1 text-[12px] text-amber-text">Allergies not recorded — ask before contrast</p>
  );
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
 * What it does not show: a diagnosis, a prescription, a bill. The Diagnostics
 * role can reach a patient's record (docs/09 section 4), but nothing on this
 * screen puts clinical history in front of somebody whose job is the film.
 */
export default function DiagnosticsPage() {
  const { can } = useAuth();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState<'PENDING' | 'COMPLETED' | 'DECLINED'>('PENDING');
  const [orders, setOrders] = useState<DiagnosticOrder[]>([]);
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
      const { orders } = await api.diagnosticWorklist({ status });
      setOrders(orders);
      setRefreshedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the list.');
    }
  }, [status]);

  useEffect(() => {
    void (async () => {
      try {
        setDepartments((await api.diagnosticDepartments()).departments);
      } catch {
        // The list still works without the filter.
      }
    })();
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

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

  const countsByDepartment = new Map<string, number>();
  for (const o of orders) {
    countsByDepartment.set(o.department.id, (countsByDepartment.get(o.department.id) ?? 0) + 1);
  }

  /**
   * The longest anybody on this list has been waiting.
   *
   * Measured from when the test was ORDERED, which is when the clinic started
   * owing them something. Shown only on the to-do list: a wait on a finished
   * test is a number nobody can act on.
   */
  const longestWait = shown.reduce<number | null>((longest, o) => {
    const mins = minutesSince(o.createdAt);
    return longest === null || mins > longest ? mins : longest;
  }, null);

  return (
    <div className="space-y-4">
      {/* One line instead of an eyebrow, a 30px heading and a sentence. This is
          a screen somebody stands at a machine and reads: the list is the
          point, and three lines of chrome above it is three lines of worklist
          they cannot see. */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-[24px] font-bold">
            {status === 'PENDING'
              ? 'Tests to do'
              : status === 'COMPLETED'
                ? 'Completed'
                : 'Declined by the patient'}
          </h1>
          <p className="text-[13.5px] text-ink-60">
            {shown.length === 0
              ? 'Nothing on this list'
              : `${shown.length} ${shown.length === 1 ? 'test' : 'tests'}`}
            {status === 'PENDING' && longestWait !== null && (
              <span className={longestWait >= 30 ? 'font-semibold text-amber-text' : ''}>
                {' · longest wait '}
                {waitLabel(longestWait)}
              </span>
            )}
          </p>
        </div>

        <button
          type="button"
          className="btn-ghost !py-1.5 !text-[12.5px]"
          onClick={() => void load()}
        >
          <IconRefresh size={14} />
          {refreshedAt
            ? `Updated ${refreshedAt.toLocaleTimeString('en-IN', { timeStyle: 'short' })}`
            : 'Refresh'}
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {/* To do / Done / Declined as tabs. A dropdown hid two of the three
            behind a click, and "what happened to the X-ray I was expecting" is
            asked often enough to deserve being visible. */}
        <nav className="flex flex-wrap gap-1" aria-label="Which tests">
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
                'rounded-pill px-3 py-1.5 text-[13px] font-semibold transition-colors',
                status === key
                  ? 'bg-ink text-white'
                  : 'bg-ink/6 text-ink-60 hover:bg-ink/10 hover:text-ink',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </nav>

        {/*
          Departments as pills, each carrying its own count.

          The question a technician asks on arriving is "how much is waiting for
          me", and a dropdown answered it only after two clicks and a reload —
          while never showing the other department's load at all.
        */}
        {departments.length > 1 && (
          <nav className="ml-auto flex flex-wrap gap-1" aria-label="Department">
            <DeptPill
              label="All"
              count={orders.length}
              on={departmentId === ''}
              onClick={() => setDepartmentId('')}
            />
            {departments.map((d) => (
              <DeptPill
                key={d.id}
                label={d.name}
                count={countsByDepartment.get(d.id) ?? 0}
                on={departmentId === d.id}
                onClick={() => setDepartmentId(d.id)}
              />
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

      {shown.length === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="font-display text-[18px] font-bold">
            {status === 'PENDING'
              ? 'Nothing waiting'
              : status === 'COMPLETED'
                ? 'Nothing done yet'
                : 'Nothing declined'}
          </p>
          <p className="mt-1 text-[13.5px] text-ink-40">
            {status === 'PENDING'
              ? 'Tests appear here as doctors request them during a consultation.'
              : 'Completed tests will be listed here.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((o) => {
            const waited = minutesSince(o.createdAt);
            const token = o.appointment?.tokenNumber ?? null;

            return (
              <li key={o.id} className="card overflow-hidden">
                <div className="flex flex-wrap items-start gap-4 px-5 py-4">
                  {/*
                    THE TOKEN, in the largest type on the row.

                    It is how the patient is called, and the number they are
                    holding — a department that shouts a name across a waiting
                    room is a department mispronouncing it. A walk-in test joins
                    no queue and has no token, which is said rather than left
                    blank.
                  */}
                  <div className="w-[62px] shrink-0 text-center">
                    {token === null ? (
                      <span className="mono-label block pt-1.5 !text-ink-20">walk-in</span>
                    ) : (
                      <>
                        <span className="block font-mono text-[22px] font-bold leading-none tabular-nums">
                          {token}
                        </span>
                        <span className="mono-label mt-1 block">token</span>
                      </>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* The study first: it is what the person at the machine
                        is about to do. */}
                    <p className="font-display text-[17px] font-bold leading-tight">
                      {o.description}
                    </p>

                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                      <span className="font-semibold text-ink">{o.patient.name}</span>
                      <span className="text-ink-40">
                        {ageLabel(o.patient.ageYears)} {genderInitial(o.patient.gender)}
                      </span>
                      <span className="font-mono text-[12px] text-ink-40">{o.patient.uhid}</span>
                      {/* The fix for a patient who wandered off between paying
                          and being called is a phone call, not a search of the
                          corridor. */}
                      <span className="font-mono text-[12px] text-ink-40">{o.patient.mobile}</span>
                      <span aria-hidden="true" className="h-1 w-1 rounded-full bg-ink/20" />
                      <span className="text-ink-40">{o.department.name}</span>
                    </p>

                    <AllergyStrip patient={o.patient} />

                    <p className="mt-1.5 text-[12.5px] text-ink-40">
                      Asked by {o.orderedBy.fullName} at{' '}
                      {new Date(o.createdAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}
                      {/* Why, in the doctor's own words from the visit. "X-ray
                          — left wrist" plus "fell off a scooter" is a different
                          instruction from "X-ray — left wrist" alone. */}
                      {o.appointment?.reasonForVisit && (
                        <span className="text-ink-60"> · {o.appointment.reasonForVisit}</span>
                      )}
                      {o.referralSource === 'EXTERNAL_DOCTOR' && o.referrerName && (
                        <span> · referred by {o.referrerName}</span>
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {/* How long they have been waiting on this. Amber past half
                        an hour, which is when somebody usually comes to ask. */}
                    {status === 'PENDING' && (
                      <span
                        className={`badge ${waited >= 30 ? 'badge-amber' : 'badge-neutral'}`}
                        title={`Ordered at ${new Date(o.createdAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}`}
                      >
                        {waitLabel(waited)}
                      </span>
                    )}

                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {/* Decision (c): the row stays visible. A patient standing
                          at the counter must not disappear from the list because
                          their bill is open — what is withheld is the result,
                          not the fact of the request. */}
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
                          films waits to be collected — and an uncollected film
                          is the complaint. */}
                      {o.status === 'COMPLETED' &&
                        (o.handedOverAt ? (
                          <span className="badge-neutral">given out</span>
                        ) : (
                          <span className="badge-amber">not collected</span>
                        ))}
                    </span>

                    <button
                      type="button"
                      // Thumb height on a phone; unchanged under a mouse.
                      className="btn-secondary !py-2 !text-[13px] md:!py-1.5"
                      onClick={() => void openDetail(o.id)}
                    >
                      {o.status === 'PENDING' && mayResult ? 'Attach result' : 'Open'}
                    </button>
                  </div>
                </div>

                {/* The reading, once there is one, across the foot of the card
                    rather than hidden behind Open. The commonest thing anybody
                    wants from the Done list is what the test said. */}
                {o.resultNote && (
                  <p className="border-t border-ink/8 bg-bg-soft px-5 py-2.5 text-[12.5px] text-ink-60">
                    {o.resultNote}
                  </p>
                )}
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
                          This test has not been paid for. Send the patient to the finance desk —
                          the result cannot go out until the bill is cleared.
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
                    Attach a file or write a report — an order cannot be marked done with neither.
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
                    {busy === 'complete' ? 'Saving…' : 'Mark done'}
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
                        Recorded once. Name whoever physically took it — the patient, or the
                        relative who collected it.
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
