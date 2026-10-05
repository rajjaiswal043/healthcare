'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, type PatientMessage } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { IconChat } from '@/components/icons';

const KIND: Record<PatientMessage['kind'], string> = {
  TOKEN_ISSUED: 'Token',
  LEAVE_NOW: 'Time to leave',
  CHECKIN_REQUEST: 'Check-in',
  REVIEW_REMINDER: 'Review reminder',
  PRESCRIPTION: 'Prescription',
};

/**
 * WhatsApp for one patient — docs/10.
 *
 * The switch records consent (a new consent row each time, never an edit), and
 * the list answers the question the front desk is actually asked: "did the
 * clinic tell me?". A message skipped for want of consent is listed too, so the
 * answer to "why not" is on the screen.
 */
export function PatientMessagesPanel({
  patientId,
  onConsentChanged,
}: {
  patientId: string;
  onConsentChanged?: () => void;
}) {
  const { can } = useAuth();
  const mayRecord = can('consent:write');

  const [messages, setMessages] = useState<PatientMessage[] | null>(null);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.patientMessages(patientId);
      setMessages(res.messages);
      setConsent(res.communicationsConsent);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load messages.');
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle() {
    if (consent === null) return;
    setSaving(true);
    setError(null);
    try {
      await api.setCommunicationsConsent(patientId, !consent);
      await load();
      onConsentChanged?.();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not record consent.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="mono-label flex items-center gap-1.5">
          <IconChat size={13} />
          WhatsApp
        </p>
        {consent !== null && (
          <span className={consent ? 'badge-green' : 'badge-neutral'}>
            {consent ? 'Agreed' : 'Not agreed'}
          </span>
        )}
      </div>

      <p className="mt-2 text-[13px] text-ink-60">
        Their token and live place in line, a message when it is time to leave, recovery check-ins
        and review reminders.
      </p>

      {mayRecord && consent !== null && (
        <button
          type="button"
          className={consent ? 'btn-secondary mt-3 text-[13px]' : 'btn-primary mt-3 text-[13px]'}
          disabled={saving}
          onClick={() => void toggle()}
        >
          {saving
            ? 'Saving…'
            : consent
              ? 'They no longer want messages'
              : 'They agree to WhatsApp messages'}
        </button>
      )}

      {error && <p className="field-error">{error}</p>}

      {messages && messages.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-ink/8 pt-3">
          {messages.slice(0, 8).map((m) => (
            <li key={m.id} className="text-[12.5px]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{KIND[m.kind]}</span>
                <span className="text-ink-40">
                  {new Date(m.createdAt).toLocaleString('en-IN', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </div>
              {m.status === 'SENT' ? (
                <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-ink-60">{m.body}</p>
              ) : (
                <p className="mt-0.5 text-amber-text">
                  {m.status === 'SKIPPED_NO_CONSENT'
                    ? 'Not sent: no WhatsApp consent at the time.'
                    : 'Could not be sent.'}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
