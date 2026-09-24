'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, type Appointment, type QueuePriorityReason } from '@/lib/api';
import { IconAlert, IconX } from './icons';

/**
 * Reason codes in the words the desk would use.
 *
 * Codes, not free text, for the same reason cancellations use them: this field
 * is read by someone deciding whether a jump was legitimate, and "urgent!!"
 * cannot be counted.
 */
export const PRIORITY_REASONS: Array<{ key: QueuePriorityReason; label: string }> = [
  { key: 'BACK_FROM_TESTS', label: 'Back with a report' },
  { key: 'EMERGENCY', label: 'Emergency' },
  { key: 'FRAIL_OR_DISTRESSED', label: 'Frail or in distress' },
  { key: 'DOCTOR_REQUESTED', label: 'Doctor asked for them' },
  { key: 'CLINIC_ERROR', label: 'We lost their turn' },
];

export function priorityLabel(priority: NonNullable<Appointment['priority']>): string {
  const reason =
    PRIORITY_REASONS.find((r) => r.key === priority.reasonCode)?.label ?? priority.reasonCode;
  return priority.note ? `${reason} — ${priority.note}` : reason;
}

/**
 * Two decisions that share a shape: where a returning patient lands, and
 * whether a waiting patient jumps.
 *
 * They are one dialog because they write the same three columns and because the
 * desk thinks of them as the same act — "this person goes next" — arrived at
 * from two different directions.
 */
export function QueuePriorityDialog({
  mode,
  appointment,
  onClose,
  onDone,
}: {
  mode: 'return' | 'prioritise';
  appointment: Appointment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reasonCode, setReasonCode] = useState<QueuePriorityReason>(
    mode === 'return' ? 'BACK_FROM_TESTS' : 'EMERGENCY',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

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

  async function submit(seeNext: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'return') {
        await api.returnFromTests(appointment.id, seeNext, note.trim() || undefined);
      } else {
        await api.prioritise(appointment.id, reasonCode, note.trim() || undefined);
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'That did not work.');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] !m-0 grid place-items-center bg-ink/30 p-4">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'return' ? 'Back at the desk' : 'Move to the front'}
        className="card w-full max-w-md overflow-hidden outline-none"
      >
        <header className="flex items-start gap-3 border-b border-ink/8 bg-bg-soft px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="mono-label">
              {mode === 'return' ? 'Back at the desk' : 'Move to the front'}
            </p>
            <p className="mt-1 truncate font-display text-[17px] font-bold">
              Token {appointment.tokenNumber} · {appointment.patient.name}
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost !px-2 !py-1"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <IconX size={16} />
          </button>
        </header>

        <div className="space-y-4 p-5">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-panel border border-coral/30 bg-coral/8 p-3 text-[13px] text-coral-text"
            >
              <span className="mt-0.5 shrink-0">
                <IconAlert size={14} />
              </span>
              <span>{error}</span>
            </div>
          )}

          {mode === 'return' && appointment.sentOut && (
            <p className="text-[13.5px] text-ink-60">
              Sent for <span className="font-semibold text-ink">{appointment.sentOut.reason}</span>.
              They keep this token, their bill and the note the doctor started.
            </p>
          )}

          {mode === 'prioritise' && (
            <div>
              <p className="mono-label mb-2">
                Why are they going ahead? <span className="text-coral">*</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITY_REASONS.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => setReasonCode(r.key)}
                    aria-pressed={reasonCode === r.key}
                    className={[
                      'rounded-pill border-[1.5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                      reasonCode === r.key
                        ? 'border-clinical bg-clinical text-white'
                        : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25',
                    ].join(' ')}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="block">
            <span className="field-label">Note (optional)</span>
            <input
              className="field-input mt-1"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              placeholder={mode === 'return' ? 'X-ray report in hand' : 'Chest pain'}
            />
          </label>

          {/* The whole decision, as two buttons. "Somewhere in the middle" is
              deliberately not offered — an arbitrary insert position produces an
              order nobody can explain to the person it disadvantaged. */}
          {mode === 'return' ? (
            <div className="space-y-2">
              <button
                type="button"
                className="btn-primary w-full"
                disabled={busy}
                onClick={() => void submit(true)}
              >
                {busy ? 'Saving…' : 'See them next'}
              </button>
              <button
                type="button"
                className="btn-secondary w-full"
                disabled={busy}
                onClick={() => void submit(false)}
              >
                Add to the queue normally
              </button>
              <p className="field-hint">
                They have already waited once, so “see them next” is the usual choice. Either way
                the patient with the doctor is not interrupted.
              </p>
            </div>
          ) : (
            <button
              type="button"
              className="btn-primary w-full"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {busy ? 'Saving…' : 'Move to the front'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
