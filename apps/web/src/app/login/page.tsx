'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError, type MfaChallenge } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { AuthShell, AuthField, TrustRow, type ClinicBrand } from '@/components/auth-shell';
import { IconAlert, IconBuilding, IconKey, IconLock, IconMail } from '@/components/icons';

type Stage = 'credentials' | 'mfa-code' | 'mfa-enrol';

/**
 * Where the last clinic signed in from this browser is remembered.
 *
 * Not a security decision — the slug is on the sign-in page of a clinic that
 * wants to be recognised, and it grants nothing on its own. It exists so the
 * second visit from a front-desk PC opens on that clinic's own logo instead of
 * a blank page, which is most of what "this is customised for us" feels like in
 * practice.
 */
const LAST_CLINIC_KEY = 'healthcloud.lastClinicSlug';

/** How long to wait after a keystroke before asking the API whose clinic this is. */
const RESOLVE_DEBOUNCE_MS = 400;

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();

  const [stage, setStage] = useState<Stage>('credentials');
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Whose sign-in this is. Null until a slug resolves to a real clinic. */
  const [clinic, setClinic] = useState<ClinicBrand | null>(null);

  /**
   * Restore the last clinic, once.
   *
   * In an effect rather than in `useState`'s initialiser because this component
   * renders on the server first: reading localStorage during render would make
   * the server and client markup disagree, and React would discard the whole
   * tree rather than reconcile it.
   */
  useEffect(() => {
    try {
      const remembered = window.localStorage.getItem(LAST_CLINIC_KEY);
      if (remembered) setTenantSlug(remembered);
    } catch {
      // Private mode, or storage disabled. The page works without it.
    }
  }, []);

  /**
   * Resolve the typed slug to a clinic's name and logo.
   *
   * Debounced, and guarded against the older of two in-flight requests winning:
   * typing "sunrise-clinic" fires several times as it is typed, and a slow
   * early response landing after a fast late one would leave the wrong clinic's
   * logo on screen. The sequence number is what makes that impossible rather
   * than unlikely.
   *
   * The branding is cleared the moment the slug changes, not when the answer
   * comes back. Showing one clinic's mark while somebody types a different
   * clinic's name is the one failure mode worth spending a flicker to avoid.
   */
  const resolveSeq = useRef(0);

  useEffect(() => {
    const slug = tenantSlug.trim().toLowerCase();
    const seq = ++resolveSeq.current;

    setClinic(null);

    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return;

    const timer = setTimeout(() => {
      void api
        .branding(slug)
        .then((branding) => {
          if (seq !== resolveSeq.current) return;
          // Shown as-is, with no attempt to tell "real clinic" from "no such
          // slug". The API answers both in one shape on purpose, and an
          // unclaimed slug resolves to neutral words and the bundled mark —
          // which is exactly what this panel should show for one anyway.
          setClinic({ slug, name: branding.name, logoVersion: branding.logoVersion });
        })
        .catch(() => {
          // A branding lookup that fails must never block signing in.
        });
    }, RESOLVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [tenantSlug]);

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

      // Only remembered once a sign-in actually succeeded, so a typo never
      // becomes the clinic this browser opens on tomorrow.
      try {
        window.localStorage.setItem(LAST_CLINIC_KEY, result.tenant.slug);
      } catch {
        // Nothing to do; the next visit simply starts blank.
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
    <AuthShell clinic={clinic}>
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
            <AuthField
              id="tenantSlug"
              label="Clinic"
              icon={<IconBuilding size={15} />}
              value={tenantSlug}
              onChange={setTenantSlug}
              autoComplete="organization"
              placeholder="your-clinic"
              autoFocus
            />
            <AuthField
              id="email"
              label="Email"
              type="email"
              icon={<IconMail size={15} />}
              value={email}
              onChange={setEmail}
              autoComplete="username"
              placeholder="you@clinic.in"
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

        <button type="submit" className="btn-primary w-full !py-2.5" disabled={busy}>
          {busy ? 'Signing in…' : onCredentials ? 'Sign in' : 'Verify'}
          {!busy && <span aria-hidden="true">→</span>}
        </button>
      </form>

      <TrustRow />
    </AuthShell>
  );
}
