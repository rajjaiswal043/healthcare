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

  const load = useCallback(async () => {
    try {
      const { orders } = await api.diagnosticWorklist({
        ...(departmentId ? { departmentId } : {}),
        status,
      });
      setOrders(orders);
      setRefreshedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the list.');
    }
  }, [departmentId, status]);

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

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Diagnostics</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">
            {status === 'PENDING'
              ? 'Tests to do'
              : status === 'COMPLETED'
                ? 'Completed today'
                : 'Declined by the patient'}
          </h1>
          <p className="mt-1 text-[14px] text-ink-60">
            Oldest first — the order a patient has already waited in.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="department" className="field-label">
              Department
            </label>
            <select
              id="department"
              className="field-input min-w-[180px]"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              <option value="">All</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="status" className="field-label">
              Showing
            </label>
            <select
              id="status"
              className="field-input min-w-[150px]"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'PENDING' | 'COMPLETED' | 'DECLINED')}
            >
              <option value="PENDING">To do</option>
              <option value="COMPLETED">Done</option>
              {/* Not work, so not on the to-do list — but the department's real
                  question is "what happened to the X-ray I was expecting", and
                  it needs somewhere to be answered. */}
              <option value="DECLINED">Declined</option>
            </select>
          </div>

          <button
            type="button"
            className="btn-secondary !px-3"
            onClick={() => void load()}
            aria-label="Refresh now"
            title="Refresh now"
          >
            <IconRefresh size={16} />
          </button>
        </div>
      </header>

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

      {orders.length === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="font-display text-[18px] font-bold">
            {status === 'PENDING'
              ? 'Nothing waiting'
              : status === 'COMPLETED'
                ? 'Nothing done yet today'
                : 'Nothing declined'}
          </p>
          <p className="mt-1 text-[13.5px] text-ink-40">
            {status === 'PENDING'
              ? 'Tests appear here as doctors request them during a consultation.'
              : 'Completed tests will be listed here.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {orders.map((o) => (
            <li key={o.id} className="card flex flex-wrap items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                {/* The study first: it is what the person at the machine needs. */}
                <p className="font-display text-[17px] font-bold">{o.description}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-ink-60">
                  <span className="font-semibold text-ink">{o.patient.name}</span>
                  <span className="text-ink-40">
                    {ageLabel(o.patient.ageYears)} {genderInitial(o.patient.gender)}
                  </span>
                  <span className="font-mono text-[12px] text-ink-40">{o.patient.uhid}</span>
                  <span aria-hidden="true" className="h-1 w-1 rounded-full bg-ink/20" />
                  <span className="text-ink-40">{o.department.name}</span>
                  <span aria-hidden="true" className="h-1 w-1 rounded-full bg-ink/20" />
                  <span className="text-ink-40">asked by {o.orderedBy.fullName}</span>
                </p>
              </div>

              {/* Decision (c): the row stays visible. A patient standing at the
                  counter must not disappear from the list because their bill is
                  open — what is withheld is the result, not the fact of the
                  request. */}
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

              {/* Its own words. "Cancelled" would say the clinician called it
                  off; this says the request stood and the patient said no. */}
              {o.status === 'DECLINED' && (
                <span className="badge-neutral">declined by patient</span>
              )}

              {/* Which reports are still sitting on the counter. The Done tab
                  otherwise looks finished while a stack of films waits to be
                  collected — and an uncollected film is the complaint. */}
              {o.status === 'COMPLETED' &&
                (o.handedOverAt ? (
                  <span className="badge-neutral">given out</span>
                ) : (
                  <span className="badge-amber">not collected</span>
                ))}

              <button type="button" className="btn-secondary" onClick={() => void openDetail(o.id)}>
                {o.status === 'PENDING' && mayResult ? 'Attach result' : 'Open'}
              </button>
            </li>
          ))}
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
                    className="field-input text-[13.5px]"
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
