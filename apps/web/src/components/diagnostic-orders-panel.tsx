'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiRequestError,
  type ClinicalDocument,
  type Department,
  type DiagnosticOrder,
} from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { IconAlert, IconCheck, IconStethoscope } from '@/components/icons';

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
  editable,
}: {
  appointmentId: string;
  /** False once the consultation is signed: no new tests against a closed visit. */
  editable: boolean;
}) {
  const { can } = useAuth();

  const [orders, setOrders] = useState<DiagnosticOrder[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [departmentId, setDepartmentId] = useState('');
  const [description, setDescription] = useState('');

  /** Which order's files are expanded. Null when none. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ClinicalDocument[]>([]);

  const mayOrder = can('diagnostic:order');

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
      try {
        const { departments } = await api.diagnosticDepartments();
        setDepartments(departments);
        if (departments.length > 0) setDepartmentId(departments[0]!.id);
      } catch {
        // The panel still lists existing orders without this.
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
        description: description.trim(),
      });
      setDescription('');
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not request that test.');
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

  // Nothing to show and nothing to do: keep the consultation uncluttered for a
  // clinic that has no diagnostic department at all.
  if (orders.length === 0 && (!mayOrder || departments.length === 0)) return null;

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
      </div>

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
                onChange={(e) => setDepartmentId(e.target.value)}
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

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

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary !py-2"
              disabled={busy || description.trim().length < 2 || !departmentId}
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
    </section>
  );
}
