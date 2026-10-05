'use client';

import { useEffect, useState } from 'react';
import { api, ApiRequestError, type PreviousVisit } from '@/lib/api';
import { IconAlert, IconClock } from '@/components/icons';

/**
 * What happened last time.
 *
 * FR-P36-23, from the orthopaedic clinic demo. The doctor's question
 * mid-consultation is "what did I give her last time", and answering it used to
 * mean leaving the consultation and losing the place.
 *
 * Two decisions shape this panel:
 *
 * **The most recent visit is open on arrival.** Not behind a click. A doctor with
 * a patient in the room does not go hunting, and a summary that has to be
 * expanded is a summary nobody reads.
 *
 * **Medicines are listed with their dose.** "3 medicines" is what the patient's
 * record already says and it is not something anybody can act on. In an
 * orthopaedic follow-up the answer is usually "the same again", which needs the
 * strength and the frequency to be visible.
 */
export function PreviousVisitsPanel({
  encounterId,
  onCarryForward,
}: {
  encounterId: string;
  /**
   * FR-P36-24: "the same again" in one click. Given only while the note is a
   * draft the caller may write; the caller merges and saves, so the doctor
   * still edits the result before signing.
   */
  onCarryForward?: ((prescriptions: PreviousVisit['prescriptions']) => Promise<void>) | undefined;
}) {
  const [visits, setVisits] = useState<PreviousVisit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [carried, setCarried] = useState<string | null>(null);
  const [carrying, setCarrying] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { visits } = await api.previousVisits(encounterId);
        setVisits(visits);
        // Most recent expanded; the rest are one click away.
        if (visits[0]) setOpenId(visits[0].id);
      } catch (err) {
        setError(
          err instanceof ApiRequestError ? err.error.message : 'Could not load earlier visits.',
        );
      }
    })();
  }, [encounterId]);

  // Still loading, or a first visit. Neither deserves a box: a panel saying
  // "no previous visits" is noise on the commonest case of all.
  if (visits === null) return null;
  if (visits.length === 0 && !error) return null;

  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 font-display text-[17px] font-bold">
        <IconClock size={16} />
        Last time
      </h2>

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

      <div className="mt-3 space-y-2">
        {visits.map((v) => {
          const open = openId === v.id;

          return (
            <div key={v.id} className="rounded-panel border border-ink/10">
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-left"
                onClick={() => setOpenId(open ? null : v.id)}
                aria-expanded={open}
              >
                <span className="text-[13.5px] font-semibold text-ink">
                  {new Date(v.startedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                </span>
                <span className="text-[12.5px] text-ink-40">{v.practitioner.fullName}</span>

                {v.diagnoses.length > 0 && (
                  <span className="badge-clinical">
                    {v.diagnoses.find((d) => d.isPrimary)?.display ?? v.diagnoses[0]?.display}
                  </span>
                )}

                {v.tests.length > 0 && (
                  <span className="badge-neutral">
                    {v.tests.length} {v.tests.length === 1 ? 'test' : 'tests'}
                  </span>
                )}

                <span className="ml-auto text-[12px] font-semibold text-clinical-text">
                  {open ? 'Hide' : 'Show'}
                </span>
              </button>

              {open && (
                <div className="space-y-3 border-t border-dashed border-ink/15 px-3.5 py-3 text-[13px]">
                  {v.chiefComplaint && (
                    <p>
                      <span className="mono-label mr-2">Complaint</span>
                      {v.chiefComplaint}
                    </p>
                  )}

                  {v.diagnoses.length > 0 && (
                    <p>
                      <span className="mono-label mr-2">Diagnosis</span>
                      {v.diagnoses
                        .map((d) => (d.code ? `${d.display} (${d.code})` : d.display))
                        .join(', ')}
                    </p>
                  )}

                  {/* The reason this panel exists. */}
                  {v.prescriptions.length > 0 && (
                    <div>
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <p className="mono-label">Medicines</p>
                        {onCarryForward && (
                          <button
                            type="button"
                            className="text-[12.5px] font-semibold text-clinical-text underline underline-offset-2 disabled:opacity-50"
                            disabled={carrying || carried === v.id}
                            onClick={() =>
                              void (async () => {
                                setCarrying(true);
                                try {
                                  await onCarryForward(v.prescriptions);
                                  setCarried(v.id);
                                } finally {
                                  setCarrying(false);
                                }
                              })()
                            }
                          >
                            {carried === v.id
                              ? 'Added to today’s prescription'
                              : carrying
                                ? 'Adding…'
                                : 'Repeat these medicines'}
                          </button>
                        )}
                      </div>
                      <ul className="space-y-0.5">
                        {v.prescriptions.map((p, i) => (
                          <li key={i}>
                            <span className="font-semibold">
                              {p.drugName}
                              {p.strength ? ` ${p.strength}` : ''}
                            </span>
                            <span className="text-ink-60">
                              {' — '}
                              {p.dose} ·{' '}
                              <span className="font-mono text-[12px]">{p.frequency}</span>
                              {p.durationDays ? ` × ${p.durationDays} days` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {v.vitals && (
                    <p className="text-ink-60">
                      <span className="mono-label mr-2">Vitals</span>
                      {[
                        v.vitals.systolicMmHg && v.vitals.diastolicMmHg
                          ? `BP ${v.vitals.systolicMmHg}/${v.vitals.diastolicMmHg}`
                          : null,
                        v.vitals.pulseBpm ? `Pulse ${v.vitals.pulseBpm}` : null,
                        v.vitals.temperatureC ? `Temp ${v.vitals.temperatureC}°C` : null,
                        v.vitals.spo2Percent ? `SpO₂ ${v.vitals.spo2Percent}%` : null,
                        v.vitals.weightKg ? `${v.vitals.weightKg} kg` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </p>
                  )}

                  {/* Checkpoint 4 of docs/09: results from an earlier visit, in
                      the place the doctor is already looking. */}
                  {v.tests.length > 0 && (
                    <div>
                      <p className="mono-label mb-1">Tests</p>
                      <ul className="space-y-1.5">
                        {v.tests.map((t) => (
                          <li key={t.id}>
                            <span className="font-semibold">{t.description}</span>
                            <span className="text-ink-40"> · {t.department.name}</span>
                            {t.resultNote && (
                              <p className="whitespace-pre-wrap text-ink-60">{t.resultNote}</p>
                            )}
                            {t.documents.map((d) => (
                              <button
                                key={d.id}
                                type="button"
                                className="mr-3 text-[12.5px] font-semibold text-clinical-text underline underline-offset-2"
                                onClick={() =>
                                  void (async () => {
                                    try {
                                      const { url } = await api.documentUrl(d.id);
                                      window.open(url, '_blank', 'noopener,noreferrer');
                                    } catch (err) {
                                      setError(
                                        err instanceof ApiRequestError
                                          ? err.error.message
                                          : 'Could not open that file.',
                                      );
                                    }
                                  })()
                                }
                              >
                                {d.fileName}
                              </button>
                            ))}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {v.advice && (
                    <p className="text-ink-60">
                      <span className="mono-label mr-2">Advice</span>
                      {v.advice}
                    </p>
                  )}

                  {v.prescriptionNote && (
                    <p className="text-ink-60">
                      <span className="mono-label mr-2">Note</span>
                      {v.prescriptionNote}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
