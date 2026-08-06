'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError, type MfaChallenge } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { AuthShell, TrustRow } from '@/components/auth-shell';
import { IconAlert, IconBuilding, IconKey, IconLock, IconMail } from '@/components/icons';

type Stage = 'credentials' | 'mfa-code' | 'mfa-enrol';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();

  const [stage, setStage] = useState<Stage>('credentials');
  const [tenantSlug, setTenantSlug] = useState('sunrise-clinic');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result =
        stage === 'mfa-enrol'
          ? await api.confirmMfa({ tenantSlug, email, password, totpCode })
          : await api.login({ tenantSlug, email, password, ...(totpCode ? { totpCode } : {}) });

      if ('mfaRequired' in result) {
        setChallenge(result);
        setStage(result.enrolmentSecret ? 'mfa-enrol' : 'mfa-code');
        setTotpCode('');
        return;
      }

      await refresh();
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function backToCredentials() {
    setStage('credentials');
    setChallenge(null);
    setTotpCode('');
    setError(null);
  }

  const onCredentials = stage === 'credentials';

  return (
    <AuthShell>
      <div className="mb-5 flex items-center justify-between">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-green" />
          <span className="h-2 w-2 rounded-full bg-amber" />
          <span className="h-2 w-2 rounded-full bg-coral" />
        </div>
        <p className="mono-label">Secure sign-in</p>
      </div>

      <h1 className="font-display text-[26px] font-bold">
        {onCredentials ? (
          <>
            Welcome <em className="accent-words">back</em>
          </>
        ) : (
          <>
            One more <em className="accent-words">step</em>
          </>
        )}
      </h1>
      <p className="mt-1 text-[13.5px] text-ink-60">
        {onCredentials
          ? 'Sign in with your clinic account to continue.'
          : stage === 'mfa-enrol'
            ? 'Your role requires two-factor authentication.'
            : 'Enter the code from your authenticator app.'}
      </p>

      <form onSubmit={submit} className="mt-5 space-y-3.5" noValidate>
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3 py-2 text-[12.5px] text-coral-text"
          >
            <span className="mt-0.5 shrink-0">
              <IconAlert size={13} />
            </span>
            <span>{error}</span>
          </div>
        )}

        {onCredentials ? (
          <>
            <Field
              id="tenantSlug"
              label="Clinic"
              icon={<IconBuilding size={15} />}
              value={tenantSlug}
              onChange={setTenantSlug}
              autoComplete="organization"
              placeholder="sunrise-clinic"
            />
            <Field
              id="email"
              label="Email"
              type="email"
              icon={<IconMail size={15} />}
              value={email}
              onChange={setEmail}
              autoComplete="username"
              placeholder="you@clinic.in"
              autoFocus
            />
            <Field
              id="password"
              label="Password"
              type="password"
              icon={<IconLock size={15} />}
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </>
        ) : (
          /* Past the credentials step the three fields collapse to one line.
             Re-showing them read-only wastes the vertical space the code field
             and enrolment key need, and reads as clutter — the user has already
             answered those questions. */
          <div className="flex items-center justify-between gap-3 rounded-panel border border-ink/10 bg-bg-soft px-3 py-2">
            <span className="min-w-0">
              <span className="mono-label block">Signing in as</span>
              <span className="block truncate text-[13px] font-semibold text-ink">{email}</span>
              <span className="block truncate font-mono text-[11px] text-ink-40">{tenantSlug}</span>
            </span>
            <button
              type="button"
              onClick={backToCredentials}
              className="shrink-0 text-[12px] font-semibold text-clinical-text underline underline-offset-2 hover:text-clinical"
            >
              Change
            </button>
          </div>
        )}

        {stage === 'mfa-enrol' && challenge?.enrolmentSecret && (
          <div className="rounded-panel border border-amber/40 bg-amber-soft/50 px-3 py-2.5">
            <p className="mono-label !text-amber-text">Add this key to your authenticator</p>
            <p className="mt-1.5 select-all break-all rounded-tiny bg-white px-2 py-1.5 font-mono text-[11.5px] tracking-wide text-ink">
              {challenge.enrolmentSecret}
            </p>
          </div>
        )}

        {!onCredentials && (
          <Field
            id="totpCode"
            label="Authentication code"
            icon={<IconKey size={15} />}
            value={totpCode}
            onChange={(v) => setTotpCode(v.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            mono
          />
        )}

        <button type="submit" className="btn-primary w-full !py-2.5" disabled={busy}>
          {busy ? 'Signing in…' : onCredentials ? 'Sign in' : 'Verify'}
          {!busy && <span aria-hidden="true">→</span>}
        </button>
      </form>

      <TrustRow />

      {/* Seeded-demo credentials. Removed when real users are invited. */}
      <details className="mt-4 rounded-panel border border-ink/10 bg-bg-soft/70 px-3 py-2">
        <summary className="mono-label cursor-pointer select-none">Demo accounts</summary>
        <ul className="mt-2 space-y-1 font-mono text-[11.5px] text-ink-60">
          <li>reception@demo.local — registers</li>
          <li>nurse@demo.local — read only</li>
          <li>admin@demo.local — needs 2FA</li>
        </ul>
        <p className="mt-1.5 text-[11px] text-ink-40">
          Password <span className="font-mono">demo1234</span> · also{' '}
          <span className="font-mono">lotus-polyclinic</span>
        </p>
      </details>
    </AuthShell>
  );
}

function Field({
  id,
  label,
  icon,
  value,
  onChange,
  type = 'text',
  mono = false,
  ...rest
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'id'>) {
  return (
    <div>
      <label htmlFor={id} className="field-label !mb-1">
        {label}
      </label>
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-3.5 text-ink-20">{icon}</span>
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`field-input-icon !py-2 ${mono ? 'font-mono tracking-[0.3em]' : ''}`}
          required
          {...rest}
        />
      </div>
    </div>
  );
}
