'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, type Appointment, type DayAvailability } from '@/lib/api';
import { formatAge, genderInitial } from '@/lib/format';
import { IconAlert, IconCalendar, IconX } from './icons';

/** Clinic-local YYYY-MM-DD, offset by n days. */
function dateKey(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

const DAYS = Array.from({ length: 14 }, (_, i) => i);

/**
 * Reason codes rather than a free-text box.
 *
 * FR-APT-03 asks for reason codes, and the point is analytics: a clinic wants to
 * know whether slots go unused because patients cancel or because the doctor
 * does. Free text alone gives you a thousand spellings of "not well" and no
 * answer. The optional note carries the detail.
 */
const CANCEL_REASONS = [
  'Patient requested',
  'Patient unwell',
  'Doctor unavailable',
  'Booked in error',
  'Duplicate booking',
  'Patient did not confirm',
];

const RESCHEDULE_REASONS = [
  'Patient requested a different time',
  'Doctor running late',
  'Doctor unavailable',
  'Clinic rescheduled',
];

type Mode = 'reschedule' | 'cancel';

export function AppointmentDialog({
  mode,
  appointment,
  onClose,
  onDone,
}: {
  mode: Mode;
  appointment: Appointment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [date, setDate] = useState(dateKey());
  const [availability, setAvailability] = useState<DayAvailability | null>(null);
  const [slotStart, setSlotStart] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes. Anything that opens over the whole screen must be
  // dismissible from the keyboard — a receptionist mid-flow should never be
  // trapped in a dialog they opened by accident.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const loadAvailability = useCallback(async () => {
    if (mode !== 'reschedule') return;
    try {
      setAvailability(await api.availability(appointment.practitioner.id, date));
      setSlotStart('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load availability.');
    }
  }, [mode, appointment.practitioner.id, date]);

  useEffect(() => {
    void loadAvailability();
  }, [loadAvailability]);

  const reasons = mode === 'cancel' ? CANCEL_REASONS : RESCHEDULE_REASONS;
  const reason = [reasonCode, note.trim()].filter(Boolean).join(' — ');
  const ready = reasonCode !== '' && (mode === 'cancel' || slotStart !== '') && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'cancel') {
        await api.cancelAppointment(appointment.id, reason);
      } else {
        await api.rescheduleAppointment(appointment.id, slotStart, reason);
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] !m-0 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="appt-dialog-title"
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-t-card-lg border border-ink/10 bg-card shadow-lg outline-none sm:rounded-card-lg"
      >
        <header className="flex items-start justify-between gap-3 border-b border-ink/8 bg-bg-soft px-5 py-4">
          <div>
            <p className="mono-label">{mode === 'cancel' ? 'Cancel' : 'Reschedule'}</p>
            <h2 id="appt-dialog-title" className="mt-1 font-display text-[19px] font-bold">
              {appointment.patient.name}
            </h2>
            <p className="text-[12.5px] text-ink-60">
              <span className="font-mono">{appointment.patient.uhid}</span> ·{' '}
              {formatAge(appointment.patient)} {genderInitial(appointment.patient.gender)} ·{' '}
              currently {appointment.localTime} with {appointment.practitioner.fullName}
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost !px-1.5 !py-1.5"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <IconX size={17} />
          </button>
        </header>

        <div className="space-y-5 p-5">
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

          {mode === 'reschedule' && (
            <section>
              <p className="mono-label mb-2">New day and time</p>

              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-2">
                {DAYS.map((offset) => {
                  const key = dateKey(offset);
                  const d = new Date(`${key}T12:00:00Z`);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setDate(key)}
                      className={[
                        'shrink-0 rounded-panel border-[1.5px] px-2.5 py-1.5 text-center transition-colors',
                        date === key
                          ? 'border-clinical bg-clinical text-white'
                          : 'border-ink/10 bg-white hover:border-ink/25',
                      ].join(' ')}
                    >
                      <span className="block font-mono text-[9.5px] uppercase tracking-label opacity-70">
                        {offset === 0
                          ? 'Today'
                          : d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}
                      </span>
                      <span className="block text-[14px] font-bold">
                        {d.toLocaleDateString('en-IN', { day: 'numeric', timeZone: 'UTC' })}
                      </span>
                    </button>
                  );
                })}
              </div>

              {availability === null ? (
                <p className="field-hint">Loading…</p>
              ) : availability.slots.length === 0 ? (
                <div className="flex items-start gap-2 rounded-panel border border-amber/40 bg-amber-soft/40 p-3 text-[13px]">
                  <span className="mt-0.5 shrink-0 text-amber-text">
                    <IconCalendar size={14} />
                  </span>
                  <span>{availability.unavailableReason}</span>
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                  {availability.slots.map((s) => {
                    const full = s.available <= 0;
                    return (
                      <button
                        key={s.startAt}
                        type="button"
                        disabled={full}
                        onClick={() => setSlotStart(s.startAt)}
                        className={[
                          'rounded-tiny border-[1.5px] px-1.5 py-1.5 font-mono text-[12.5px] transition-colors',
                          full
                            ? 'cursor-not-allowed border-ink/8 bg-ink/5 text-ink-20 line-through'
                            : slotStart === s.startAt
                              ? 'border-clinical bg-clinical text-white'
                              : 'border-ink/10 bg-white hover:border-clinical/50',
                        ].join(' ')}
                      >
                        {s.time}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          <section>
            <p className="mono-label mb-2">
              Reason <span className="text-coral">*</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {reasons.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReasonCode(r)}
                  aria-pressed={reasonCode === r}
                  className={[
                    'rounded-pill border-[1.5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                    reasonCode === r
                      ? 'border-clinical bg-clinical text-white'
                      : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25 hover:text-ink',
                  ].join(' ')}
                >
                  {r}
                </button>
              ))}
            </div>

            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="field-input mt-3"
              placeholder="Add a note (optional)"
              maxLength={200}
            />
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-ink/8 bg-bg-soft px-5 py-4">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Keep as it is
          </button>
          <button
            type="button"
            className={mode === 'cancel' ? 'btn-danger' : 'btn-primary'}
            disabled={!ready}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : mode === 'cancel' ? 'Cancel this appointment' : 'Move appointment'}
          </button>
        </footer>
      </div>
    </div>
  );
}
