'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { IconAlert, IconKey } from '@/components/icons';

/** Matches the server. Length is the property that resists an offline attack. */
const MIN_LENGTH = 12;

/**
 * Choosing a real password.
 *
 * Reachable two ways: voluntarily from the account menu, and compulsorily — a
 * user whose password was handed to them by somebody else is sent here and
 * cannot go anywhere until they have chosen their own.
 */
export default function ChangePasswordPage() {
  const { session, refresh } = useAuth();
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forced = session?.mustChangePassword ?? false;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== newPassword;
  const ready =
    newPassword.length >= MIN_LENGTH && confirmation === newPassword && !!currentPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;

    setBusy(true);
    setError(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      // Re-read the session so the gate sees the cleared flag.
      await refresh();
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not change it.');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="card overflow-hidden">
        <div className="border-b border-ink/8 bg-bg-soft px-5 py-4">
          <p className="mono-label">{forced ? 'Before you start' : 'Your account'}</p>
          <h1 className="mt-1 font-display text-[22px] font-bold">Choose a password</h1>
          <p className="mt-1 text-[13.5px] text-ink-60">
            {forced
              ? 'The password you were given was temporary, and somebody else has seen it. Pick your own to carry on.'
              : 'You will stay signed in here. Every other device gets signed out.'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3.5 p-5" noValidate>
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

          <label className="block">
            <span className="field-label">
              {forced ? 'The password you were given' : 'Current password'}
            </span>
            <input
              className="field-input mt-1"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoFocus
            />
          </label>

          <label className="block">
            <span className="field-label">New password</span>
            <input
              className="field-input mt-1"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            {/* No symbol-and-a-digit rule: it mostly produces Password1! and a
                sticky note. Length is what actually resists an attack. */}
            <span className={`field-hint ${tooShort ? '!text-coral-text' : ''}`}>
              At least {MIN_LENGTH} characters. A few words you will remember beats one clever word.
            </span>
          </label>

          <label className="block">
            <span className="field-label">Type it again</span>
            <input
              className="field-input mt-1"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
            {mismatch && <span className="field-hint !text-coral-text">These do not match.</span>}
          </label>

          <button type="submit" className="btn-primary w-full" disabled={busy || !ready}>
            <IconKey size={16} />
            {busy ? 'Saving…' : 'Save and continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
