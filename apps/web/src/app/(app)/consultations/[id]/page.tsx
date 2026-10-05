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
import { DiagnosticOrdersPanel } from '@/components/diagnostic-orders-panel';
import { PreviousVisitsPanel } from '@/components/previous-visits-panel';
import { RecoveryPanel } from '@/components/recovery-panel';
import {
  IconAlert,
  IconArrowLeft,
  IconChat,
  IconCheckCircle,
  IconClock,
  IconLock,
} from '@/components/icons';

/** How often to ask the patient how they are, until the review. docs/10. */
const CHECKIN_OPTIONS = [
  { value: '', label: 'No check-ins' },
  { value: '2', label: 'Every 2 days' },
  { value: '3', label: 'Every 3 days' },
  { value: '7', label: 'Once a week' },
];

/** Narrative fields, saved on blur rather than on every keystroke. */
/**
 * FR-CON-11. Matches the DTO and the database CHECK — three places, because
 * each one is the last line of defence for a different caller.
 */
const NOTE_MAX_LENGTH = 1000;

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
  const [sendOutOpen, setSendOutOpen] = useState(false);
  const [sendOutReason, setSendOutReason] = useState('');
  const [sendingOut, setSendingOut] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [narrative, setNarrative] = useState<Record<string, string>>({});
  const [sendingToPatient, setSendingToPatient] = useState(false);
  const [sentNotice, setSentNotice] = useState<string | null>(null);

  const mayWrite = can('consultation:write');

  const applyEncounter = useCallback((e: Encounter) => {
    setEncounter(e);
    setNarrative({
      chiefComplaint: e.chiefComplaint ?? '',
      historyOfPresentIllness: e.historyOfPresentIllness ?? '',
      examinationFindings: e.examinationFindings ?? '',
      advice: e.advice ?? '',
      prescriptionNote: e.prescriptionNote ?? '',
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
  const noteLength = (narrative.prescriptionNote ?? '').length;

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

  /**
   * Send the patient out for an investigation.
   *
   * The reason is required and goes on the board: the front desk is about to be
   * asked what the patient is waiting for, and "the doctor sent them somewhere"
   * is not an answer.
   */
  async function sendForTests() {
    if (!encounter || !sendOutReason.trim()) return;
    setSendingOut(true);
    setError(null);
    try {
      await api.sendForTests(encounter.appointment.id, sendOutReason.trim());
      setSendOutOpen(false);
      setSendOutReason('');
      applyEncounter(await api.getEncounter(encounter.id));
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not send them for tests.',
      );
    } finally {
      setSendingOut(false);
    }
  }

  /**
   * "The same again", merged into whatever is already on today's list.
   * A drug already there (same name and strength) is not added twice.
   */
  async function carryForward(
    previous: Array<{
      drugName: string;
      strength: string | null;
      form: string | null;
      dose: string;
      frequency: string;
      durationDays: number | null;
    }>,
  ) {
    if (!encounter) return;
    const key = (p: { drugName: string; strength: string | null }) =>
      `${p.drugName.trim().toLowerCase()}|${(p.strength ?? '').trim().toLowerCase()}`;
    const present = new Set(encounter.prescriptions.map(key));

    const today = encounter.prescriptions.map((p) => ({
      ...(p.formularyItemId ? { formularyItemId: p.formularyItemId } : {}),
      drugName: p.drugName,
      ...(p.strength ? { strength: p.strength } : {}),
      ...(p.form ? { form: p.form } : {}),
      dose: p.dose,
      frequency: p.frequency,
      route: p.route,
      ...(p.durationDays ? { durationDays: p.durationDays } : {}),
      ...(p.quantity ? { quantity: p.quantity } : {}),
      ...(p.instructions ? { instructions: p.instructions } : {}),
    }));
    const repeated = previous
      .filter((p) => !present.has(key(p)))
      .map((p) => ({
        drugName: p.drugName,
        ...(p.strength ? { strength: p.strength } : {}),
        ...(p.form ? { form: p.form } : {}),
        dose: p.dose,
        frequency: p.frequency,
        ...(p.durationDays ? { durationDays: p.durationDays } : {}),
      }));

    try {
      applyEncounter(await api.setPrescriptions(encounter.id, [...today, ...repeated]));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not add the medicines.');
      throw err;
    }
  }

  async function saveCheckinInterval(value: string) {
    if (!encounter || !editable) return;
    try {
      applyEncounter(
        await api.updateEncounter(encounter.id, {
          checkInIntervalDays: value === '' ? null : Number(value),
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not save.');
    }
  }

  async function sendToPatient() {
    if (!encounter) return;
    setSendingToPatient(true);
    setError(null);
    try {
      const { status } = await api.sendToPatient(encounter.id);
      const first = encounter.patient.name.trim().split(' ')[0];
      setSentNotice(
        status === 'SENT'
          ? `Sent to ${first} on WhatsApp.`
          : status === 'SKIPPED_NO_CONSENT'
            ? 'Not sent: this patient has not agreed to WhatsApp messages. The front desk can record their consent on their record.'
            : 'The message could not be sent. Print the prescription instead.',
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not send.');
    } finally {
      setSendingToPatient(false);
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
  const awaitingTests = encounter.appointment.status === 'AWAITING_TESTS';

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
                {encounter.practitioner.fullName}
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
            {signed && mayWrite && (
              <button
                type="button"
                className="btn-primary"
                disabled={sendingToPatient}
                onClick={() => void sendToPatient()}
              >
                <IconChat size={16} />
                {sendingToPatient ? 'Sending…' : 'Send to patient on WhatsApp'}
              </button>
            )}
            {/* Sending for an X-ray pauses the visit rather than ending it. The
                note stays a draft, the bill stays as it is, and the patient
                keeps their token — signing here would close a consultation the
                doctor has not finished. */}
            {editable && encounter.appointment.status === 'IN_PROGRESS' && (
              <button
                type="button"
                className="btn-secondary"
                disabled={sendingOut}
                onClick={() => setSendOutOpen(true)}
              >
                Send for tests
              </button>
            )}
            {awaitingTests && (
              <span className="badge badge-amber">
                <IconClock size={11} /> Out for tests
              </span>
            )}
            {editable && (
              <button
                type="button"
                className="btn-primary"
                disabled={signing}
                onClick={() => void sign()}
                title={
                  awaitingTests
                    ? 'Close the visit with what is recorded — for a patient who did not come back'
                    : undefined
                }
              >
                <IconCheckCircle size={16} />
                {signing ? 'Signing…' : 'Sign and finish'}
              </button>
            )}
          </div>
        </header>

        {sendOutOpen && (
          <div className="mt-4 rounded-panel border border-amber/30 bg-amber-soft/40 p-4">
            <p className="mono-label">What are they being sent for?</p>
            <p className="mt-1 text-[13px] text-ink-60">
              The visit stays open and this note stays a draft. They keep their token, and the front
              desk brings them back when they return.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className="field-input min-w-[240px] flex-1"
                value={sendOutReason}
                onChange={(e) => setSendOutReason(e.target.value)}
                maxLength={200}
                placeholder="X-ray — left wrist"
                autoFocus
              />
              <button
                type="button"
                className="btn-primary"
                disabled={sendingOut || sendOutReason.trim().length < 3}
                onClick={() => void sendForTests()}
              >
                {sendingOut ? 'Saving…' : 'Send them'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={sendingOut}
                onClick={() => {
                  setSendOutOpen(false);
                  setSendOutReason('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

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

        {sentNotice && (
          <div
            role="status"
            className="rounded-panel border border-clinical/25 bg-clinical-tint p-3 text-[13px]"
          >
            {sentNotice}
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
            {/* Above the vitals, because "what did I give her last time" is the
                first question of a follow-up and the answer should not be
                below the fold. Renders nothing on a first visit. */}
            {/* How they did since last time, in their own check-ins — the first
                question of a follow-up, answered before they sit down. */}
            <RecoveryPanel encounterId={encounter.id} />

            <PreviousVisitsPanel
              encounterId={encounter.id}
              onCarryForward={
                encounter.status === 'IN_PROGRESS' && can('prescription:write')
                  ? carryForward
                  : undefined
              }
            />

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
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <input
                      id="followUpDate"
                      type="date"
                      className="field-input block max-w-[200px] text-[13.5px]"
                      value={narrative.followUpDate ?? ''}
                      onChange={(e) => setNarrative({ ...narrative, followUpDate: e.target.value })}
                      onBlur={(e) => void saveField('followUpDate', e.target.value)}
                    />
                    {/* Check-ins run until the review, so they need one. */}
                    <select
                      id="checkInIntervalDays"
                      aria-label="WhatsApp check-ins until the review"
                      className="field-input block max-w-[200px] text-[13.5px]"
                      disabled={!narrative.followUpDate}
                      value={
                        encounter.checkInIntervalDays ? String(encounter.checkInIntervalDays) : ''
                      }
                      onChange={(e) => void saveCheckinInterval(e.target.value)}
                    >
                      {CHECKIN_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <p className="field-hint w-full">
                      {narrative.followUpDate
                        ? 'Check-ins ask the patient on WhatsApp about their pain and exercises until the review. Rising pain is flagged to the clinic.'
                        : 'Set a review date to turn on WhatsApp check-ins.'}
                    </p>
                  </div>
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

            {/* FR-CON-11 — the prescription note.
                Its own card DIRECTLY BELOW the medicines, not up with the
                clinical narrative, because that is where the doctor's attention
                already is when writing it. Narveer chose this placement on
                26 Aug 2026, and it is also the likeliest reason `advice` went
                unnoticed: it sits four sections higher up the page. */}
            <section className="card p-5">
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor="prescriptionNote" className="mono-label">
                  Note
                </label>
                {/* Only once it is close enough to matter. A counter on an empty
                    box is noise; a limit discovered at 1000 characters is worse. */}
                {editable && noteLength > NOTE_MAX_LENGTH - 200 && (
                  <span
                    className={`font-mono text-[11px] ${
                      noteLength >= NOTE_MAX_LENGTH ? 'text-coral-text' : 'text-ink-40'
                    }`}
                  >
                    {noteLength} / {NOTE_MAX_LENGTH}
                  </span>
                )}
              </div>

              <p className="field-hint">Prints on the prescription, under Advice.</p>

              {editable ? (
                <textarea
                  id="prescriptionNote"
                  rows={3}
                  maxLength={NOTE_MAX_LENGTH}
                  className="field-input mt-1.5 text-[13.5px]"
                  placeholder="Physiotherapy, precautions, instructions for the pharmacy"
                  value={narrative.prescriptionNote ?? ''}
                  onChange={(e) => setNarrative({ ...narrative, prescriptionNote: e.target.value })}
                  onBlur={(e) => void saveField('prescriptionNote', e.target.value)}
                />
              ) : (
                <p className="mt-1 whitespace-pre-wrap text-[13.5px]">
                  {encounter.prescriptionNote || <span className="text-ink-20">—</span>}
                </p>
              )}
            </section>

            {/* Tests, ordered and read in the same place the question was
                asked. Renders nothing when the clinic has no diagnostic
                department and nothing has been requested. */}
            <DiagnosticOrdersPanel
              appointmentId={encounter.appointment.id}
              encounterId={encounter.id}
              editable={Boolean(editable)}
              externalTestNote={encounter.appointment.externalTestNote}
              onExternalTestNote={(note) =>
                setEncounter((e) =>
                  e ? { ...e, appointment: { ...e.appointment, externalTestNote: note } } : e,
                )
              }
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
