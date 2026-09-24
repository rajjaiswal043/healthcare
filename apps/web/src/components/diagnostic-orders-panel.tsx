'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiRequestError,
  type ClinicalDocument,
  type Department,
  type DiagnosticOrder,
  type DiagnosticTest,
} from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { useAuth } from '@/components/auth-provider';
import { IconAlert, IconCheck, IconStethoscope } from '@/components/icons';
import { TestBillingBadge } from '@/components/test-billing-badge';
import { PatientTestHistory } from '@/components/patient-test-history';

/**
 * Tests, inside the consultation.
 *
 * Both halves in one panel on purpose: the doctor asks for an X-ray and, twenty
 * minutes later on the same screen, reads it. Splitting "order" from "results"
 * would mean the answer arriving somewhere other than where the question was
 * asked.
 *
 * Results are shown for THIS visit. Previous visits' films are FR-P36-23, which
 * is a different piece of work — see docs/08.
 */
export function DiagnosticOrdersPanel({
  appointmentId,
  encounterId,
  editable,
  externalTestNote,
  onExternalTestNote,
}: {
  appointmentId: string;
  /** Whose consultation this is. The test-history gate is checked against it. */
  encounterId: string;
  /** False once the consultation is signed: no new tests against a closed visit. */
  editable: boolean;
  /** Tests this centre does not do. Lives on the visit, prints on the slip. */
  externalTestNote: string | null;
  onExternalTestNote: (note: string | null) => void;
}) {
  const { can } = useAuth();

  const [orders, setOrders] = useState<DiagnosticOrder[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [departmentId, setDepartmentId] = useState('');
  const [description, setDescription] = useState('');

  /**
   * The clinic's priced tests. Empty for a clinic that has not priced any, and
   * the form then behaves exactly as it did before the catalogue existed.
   */
  const [catalogue, setCatalogue] = useState<DiagnosticTest[]>([]);
  /**
   * The picked test: '' until one is chosen, then a service id.
   *
   * It starts empty rather than on the first test in the list. A form that opens
   * with a test already selected is one mis-click away from ordering a scan
   * nobody asked for, and the doctor would not see it until it appeared on the
   * bill.
   */
  const [serviceId, setServiceId] = useState<string>('');

  /**
   * The "not done here" note, being typed.
   *
   * Its own field and its own state, deliberately separate from the order form
   * above it. This note never reaches a worklist, so it has no department to
   * belong to — and requiring one would lock it away from exactly the clinics
   * that need it most: a centre performing no tests at all has no diagnostic
   * department, and every test its patients need is done somewhere else.
   */
  const [noting, setNoting] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  /** Which order's files are expanded. Null when none. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ClinicalDocument[]>([]);

  const mayOrder = can('diagnostic:order');

  /** What this department can be asked for. */
  const testsHere = catalogue.filter((t) => t.department.id === departmentId);
  const picked = testsHere.find((t) => t.id === serviceId) ?? null;

  const load = useCallback(async () => {
    try {
      setOrders((await api.ordersForVisit(appointmentId)).orders);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load tests.');
    }
  }, [appointmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!mayOrder) return;
    void (async () => {
      /**
       * Loaded independently, not with `Promise.all`.
       *
       * They were joined once, and one rejection took both down: a failing
       * catalogue call left `departments` empty, which the panel reads as "this
       * clinic has no diagnostic department" and says so — sending the doctor
       * to Settings to fix a department that was there all along. A screen that
       * misdiagnoses its own outage is worse than one that simply degrades.
       */
      try {
        const { departments } = await api.diagnosticDepartments();
        setDepartments(departments);
        if (departments.length > 0) setDepartmentId(departments[0]!.id);
      } catch {
        // The panel still lists existing orders, and the slip note still works.
      }

      try {
        setCatalogue((await api.diagnosticCatalogue()).tests);
      } catch {
        // No picker, but the department's free-text form still raises orders.
      }
    })();
  }, [mayOrder]);

  async function raise() {
    setBusy(true);
    setError(null);
    try {
      await api.raiseDiagnosticOrder({
        appointmentId,
        departmentId,
        serviceId,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setDescription('');
      setServiceId('');
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not request that test.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Add a line to the slip for something this centre does not do.
   *
   * Appends rather than replaces: a patient may need two things done
   * elsewhere, and a doctor writing the second should not silently lose the
   * first. `Clear` removes the whole note, which is the only deletion the slip
   * needs — there is no unsay for something already printed.
   */
  async function saveNote() {
    const line = noteDraft.trim();
    if (!line) return;

    setBusy(true);
    setError(null);
    try {
      const next = externalTestNote ? `${externalTestNote}\n${line}` : line;
      const { externalTestNote: saved } = await api.setExternalTestNote(appointmentId, next);
      onExternalTestNote(saved);
      setNoteDraft('');
      setNoting(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  async function clearNote() {
    setBusy(true);
    setError(null);
    try {
      const { externalTestNote: saved } = await api.setExternalTestNote(appointmentId, null);
      onExternalTestNote(saved);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not clear that.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    try {
      const order = await api.diagnosticOrder(id);
      setDocuments(order.documents);
      setOpenId(id);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not open that test.');
    }
  }

  /** Fetched at click time — the URL expires in five minutes. */
  async function openDocument(id: string) {
    try {
      const { url } = await api.documentUrl(id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not open that file.');
    }
  }

  /**
   * Hidden only for somebody who can neither order nor see anything.
   *
   * A nurse on a visit with no tests gets an uncluttered consultation. A DOCTOR
   * always gets this section, even where the clinic has no diagnostic
   * department: two of the things in it do not need one. The test history is
   * about the patient, not about this clinic's rooms — and a centre that
   * performs no tests at all is precisely the one whose patients most need
   * "have this done elsewhere" written on their slip.
   */
  if (orders.length === 0 && !externalTestNote && !mayOrder) return null;

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-display text-[17px] font-bold">
          <IconStethoscope size={16} />
          Tests
        </h2>

        {mayOrder && editable && departments.length > 0 && !adding && (
          <button type="button" className="btn-secondary !py-1.5" onClick={() => setAdding(true)}>
            Request a test
          </button>
        )}

        {/* Always offered, department or no department. This is the only
            control on the panel that needs nothing set up — see `noting`. */}
        {mayOrder && editable && !noting && (
          <button type="button" className="btn-ghost !py-1.5" onClick={() => setNoting(true)}>
            Not done here
          </button>
        )}
      </div>

      {/* Why there is no "Request a test" here. Said once, quietly: without it
          a doctor cannot tell a broken screen from a clinic nobody finished
          setting up — and the slip note above still works either way. */}
      {mayOrder && editable && departments.length === 0 && !noting && (
        <p className="mt-2 text-[12.5px] text-ink-40">
          No department here does tests yet — an administrator adds one in Settings → Doctors.
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3 py-2 text-[12.5px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={13} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {adding && (
        <div className="mt-4 space-y-3 rounded-panel border border-ink/10 bg-bg-soft p-3.5">
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[160px]">
              <label htmlFor="testDepartment" className="field-label">
                Department
              </label>
              <select
                id="testDepartment"
                className="field-input !py-2"
                value={departmentId}
                onChange={(e) => {
                  // A test belongs to one department; keeping the pick across a
                  // switch would send the server a mismatch it would reject.
                  setDepartmentId(e.target.value);
                  setServiceId('');
                  setDescription('');
                }}
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            {testsHere.length > 0 && (
              <div className="min-w-[220px]">
                <label htmlFor="testService" className="field-label">
                  Test
                </label>
                <select
                  id="testService"
                  className="field-input !py-2"
                  value={serviceId}
                  aria-describedby={picked ? 'testFee' : undefined}
                  onChange={(e) => {
                    const next = e.target.value;
                    setServiceId(next);
                    // Pre-fill so the doctor adds the side and the view rather
                    // than retyping the name. Their own words are never
                    // overwritten by a later pick — the field is cleared first.
                    const test = testsHere.find((t) => t.id === next);
                    setDescription(test ? test.name : '');
                  }}
                >
                  <option value="">Select a test…</option>
                  {testsHere.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {formatPaise(t.pricePaise)}
                    </option>
                  ))}
                </select>

                {/* The dropdown lists what this centre performs, and nothing
                    else. Anything missing from it is not an order at all, so
                    it is offered here as a way out of the form rather than as
                    a phantom entry inside it. */}
                <button
                  type="button"
                  className="mt-1 text-[12px] text-ink-40 underline underline-offset-2"
                  onClick={() => {
                    setAdding(false);
                    // Carry across only what the doctor typed themselves. A
                    // pre-filled catalogue name would follow them into the
                    // note and claim the centre does not do its own test.
                    setNoteDraft(serviceId === '' ? description.trim() : '');
                    setNoting(true);
                  }}
                >
                  Not listed? Put it on the slip
                </button>
              </div>
            )}

            <div className="min-w-[240px] flex-1">
              <label htmlFor="testDescription" className="field-label">
                What to do
              </label>
              <input
                id="testDescription"
                className="field-input !py-2"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="X-ray left knee, AP and lateral"
                maxLength={300}
              />
            </div>
          </div>

          {/* The fee, where the decision is made. A doctor who can see it can
              tell the patient before the bill does. */}
          {picked && (
            <p id="testFee" className="text-[12.5px] text-ink-soft">
              <span className="mono-label mr-2">Fee</span>
              <span className="font-semibold tabular-nums text-ink">
                {formatPaise(picked.pricePaise)}
              </span>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary !py-2"
              disabled={
                busy ||
                !departmentId ||
                description.trim().length < 2 ||
                (testsHere.length > 0 && serviceId === '')
              }
              onClick={() => void raise()}
            >
              {busy ? 'Requesting…' : 'Request'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setAdding(false);
                setDescription('');
                setServiceId('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {orders.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-40">None requested on this visit.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {orders.map((o) => (
            <li key={o.id} className="rounded-panel border border-ink/10 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold text-[14px]">{o.description}</span>
                <span className="mono-label">{o.department.name}</span>

                {o.status === 'PENDING' && <span className="badge-amber">waiting</span>}
                {o.status === 'COMPLETED' && (
                  <span className="badge-green">
                    <IconCheck size={11} /> back
                  </span>
                )}
                {o.status === 'CANCELLED' && <span className="badge-neutral">cancelled</span>}
                {/* Said differently from "cancelled": the doctor's request
                    stood, and the patient turned it down. */}
                {o.status === 'DECLINED' && (
                  <span className="badge-neutral">declined by patient</span>
                )}

                {/* So the doctor knows why the film has not come back: the
                    patient has not been past the desk yet. */}
                {o.status === 'PENDING' && <TestBillingBadge billing={o.billing} />}

                {(o._count.documents > 0 || o.resultNote) && (
                  <button
                    type="button"
                    className="ml-auto text-[12.5px] font-semibold text-clinical-text underline underline-offset-2"
                    onClick={() => void toggle(o.id)}
                  >
                    {openId === o.id ? 'Hide' : 'View result'}
                  </button>
                )}

                {o.status === 'PENDING' && mayOrder && editable && (
                  <button
                    type="button"
                    className="text-[12.5px] font-semibold text-coral-text underline underline-offset-2"
                    onClick={() =>
                      void (async () => {
                        try {
                          await api.cancelDiagnosticOrder(o.id);
                          await load();
                        } catch (err) {
                          setError(
                            err instanceof ApiRequestError
                              ? err.error.message
                              : 'Could not cancel.',
                          );
                        }
                      })()
                    }
                  >
                    Cancel
                  </button>
                )}
              </div>

              {openId === o.id && (
                <div className="mt-3 border-t border-dashed border-ink/15 pt-3">
                  {o.resultNote && (
                    <p className="whitespace-pre-wrap text-[13.5px]">{o.resultNote}</p>
                  )}
                  {documents.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {documents.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            className="text-[13px] font-semibold text-clinical-text underline underline-offset-2"
                            onClick={() => void openDocument(d.id)}
                          >
                            {d.fileName}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The whole record, on request. Fetched only when asked: the read is
          audited, and loading it eagerly would log every doctor as having read
          every patient's results whether they looked or not. */}
      {mayOrder && encounterId && <PatientTestHistory encounterId={encounterId} />}

      {noting && (
        <div className="mt-4 space-y-3 rounded-panel border border-dashed border-ink/20 bg-bg-soft p-3.5">
          <div>
            <label htmlFor="externalTest" className="field-label">
              Test to be done elsewhere
            </label>
            <input
              id="externalTest"
              className="field-input !py-2"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="MRI brain, plain"
              maxLength={1000}
              autoFocus
            />
            {/* No department, and no price. It is not work for anybody here. */}
            <p className="field-hint">
              Goes on the printed slip and to the finance desk. No department, no charge, and nobody
              here is asked to do it.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary !py-2"
              disabled={busy || noteDraft.trim().length < 2}
              onClick={() => void saveNote()}
            >
              {busy ? 'Saving…' : 'Add to slip'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setNoting(false);
                setNoteDraft('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Not an order and not on any worklist — words for the patient to take
          away, and for the desk to read before the patient asks. */}
      {externalTestNote && (
        <div className="mt-4 rounded-panel border border-dashed border-ink/20 bg-bg-soft px-3.5 py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="mono-label">Not done here — on the slip</p>
            {mayOrder && editable && (
              <button
                type="button"
                className="text-[12.5px] font-semibold text-ink-60 underline underline-offset-2"
                disabled={busy}
                onClick={() => void clearNote()}
              >
                Clear
              </button>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[13.5px]">{externalTestNote}</p>
        </div>
      )}
    </section>
  );
}
