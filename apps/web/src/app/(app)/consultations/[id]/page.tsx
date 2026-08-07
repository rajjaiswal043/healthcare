'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiRequestError, type Encounter } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { formatAge, genderInitial } from '@/lib/format';
import {
  AddendaPanel,
  DiagnosesPanel,
  PrescriptionsPanel,
  VitalsPanel,
} from '@/components/consultation-panels';
import { PrescriptionPrint } from '@/components/prescription-print';
import { IconAlert, IconArrowLeft, IconCheckCircle, IconClock, IconLock } from '@/components/icons';

/** Narrative fields, saved on blur rather than on every keystroke. */
const NARRATIVE = [
  {
    key: 'chiefComplaint' as const,
    label: 'Chief complaint',
    placeholder: 'What the patient came in with, in their words',
    rows: 2,
  },
  {
    key: 'historyOfPresentIllness' as const,
    label: 'History',
    placeholder: 'Duration, progression, associated symptoms, relevant history',
    rows: 4,
  },
  {
    key: 'examinationFindings' as const,
    label: 'Examination',
    placeholder: 'General and systemic findings',
    rows: 4,
  },
  { key: 'advice' as const, label: 'Advice', placeholder: 'Rest, diet, warning signs', rows: 3 },
];

export default function ConsultationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();

  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [narrative, setNarrative] = useState<Record<string, string>>({});

  const mayWrite = can('consultation:write');

  const applyEncounter = useCallback((e: Encounter) => {
    setEncounter(e);
    setNarrative({
      chiefComplaint: e.chiefComplaint ?? '',
      historyOfPresentIllness: e.historyOfPresentIllness ?? '',
      examinationFindings: e.examinationFindings ?? '',
      advice: e.advice ?? '',
      followUpDate: e.followUpDate ? String(e.followUpDate).slice(0, 10) : '',
    });
    setSavedAt(new Date());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        applyEncounter(await api.getEncounter(id));
      } catch (err) {
        setError(
          err instanceof ApiRequestError ? err.error.message : 'Could not load the consultation.',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [id, applyEncounter]);

  const editable = encounter?.status === 'IN_PROGRESS' && mayWrite;

  /**
   * Save one narrative field on blur.
   *
   * Not per keystroke: that is a request per character on a clinical record, and
   * the failure mode — a half-written sentence saved and then contradicted by
   * the next one — is worse than the alternative. Not a single Save button
   * either: a doctor who closes the tab mid-consultation should not lose the
   * note. Blur is the point at which the doctor has finished a thought.
   */
  async function saveField(key: string, value: string) {
    if (!encounter || !editable) return;

    const current = (encounter[key as keyof Encounter] as string | null) ?? '';
    if (current === value) return;

    try {
      applyEncounter(await api.updateEncounter(encounter.id, { [key]: value }));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not save.');
    }
  }

  async function sign() {
    if (!encounter) return;
    setSigning(true);
    setError(null);
    try {
      applyEncounter(await api.signEncounter(encounter.id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not sign.');
    } finally {
      setSigning(false);
    }
  }

  if (loading) return <p className="text-[14px] text-ink-60">Loading…</p>;

  if (!encounter) {
    return (
      <div className="card p-6">
        <p className="text-[14px] text-coral-text">{error ?? 'Consultation not found.'}</p>
        <Link href="/queue" className="btn-secondary mt-4">
          <IconArrowLeft size={15} />
          Back to the queue
        </Link>
      </div>
    );
  }

  const signed = encounter.status === 'SIGNED';

  return (
    <div className="space-y-5">
      {/* The print stylesheet hides everything except this block. */}
      <PrescriptionPrint encounter={encounter} />

      <div className="no-print space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <Link href="/queue" className="btn-ghost mt-1 !px-2 !py-2" aria-label="Back to queue">
              <IconArrowLeft size={16} />
            </Link>

            <div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Through to the full record — a doctor mid-consultation
                    reaching for "what happened last time" should not have to go
                    back to the queue and search for the patient they are
                    currently sitting with. */}
                <Link
                  href={`/patients/${encounter.patient.id}`}
                  className="font-display text-[26px] font-bold underline-offset-4 hover:text-clinical-text hover:underline"
                >
                  {encounter.patient.name}
                </Link>
                {signed ? (
                  <span className="badge badge-green">
                    <IconLock size={11} /> Signed
                  </span>
                ) : (
                  <span className="badge badge-amber">
                    <IconClock size={11} /> Draft
                  </span>
                )}
                {encounter.appointment.tokenNumber !== null && (
                  <span className="badge badge-neutral">
                    Token {encounter.appointment.tokenNumber}
                  </span>
                )}
              </div>

              <p className="mt-1 text-[13.5px] text-ink-60">
                <span className="font-mono">{encounter.patient.uhid}</span> ·{' '}
                {formatAge(encounter.patient)} {genderInitial(encounter.patient.gender)} ·{' '}
                {encounter.patient.mobile}
                {encounter.patient.bloodGroup !== 'UNKNOWN' &&
                  ` · ${encounter.patient.bloodGroup.replace('_', ' ').toLowerCase()}`}
              </p>
              <p className="text-[12.5px] text-ink-40">
                {encounter.practitioner.prefix} {encounter.practitioner.fullName}
                {signed && encounter.signedAt
                  ? ` · signed ${new Date(encounter.signedAt).toLocaleString('en-IN')}`
                  : savedAt
                    ? ` · saved ${savedAt.toLocaleTimeString('en-IN', { timeStyle: 'short' })}`
                    : ''}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {signed && (
              <button type="button" className="btn-secondary" onClick={() => window.print()}>
                Print prescription
              </button>
            )}
            {editable && (
              <button
                type="button"
                className="btn-primary"
                disabled={signing}
                onClick={() => void sign()}
              >
                <IconCheckCircle size={16} />
                {signing ? 'Signing…' : 'Sign and finish'}
              </button>
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

        {signed && (
          <div className="flex items-start gap-2 rounded-panel border border-green/30 bg-green-soft/40 p-3 text-[13px]">
            <span className="mt-0.5 shrink-0 text-green-text">
              <IconLock size={14} />
            </span>
            <span>
              This consultation is part of the permanent record and can no longer be edited.
              Anything that needs correcting goes in an addendum below.
            </span>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
          <div className="space-y-5">
            <VitalsPanel
              encounter={encounter}
              onSaved={applyEncounter}
              onError={setError}
              editable={Boolean(encounter.status === 'IN_PROGRESS' && can('vitals:write'))}
            />

            <section className="card space-y-4 p-5">
              {NARRATIVE.map((field) => (
                <div key={field.key}>
                  <label htmlFor={field.key} className="mono-label">
                    {field.label}
                  </label>
                  {editable ? (
                    <textarea
                      id={field.key}
                      rows={field.rows}
                      className="field-input mt-1.5 text-[13.5px]"
                      placeholder={field.placeholder}
                      value={narrative[field.key] ?? ''}
                      onChange={(e) => setNarrative({ ...narrative, [field.key]: e.target.value })}
                      onBlur={(e) => void saveField(field.key, e.target.value)}
                    />
                  ) : (
                    <p className="mt-1 whitespace-pre-wrap text-[13.5px]">
                      {encounter[field.key] || <span className="text-ink-20">—</span>}
                    </p>
                  )}
                </div>
              ))}

              <div>
                <label htmlFor="followUpDate" className="mono-label">
                  Follow-up
                </label>
                {editable ? (
                  <input
                    id="followUpDate"
                    type="date"
                    className="field-input mt-1.5 max-w-[200px] text-[13.5px]"
                    value={narrative.followUpDate ?? ''}
                    onChange={(e) => setNarrative({ ...narrative, followUpDate: e.target.value })}
                    onBlur={(e) => void saveField('followUpDate', e.target.value)}
                  />
                ) : (
                  <p className="mt-1 text-[13.5px]">
                    {encounter.followUpDate ? (
                      new Date(encounter.followUpDate).toLocaleDateString('en-IN', {
                        dateStyle: 'medium',
                      })
                    ) : (
                      <span className="text-ink-20">—</span>
                    )}
                  </p>
                )}
              </div>
            </section>
          </div>

          <div className="space-y-5">
            <DiagnosesPanel
              encounter={encounter}
              onSaved={applyEncounter}
              onError={setError}
              editable={Boolean(editable)}
            />

            <PrescriptionsPanel
              encounter={encounter}
              onSaved={applyEncounter}
              onError={setError}
              editable={Boolean(encounter.status === 'IN_PROGRESS' && can('prescription:write'))}
            />

            {(signed || encounter.addenda.length > 0) && (
              <AddendaPanel
                encounter={encounter}
                onSaved={applyEncounter}
                onError={setError}
                canWrite={signed && mayWrite}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
