'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { platformApi, PlatformRequestError, type PlatformMfaChallenge } from '@/lib/platform-api';
import { AuthShell, AuthField, TrustRow } from '@/components/auth-shell';
import { IconAlert, IconKey, IconLock, IconMail } from '@/components/icons';

type Stage = 'credentials' | 'code' | 'enrol';

/**
 * doctorsdesk.in's own sign-in.
 *
 * The same shell, tokens, fields and colours as the clinic's, by Narveer's
 * decision on 25 Aug 2026 — the first version was hand-rolled dark and belonged
 * to no design system, and a middle version kept a dark brand panel that still
 * read as a different product.
 *
 * So the only things separating this from /login are the wordmark, the
 * "Platform" chip and the footer line. That is thinner than it was: this
 * account can create and suspend hospitals, and somebody with both tabs open
 * now has text rather than colour to tell them which password they are typing.
 */
export default function PlatformLoginPage() {
  const router = useRouter();

  const [stage, setStage] = useState<Stage>('credentials');
  const [challenge, setChallenge] = useState<PlatformMfaChallenge | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result =
        stage === 'enrol'
          ? await platformApi.confirmMfa({ email, password, totpCode })
          : await platformApi.login({ email, password, ...(totpCode ? { totpCode } : {}) });

      if ('mfaRequired' in result) {
        setChallenge(result);
        setStage(result.enrolmentSecret ? 'enrol' : 'code');
        setTotpCode('');
        return;
      }

      router.replace('/platform');
    } catch (err) {
      setError(err instanceof PlatformRequestError ? err.error.message : 'Could not sign in.');
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
    <AuthShell variant="platform">
      {/* The chip earns its place. With the brand panel now identical to the
          clinic's, it is one of only two things on screen saying which console
          this is. */}
      <div className="mb-5 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-pill bg-clinical-soft px-2.5 py-0.5">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-clinical" />
          <span className="mono-label !text-clinical-text">Platform</span>
        </span>
        <p className="mono-label">Secure sign-in</p>
      </div>

      <h1 className="font-display text-[26px] font-bold">
        {onCredentials ? (
          <>
            Platform <em className="accent-words">console</em>
          </>
        ) : (
          <>
            One more <em className="accent-words">step</em>
          </>
        )}
      </h1>
      <p className="mt-1 text-[13.5px] text-ink-60">
        {onCredentials
          ? 'Sign in to onboard and manage clinics.'
          : stage === 'enrol'
            ? 'This account needs an authenticator app.'
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
            <AuthField
              id="email"
              label="Email"
              type="email"
              icon={<IconMail size={15} />}
              value={email}
              onChange={setEmail}
              autoComplete="username"
              placeholder="you@doctorsdesk.in"
              autoFocus
            />
            <AuthField
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
          /* Same reasoning as the clinic screen: past the credentials step the
             email collapses to one line, because the code field and the
             enrolment key need the vertical space more than a read-only copy of
             a question already answered. */
          <div className="flex items-center justify-between gap-3 rounded-panel border border-ink/10 bg-bg-soft px-3 py-2">
            <span className="min-w-0">
              <span className="mono-label block">Signing in as</span>
              <span className="block truncate text-[13px] font-semibold text-ink">{email}</span>
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

        {stage === 'enrol' && challenge?.enrolmentSecret && (
          <div className="rounded-panel border border-amber/40 bg-amber-soft/50 px-3 py-2.5">
            <p className="mono-label !text-amber-text">Add this key to your authenticator</p>
            <p className="mt-1.5 select-all break-all rounded-tiny bg-white px-2 py-1.5 font-mono text-[11.5px] tracking-wide text-ink">
              {challenge.enrolmentSecret}
            </p>
          </div>
        )}

        {!onCredentials && (
          <AuthField
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

        <button
          type="submit"
          className="btn-primary w-full !py-2.5"
          disabled={busy || (!onCredentials && totpCode.length !== 6)}
        >
          {busy ? 'Signing in…' : onCredentials ? 'Sign in' : 'Verify'}
          {!busy && <span aria-hidden="true">→</span>}
        </button>
      </form>

      <TrustRow variant="platform" />

      <p className="mt-4 text-center text-[12px] text-ink-40">
        Clinic staff sign in at <span className="font-mono text-ink-60">/login</span>
      </p>
    </AuthShell>
  );
}
