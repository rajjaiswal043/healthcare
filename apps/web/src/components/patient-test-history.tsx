'use client';

import { useState } from 'react';
import { api, ApiRequestError, type PastTest } from '@/lib/api';

/**
 * Every test this patient has had back, on demand.
 *
 * Behind a button rather than loaded with the page, and that is not a
 * performance decision. Decision (e) makes this a narrow, audited door onto a
 * patient's whole record — the doctor asks for it, the server records that they
 * asked, and a screen that fetched it on every consultation would log every
 * doctor as having read every patient's results whether they looked or not.
 *
 * Distinct from the three-visit summary in `PreviousVisitsPanel`, which stays
 * exactly as it was: that one is a quick look at recent visits, this one is the
 * complete list and is not keyed on visits at all.
 */
export function PatientTestHistory({ encounterId }: { encounterId: string }) {
  const [tests, setTests] = useState<PastTest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setTests((await api.patientTestHistory(encounterId)).orders);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not load the test history.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (tests === null) {
    return (
      <div className="mt-4">
        <button
          type="button"
          className="btn-secondary !py-2"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? 'Loading…' : 'All previous tests'}
        </button>
        {error && (
          <p role="alert" className="mt-2 text-[12.5px] text-coral-text">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (tests.length === 0) {
    return <p className="mt-4 text-[13px] text-ink-40">No earlier tests on record.</p>;
  }

  return (
    <div className="mt-4">
      <p className="mono-label mb-2">All previous tests</p>
      <ul className="space-y-2">
        {tests.map((t) => (
          <li key={t.id} className="rounded-panel border border-ink/10 px-3.5 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="font-semibold text-[13.5px]">{t.description}</span>
              <span className="mono-label">{t.department.name}</span>
              <span className="text-[12.5px] text-ink-40">
                {new Date(t.completedAt).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
            </div>

            {t.resultNote && (
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-60">{t.resultNote}</p>
            )}

            {t.documents.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {t.documents.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      className="text-[12.5px] font-semibold text-clinical-text underline underline-offset-2"
                      onClick={() =>
                        void (async () => {
                          try {
                            const { url } = await api.documentUrl(d.id);
                            window.open(url, '_blank', 'noopener,noreferrer');
                          } catch {
                            setError('Could not open that file.');
                          }
                        })()
                      }
                    >
                      {d.fileName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-coral-text">
          {error}
        </p>
      )}
    </div>
  );
}
