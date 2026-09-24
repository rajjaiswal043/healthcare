'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BackButton } from '@/components/back-button';
import {
  api,
  ApiRequestError,
  type EncounterSummary,
  type PatientCorrection,
  type PatientDetail,
} from '@/lib/api';
import { PatientCorrectionDialog } from '@/components/patient-correction-dialog';
import { useAuth } from '@/components/auth-provider';
import { formatAge, genderInitial } from '@/lib/format';
import {
  IconAlert,
  IconArrowLeft,
  IconCalendar,
  IconIdCard,
  IconPhone,
  IconStethoscope,
} from '@/components/icons';

/** Consent purposes, in the order a clinic thinks about them. */
const CONSENT_LABELS: Record<string, string> = {
  CARE_DELIVERY: 'Care delivery',
  COMMUNICATIONS: 'Communications',
  MARKETING: 'Marketing',
  ABDM_LINKING: 'ABDM linking',
  TELEHEALTH: 'Telehealth',
};

const STATUS_TONE: Record<string, string> = {
  FULFILLED: 'badge-green',
  IN_PROGRESS: 'badge-clinical',
  ARRIVED: 'badge-amber',
  BOOKED: 'badge-neutral',
  CANCELLED: 'badge-coral',
  NO_SHOW: 'badge-coral',
};

export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();

  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [encounters, setEncounters] = useState<EncounterSummary[] | null>(null);
  const [correcting, setCorrecting] = useState(false);
  /** Null until an administrator asks for them — see the panel at the bottom. */
  const [corrections, setCorrections] = useState<PatientCorrection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const mayReadNotes = can('consultation:read');

  /** Named so a correction can re-read the record without duplicating this. */
  const load = useCallback(async () => {
    try {
      setPatient(await api.getPatient(id));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the patient.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Clinical notes are fetched separately and only by those allowed to read
   * them. Folding them into the patient response would mean the front desk's
   * request either carries data they may not see, or the endpoint returns a
   * different shape per role — and a response whose shape depends on the caller
   * is a response nobody can type.
   */
  useEffect(() => {
    if (!mayReadNotes) return;
    void (async () => {
      try {
        setEncounters((await api.patientEncounters(id)).encounters);
      } catch {
        // A failure here must not take the page down — the demographics above
        // are still worth showing.
        setEncounters([]);
      }
    })();
  }, [id, mayReadNotes]);

  if (loading) return <p className="text-[14px] text-ink-60">Loading…</p>;

  if (!patient) {
    return (
      <div className="card p-6">
        <p className="text-[14px] text-coral-text">{error ?? 'Patient not found.'}</p>
        <Link href="/patients" className="btn-secondary mt-4">
          <IconArrowLeft size={15} />
          Back to patients
        </Link>
      </div>
    );
  }

  const address = [patient.addressLine, patient.city, patient.state, patient.postalCode]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          {/* Back to wherever this record was opened from — search, or the
              recent list, or a consultation. It used to be a link hard-coded to
              search, which sent everybody arriving from the recent list to the
              wrong screen. Search stays the fallback for a record opened
              directly, with nothing behind it to go back to. */}
          <BackButton fallback="/patients" className="btn-ghost mt-1 !px-2 !py-2" />

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-[28px] font-bold">{patient.name}</h1>
              {!patient.isActive && <span className="badge badge-coral">Inactive</span>}
              {patient.bloodGroup !== 'UNKNOWN' && (
                <span className="badge badge-neutral">
                  {patient.bloodGroup.replace('_POSITIVE', '+').replace('_NEGATIVE', '−')}
                </span>
              )}
            </div>

            <p className="mt-1 text-[14px] text-ink-60">
              <span className="font-mono">{patient.uhid}</span> · {formatAge(patient)}{' '}
              {genderInitial(patient.gender)} · {patient.mobile}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* FR-P36-20. Beside booking rather than buried in the record,
              because a wrong mobile is usually noticed while somebody is trying
              to use it. */}
          {can('patient:write') && (
            <button type="button" className="btn-secondary" onClick={() => setCorrecting(true)}>
              <IconIdCard size={16} />
              Correct details
            </button>
          )}

          {can('appointment:write') && (
            <Link href={`/appointments/new?patientId=${patient.id}`} className="btn-primary">
              <IconCalendar size={16} />
              Book an appointment
            </Link>
          )}
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-panel border border-coral/30 bg-coral/8 p-3 text-[13px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={15} />
          </span>
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Visits" value={String(patient.stats.totalVisits)} />
        <Stat label="Completed" value={String(patient.stats.completedVisits)} />
        <Stat
          label="Last seen"
          value={
            patient.stats.lastVisitAt
              ? new Date(patient.stats.lastVisitAt).toLocaleDateString('en-IN', {
                  dateStyle: 'medium',
                })
              : '—'
          }
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1.25fr]">
        <div className="space-y-5">
          <section className="card p-5">
            <p className="mono-label">Details</p>
            <dl className="mt-3 space-y-2.5">
              <Field label="Mobile" value={patient.mobile} icon={<IconPhone size={13} />} />
              <Field label="Email" value={patient.email} />
              <Field label="Address" value={address || null} />
              <Field
                label="Emergency contact"
                value={
                  patient.emergencyContactName
                    ? `${patient.emergencyContactName}${
                        patient.emergencyContactMobile ? ` · ${patient.emergencyContactMobile}` : ''
                      }`
                    : null
                }
              />
              <Field
                label="ABHA"
                value={patient.abhaNumber ?? patient.abhaAddress}
                icon={<IconIdCard size={13} />}
                /* Empty for everyone until ABDM linking lands in Phase 4. Shown
                   anyway so the gap is visible rather than mysterious. */
                emptyHint="Not linked"
              />
              <Field
                label="Registered"
                value={new Date(patient.createdAt).toLocaleDateString('en-IN', {
                  dateStyle: 'medium',
                })}
              />
            </dl>
          </section>

          <section className="card p-5">
            <p className="mono-label">Consent</p>

            {patient.consents.length === 0 ? (
              <p className="field-hint mt-2">Nothing recorded.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {patient.consents.map((c) => (
                  <li
                    key={c.purpose}
                    className="flex items-center justify-between gap-3 rounded-panel border border-ink/10 bg-white px-3 py-2"
                  >
                    <span className="text-[13px]">
                      {CONSENT_LABELS[c.purpose] ?? c.purpose}
                      <span className="block font-mono text-[10.5px] text-ink-40">
                        notice {c.noticeVersion} ·{' '}
                        {new Date(c.grantedAt).toLocaleDateString('en-IN')}
                      </span>
                    </span>
                    <span className={`badge ${c.granted ? 'badge-green' : 'badge-neutral'}`}>
                      {c.granted ? 'Given' : 'Declined'}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* The current position per purpose. Withdrawals are new records
                rather than edits, so the history behind this stays intact. */}
            <p className="field-hint mt-2">
              Current position per purpose, under the DPDP Act. Earlier decisions are retained.
            </p>
          </section>
        </div>

        <div className="space-y-5">
          {mayReadNotes && (
            <section className="card p-5">
              <p className="mono-label">Consultations</p>

              {encounters === null ? (
                <p className="field-hint mt-2">Loading…</p>
              ) : encounters.length === 0 ? (
                <p className="field-hint mt-2">No consultations recorded.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {encounters.map((e) => (
                    <li key={e.id}>
                      <Link
                        href={`/consultations/${e.id}`}
                        className="block rounded-panel border border-ink/10 bg-white px-3 py-2.5 transition-colors hover:border-clinical/40"
                      >
                        <span className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-[13.5px] font-semibold">
                            {e.chiefComplaint || 'No complaint recorded'}
                          </span>
                          <span className="text-[11.5px] text-ink-40">
                            {new Date(e.startedAt).toLocaleDateString('en-IN', {
                              dateStyle: 'medium',
                            })}
                          </span>
                        </span>

                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          {e.status === 'SIGNED' ? (
                            <span className="badge badge-green">Signed</span>
                          ) : (
                            <span className="badge badge-amber">Draft</span>
                          )}
                          {e.diagnoses.slice(0, 3).map((d, i) => (
                            <span key={`${d.code}-${i}`} className="badge badge-neutral">
                              {d.display}
                            </span>
                          ))}
                          {e.prescriptionCount > 0 && (
                            <span className="text-[11.5px] text-ink-40">
                              {e.prescriptionCount} drug{e.prescriptionCount === 1 ? '' : 's'}
                            </span>
                          )}
                        </span>

                        <span className="mt-0.5 block text-[11.5px] text-ink-40">
                          {e.practitioner.fullName}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="card p-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="mono-label">Visits</p>
              {/* Say what is not shown. A capped list that looks complete is
                  worse than one that admits it is capped. */}
              {patient.stats.totalVisits > patient.appointments.length && (
                <p className="text-[11.5px] text-ink-40">
                  showing {patient.appointments.length} of {patient.stats.totalVisits}
                </p>
              )}
            </div>

            {patient.appointments.length === 0 ? (
              <p className="field-hint mt-2">No appointments yet.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {patient.appointments.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-panel border border-ink/10 bg-white px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="text-[13px] font-semibold">
                        {new Date(a.startAt).toLocaleString('en-IN', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                      <span className="block text-[12px] text-ink-60">
                        {a.practitioner.fullName}
                        {a.reasonForVisit ? ` · ${a.reasonForVisit}` : ''}
                        {a.source === 'WALK_IN' ? ' · walk-in' : ''}
                      </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-2">
                      <span className={`badge ${STATUS_TONE[a.status] ?? 'badge-neutral'}`}>
                        {a.status.replace('_', ' ').toLowerCase()}
                      </span>
                      {a.encounterId && mayReadNotes && (
                        <Link
                          href={`/consultations/${a.encounterId}`}
                          className="btn-ghost !px-2 !py-1 text-[11.5px]"
                        >
                          <IconStethoscope size={12} />
                          Note
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* FR-P36-22. Behind `audit:read`, and loaded on demand rather than with
          the page: this table holds patient data, so it is not something every
          screen load should pull down. */}
      {can('audit:read') && (
        <section className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-[17px] font-bold">Corrections</h2>
            {corrections === null && (
              <button
                type="button"
                className="btn-secondary !py-1.5"
                onClick={() =>
                  void (async () => {
                    try {
                      setCorrections((await api.patientCorrections(patient.id)).corrections);
                    } catch (err) {
                      setError(
                        err instanceof ApiRequestError
                          ? err.error.message
                          : 'Could not load corrections.',
                      );
                    }
                  })()
                }
              >
                Show what changed
              </button>
            )}
          </div>

          {corrections !== null &&
            (corrections.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-40">
                This record has not been corrected since registration.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {corrections.map((c) => (
                  <li key={c.id} className="rounded-panel border border-ink/10 px-3.5 py-2.5">
                    <p className="text-[13.5px]">
                      <span className="mono-label mr-2">{c.field}</span>
                      <span className="text-ink-40 line-through">{c.oldValue ?? 'empty'}</span>
                      <span className="mx-2 text-ink-20">→</span>
                      <span className="font-semibold">{c.newValue ?? 'empty'}</span>
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-40">
                      {c.correctedBy.fullName} ·{' '}
                      {new Date(c.createdAt).toLocaleString('en-IN', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            ))}
        </section>
      )}

      {correcting && (
        <PatientCorrectionDialog
          patient={patient}
          onClose={() => setCorrecting(false)}
          onSaved={() => {
            void load();
            // Force a re-fetch if the history is already open, so a correction
            // made now does not sit behind a stale list.
            setCorrections(null);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card-flat px-4 py-3">
      <p className="mono-label">{label}</p>
      <p className="mt-1 font-display text-[22px] font-bold">{value}</p>
    </div>
  );
}

function Field({
  label,
  value,
  icon,
  emptyHint = '—',
}: {
  label: string;
  value: string | null;
  icon?: React.ReactNode;
  emptyHint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="mono-label shrink-0 !text-[9.5px]">{label}</dt>
      <dd
        className={`min-w-0 text-right text-[13px] ${value ? '' : 'text-ink-20'} flex items-center gap-1.5`}
      >
        {value && icon}
        <span className="break-words">{value ?? emptyHint}</span>
      </dd>
    </div>
  );
}
