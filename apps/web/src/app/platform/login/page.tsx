'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { platformApi, PlatformRequestError, type PlatformMfaChallenge } from '@/lib/platform-api';

/**
 * doctorsdesk.in's own sign-in.
 *
 * Visibly not the clinic's. Same product, but this account can create and
 * suspend hospitals, and a screen that looked identical to the one a
 * receptionist uses would be the wrong kind of familiar — somebody would
 * eventually type one password into the other.
 */
export default function PlatformLoginPage() {
  const router = useRouter();

  const [stage, setStage] = useState<'credentials' | 'code' | 'enrol'>('credentials');
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

  return (
    <main className="grid min-h-screen place-items-center bg-[#12161c] p-6 text-white">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/35">
            Platform
          </p>
          <h1 className="mt-1 font-display text-[26px] font-bold">doctorsdesk.in</h1>
          <p className="mt-1 text-[13.5px] text-white/45">
            {stage === 'credentials'
              ? 'Sign in to onboard and manage clinics.'
              : stage === 'enrol'
                ? 'This account needs an authenticator app.'
                : 'Enter the code from your authenticator.'}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-3.5 rounded-card border border-white/10 bg-white/[0.04] p-5"
          noValidate
        >
          {error && (
            <div
              role="alert"
              className="rounded-panel border border-red-400/30 bg-red-400/10 p-3 text-[13px] text-red-200"
            >
              {error}
            </div>
          )}

          {stage === 'credentials' ? (
            <>
              <label className="block">
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/40">
                  Email
                </span>
                <input
                  className="mt-1 w-full rounded-panel border border-white/12 bg-white/5 px-3 py-2 text-[14px] text-white outline-none focus:border-white/35"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/40">
                  Password
                </span>
                <input
                  className="mt-1 w-full rounded-panel border border-white/12 bg-white/5 px-3 py-2 text-[14px] text-white outline-none focus:border-white/35"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              {stage === 'enrol' && challenge?.enrolmentSecret && (
                <div className="rounded-panel border border-amber-300/30 bg-amber-300/10 p-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-amber-200">
                    Add this key to your authenticator
                  </p>
                  <p className="mt-1.5 select-all break-all rounded bg-black/30 px-2 py-1.5 font-mono text-[11.5px] tracking-wide">
                    {challenge.enrolmentSecret}
                  </p>
                </div>
              )}

              <label className="block">
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/40">
                  Authentication code
                </span>
                <input
                  className="mt-1 w-full rounded-panel border border-white/12 bg-white/5 px-3 py-2 text-center font-mono text-[18px] tracking-[0.3em] text-white outline-none focus:border-white/35"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  autoFocus
                />
              </label>
            </>
          )}

          <button
            type="submit"
            className="w-full rounded-pill bg-white px-4 py-2.5 text-[14px] font-semibold text-[#12161c] transition-opacity disabled:opacity-40"
            disabled={busy || (stage !== 'credentials' && totpCode.length !== 6)}
          >
            {busy ? 'Checking…' : stage === 'credentials' ? 'Continue' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-[12px] text-white/25">
          Clinic staff sign in at <span className="font-mono">/login</span>.
        </p>
      </div>
    </main>
  );
}
