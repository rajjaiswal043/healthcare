'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError, type MfaChallenge } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import type { ClinicBrand } from '@/components/auth-shell';
import { ClinicLogo } from '@/components/clinic-logo';
import { ConsoleMark } from '@/components/console-mark';
import {
  IconAlert,
  IconArrowLeft,
  IconBuilding,
  IconCheck,
  IconEyeOff,
  IconKey,
  IconLock,
  IconMail,
  IconShield,
} from '@/components/icons';

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

  // Presentation only: neither changes what is sent to the server.
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

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

  /**
   * Layout.
   *
   * HEIGHT IS STILL A HARD CONSTRAINT (scripts/check-viewport-fit.mjs): the page
   * is exactly one viewport tall and never scrolls. The form column scrolls
   * internally as a last resort, and anything decorative — the floating cards,
   * the help line — drops out on short screens before the form is squeezed.
   *
   * The brand panel keeps the white-label rule from auth-shell.tsx: once the
   * slug resolves it wears the CLINIC's logo and name, and before that only the
   * neutral "Clinic Console" mark.
   */
  return (
    <main className="relative flex h-[100dvh] w-full overflow-hidden bg-bg lg:gap-3 lg:p-3">
      <style dangerouslySetInnerHTML={{ __html: LOGIN_CSS }} />

      {/* Soft colour behind the form, across the whole page so it has no edge */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="auth-blob absolute -right-32 -top-40 h-[420px] w-[420px] rounded-full bg-clinical-soft/70 blur-3xl" />
        <div className="auth-blob-slow absolute -bottom-48 right-[30%] h-[420px] w-[420px] rounded-full bg-amber-soft/50 blur-3xl" />
      </div>

      <BrandPanel clinic={clinic} />

      <section className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 px-5 pt-4 sm:px-8 sm:pt-6">
          <Link
            href="/welcome"
            className="group inline-flex h-9 items-center gap-2 rounded-pill border border-ink/10 bg-white/70 pl-2 pr-3.5 text-[13px] font-medium text-ink-60 shadow-sm backdrop-blur transition-all hover:border-ink/20 hover:text-ink"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-bg-soft transition-transform group-hover:-translate-x-0.5">
              <IconArrowLeft size={13} />
            </span>
            Back to home
          </Link>

          {/* Compact lockup where the brand panel is hidden */}
          <span className="flex min-w-0 items-center gap-2 lg:hidden">
            {clinic ? (
              <>
                <ClinicLogo clinic={clinic} size={26} />
                <span className="truncate font-display text-[15px] font-extrabold">
                  {clinic.name}
                </span>
              </>
            ) : (
              <>
                <ConsoleMark size={26} />
                <span className="hidden whitespace-nowrap font-display text-[15px] font-extrabold min-[380px]:inline">
                  Clinic <span className="text-clinical">Console</span>
                </span>
              </>
            )}
          </span>

          <span className="mono-label hidden items-center gap-1.5 lg:flex">
            <span className="text-clinical">
              <IconLock size={12} />
            </span>
            Secure sign-in
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-4 sm:px-8">
          <div key={stage} className="login-rise w-full max-w-[384px]">
            {!onCredentials && (
              <span className="mb-4 grid h-12 w-12 place-items-center rounded-panel bg-clinical text-white shadow-[0_10px_24px_-10px_rgba(15,118,110,0.8)]">
                <IconShield size={22} />
              </span>
            )}

            <h1 className="text-[clamp(28px,3.4vw,36px)] font-extrabold leading-[1.05] tracking-[-0.03em]">
              {onCredentials ? (
                <>
                  Welcome <span className="text-clinical">back</span>
                </>
              ) : (
                <>
                  One more <span className="text-clinical">step</span>
                </>
              )}
            </h1>
            <p className="mt-2 text-[14.5px] text-ink-60">
              {onCredentials
                ? 'Sign in with your clinic account to open the console.'
                : stage === 'mfa-enrol'
                  ? 'Your role requires two-factor authentication. Set it up once and you’re in.'
                  : 'Enter the six-digit code from your authenticator app.'}
            </p>

            <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
              {error && (
                <div
                  role="alert"
                  className="login-shake flex items-start gap-2.5 rounded-[12px] border border-coral/30 bg-coral/8 px-3.5 py-2.5 text-[13px] text-coral-text"
                >
                  <span className="mt-0.5 shrink-0">
                    <IconAlert size={14} />
                  </span>
                  <span>{error}</span>
                </div>
              )}

              {onCredentials ? (
                <>
                  <LoginField
                    id="tenantSlug"
                    label="Clinic"
                    icon={<IconBuilding size={16} />}
                    value={tenantSlug}
                    onChange={setTenantSlug}
                    autoComplete="organization"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="your-clinic"
                    autoFocus
                    trailing={
                      clinic ? (
                        <span
                          className="login-pop flex h-8 items-center rounded-[8px] bg-white px-1"
                          title={clinic.name}
                        >
                          <ClinicLogo clinic={clinic} size={24} alt={clinic.name} />
                        </span>
                      ) : null
                    }
                  />
                  <LoginField
                    id="email"
                    label="Email"
                    type="email"
                    icon={<IconMail size={16} />}
                    value={email}
                    onChange={setEmail}
                    autoComplete="username"
                    placeholder="you@clinic.in"
                  />
                  <LoginField
                    id="password"
                    label="Password"
                    type={showPassword ? 'text' : 'password'}
                    icon={<IconLock size={16} />}
                    value={password}
                    onChange={setPassword}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    onKeyDown={(e) => setCapsLock(e.getModifierState('CapsLock'))}
                    onKeyUp={(e) => setCapsLock(e.getModifierState('CapsLock'))}
                    onBlur={() => setCapsLock(false)}
                    aside={
                      capsLock ? (
                        <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber-text">
                          Caps Lock is on
                        </span>
                      ) : null
                    }
                    trailing={
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                        className="grid h-8 w-8 place-items-center rounded-[8px] text-ink-40 transition-colors hover:bg-ink/5 hover:text-ink"
                      >
                        {showPassword ? <IconEyeOff size={16} /> : <EyeGlyph />}
                      </button>
                    }
                  />
                </>
              ) : (
                /* Past the credentials step the three fields collapse to one line.
                   Re-showing them read-only wastes the vertical space the code field
                   and enrolment key need, and reads as clutter — the user has already
                   answered those questions. */
                <div className="flex items-center justify-between gap-3 rounded-[14px] border border-ink/10 bg-white/80 px-3.5 py-2.5 shadow-sm">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-clinical-soft font-display text-[13px] font-bold uppercase text-clinical-text">
                      {email.charAt(0) || '·'}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">
                        {email}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-ink-40">
                        {tenantSlug}
                      </span>
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={backToCredentials}
                    className="shrink-0 rounded-pill px-2.5 py-1 text-[12.5px] font-semibold text-clinical-text transition-colors hover:bg-clinical-tint"
                  >
                    Change
                  </button>
                </div>
              )}

              {stage === 'mfa-enrol' && challenge?.enrolmentSecret && (
                <div className="rounded-[14px] border border-amber/40 bg-amber-soft/50 px-3.5 py-3">
                  <p className="mono-label !text-amber-text">Add this key to your authenticator</p>
                  <p className="mt-2 select-all break-all rounded-[10px] bg-white px-2.5 py-2 font-mono text-[12px] tracking-wide text-ink">
                    {challenge.enrolmentSecret}
                  </p>
                </div>
              )}

              {!onCredentials && (
                <div>
                  <label
                    htmlFor="totpCode"
                    className="mb-1.5 block text-[12.5px] font-semibold text-ink-60"
                  >
                    Authentication code
                  </label>
                  <div className="group relative">
                    <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-20 transition-colors group-focus-within:text-clinical">
                      <IconKey size={18} />
                    </span>
                    <input
                      id="totpCode"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                      className="h-14 w-full rounded-[14px] border border-ink/12 bg-white/90 pl-12 pr-4 text-center font-mono text-[24px] font-semibold tracking-[0.5em] text-ink shadow-[0_1px_2px_rgba(60,50,35,0.04)] outline-none transition-all placeholder:text-ink-20/60 hover:border-ink/25 focus:border-clinical focus:bg-white focus:ring-4 focus:ring-clinical/12 focus-visible:outline-none"
                    />
                  </div>
                  <div className="mt-2 flex gap-1" aria-hidden="true">
                    {Array.from({ length: 6 }, (_, i) => (
                      <span
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          i < totpCode.length ? 'bg-clinical' : 'bg-ink/10'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="group relative mt-2 inline-flex h-12 w-full items-center justify-center gap-2.5 overflow-hidden rounded-pill bg-clinical text-[15px] font-semibold text-white shadow-[0_12px_28px_-12px_rgba(15,118,110,0.9)] transition-all hover:bg-clinical-deep active:translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 -left-1/2 w-1/3 -skew-x-12 bg-white/15 transition-all duration-700 group-hover:left-[120%]"
                />
                {busy ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    {onCredentials ? 'Signing in…' : 'Verifying…'}
                  </>
                ) : (
                  <>
                    {onCredentials ? 'Sign in' : 'Verify and continue'}
                    <span className="transition-transform group-hover:translate-x-0.5">
                      <ArrowGlyph />
                    </span>
                  </>
                )}
              </button>
            </form>

            <p className="mt-6 text-center text-[13px] text-ink-40 [@media(max-height:700px)]:hidden">
              {onCredentials
                ? 'Forgot your password or new to the clinic? Your administrator can set up or reset your account.'
                : 'Lost access to your authenticator? Ask your clinic administrator to reset it.'}
            </p>
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-center gap-x-5 gap-y-1 px-5 pb-4 sm:px-8 sm:pb-6">
          {[
            { icon: <IconShield size={12} />, label: 'DPDP-ready' },
            { icon: <IconLock size={12} />, label: 'Encrypted' },
            { icon: <IconCheck size={12} />, label: 'Audited' },
          ].map((t) => (
            <span key={t.label} className="mono-label flex items-center gap-1.5">
              <span className="text-clinical">{t.icon}</span>
              {t.label}
            </span>
          ))}
        </footer>
      </section>
    </main>
  );
}

/* -------------------------------------------------------------------------- */

const LOGIN_CSS = `
@keyframes login-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.login-rise{animation:login-rise .6s cubic-bezier(.2,.7,.2,1) both}
@keyframes login-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
.login-pop{animation:login-pop .35s cubic-bezier(.3,1.4,.5,1) both}
@keyframes login-shake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(2px)}30%,50%,70%{transform:translateX(-4px)}40%,60%{transform:translateX(4px)}}
.login-shake{animation:login-shake .45s both}
@keyframes login-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.login-float{animation:login-float 7s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.login-float{animation:none}}
`;

/**
 * One field. Local to this page so the platform sign-in (which still uses
 * AuthField) is untouched. `trailing` sits inside the input on the right —
 * the password toggle, the clinic's logo — and `aside` sits on the label row,
 * which is where the Caps Lock warning goes so it costs no height.
 */
function LoginField({
  id,
  label,
  icon,
  value,
  onChange,
  trailing,
  aside,
  type = 'text',
  ...rest
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  trailing?: React.ReactNode;
  aside?: React.ReactNode;
  type?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'id'>) {
  return (
    <div>
      <div className="mb-1.5 flex min-h-[20px] items-center justify-between gap-2">
        <label htmlFor={id} className="text-[12.5px] font-semibold text-ink-60">
          {label}
        </label>
        {aside}
      </div>
      <div className="group relative flex items-center">
        <span className="pointer-events-none absolute left-3.5 text-ink-20 transition-colors group-focus-within:text-clinical">
          {icon}
        </span>
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          className={`h-12 w-full rounded-[14px] border border-ink/12 bg-white/90 pl-11 text-[14.5px] text-ink shadow-[0_1px_2px_rgba(60,50,35,0.04)] outline-none transition-all placeholder:text-ink-20 hover:border-ink/25 focus:border-clinical focus:bg-white focus:ring-4 focus:ring-clinical/12 focus-visible:outline-none ${
            trailing ? 'pr-12' : 'pr-4'
          }`}
          {...rest}
        />
        {trailing && <span className="absolute right-2 flex items-center">{trailing}</span>}
      </div>
    </div>
  );
}

/**
 * The left half. Deep teal, a quiet grid, and a few floating "moments" from a
 * clinic day. Hidden below `lg`, where stacking it above the form would force
 * the page to scroll.
 */
function BrandPanel({ clinic }: { clinic: ClinicBrand | null }) {
  const roles = [
    { label: 'Front desk', color: '#8fa0e6' },
    { label: 'Doctor', color: '#b894e6' },
    { label: 'Nurse', color: '#e693bb' },
    { label: 'Owner', color: '#d9ad85' },
    { label: 'Admin', color: '#b5bcc7' },
  ];

  return (
    <aside className="relative isolate hidden w-[46%] max-w-[700px] shrink-0 flex-col justify-between overflow-hidden rounded-[28px] bg-clinical-deep p-10 text-white lg:flex xl:p-12">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-[0.12]"
        style={{
          backgroundImage:
            'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse 80% 70% at 30% 40%, black 20%, transparent 80%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 70% at 30% 40%, black 20%, transparent 80%)',
        }}
      />
      <div
        aria-hidden="true"
        className="auth-blob absolute -right-32 -top-24 -z-10 h-[420px] w-[420px] rounded-full bg-[#18a092]/60 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="auth-blob-slow absolute -bottom-40 -left-24 -z-10 h-[420px] w-[420px] rounded-full bg-amber/25 blur-3xl"
      />

      {/* Lockup: the clinic once known, the neutral mark before that */}
      <div className="flex items-center gap-3">
        {clinic ? (
          <>
            <span className="login-pop grid h-11 min-w-11 place-items-center rounded-[12px] bg-white px-1.5 shadow-sm">
              <ClinicLogo clinic={clinic} size={30} alt="" />
            </span>
            <span className="truncate font-display text-[20px] font-extrabold tracking-display">
              {clinic.name}
            </span>
          </>
        ) : (
          <>
            <ConsoleMark size={36} light />
            <span className="font-display text-[20px] font-extrabold tracking-display">
              Clinic Console
            </span>
          </>
        )}
      </div>

      <div>
        <p className="inline-flex items-center gap-2 rounded-pill border border-white/15 bg-white/10 px-3 py-1 font-mono text-[10.5px] font-medium uppercase tracking-label text-white/80 backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-[#5fd6c6]" />
          Staff sign-in
        </p>
        <h2 className="mt-5 max-w-[460px] text-[clamp(30px,3vw,46px)] font-extrabold leading-[1.04] tracking-[-0.03em] text-white">
          Every patient, every queue, <span className="text-[#7fe0d2]">one calm console.</span>
        </h2>
        <p className="mt-4 max-w-[400px] text-[15px] leading-relaxed text-white/65">
          Registration, consultations, prescriptions and billing, right where you left them.
        </p>

        {/* Moments from a clinic day. Decorative, and first to go on short screens. */}
        <div
          aria-hidden="true"
          className="relative mt-10 h-[176px] max-w-[440px] [@media(max-height:800px)]:hidden"
        >
          <GlassCard className="login-float left-0 top-0 w-[270px]">
            <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[#5fd6c6]/20 font-mono text-[13px] font-bold text-[#7fe0d2]">
              19
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[13.5px] font-semibold">Token 19 · In chamber</span>
              <span className="block text-[11.5px] text-white/60">Dr. Kiran Rao · Room 2</span>
            </span>
          </GlassCard>
          <GlassCard className="login-float right-0 top-[62px] w-[250px]" delay="-2.5s">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-green/40 text-white">
              <IconCheck size={15} />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[13.5px] font-semibold">₹850 received</span>
              <span className="block font-mono text-[11px] text-white/60">Receipt R-1042</span>
            </span>
          </GlassCard>
          <GlassCard className="login-float bottom-0 left-8 w-[240px]" delay="-5s">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[#e693bb]/25 text-[#f3b8d3]">
              <PulseGlyph />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[13.5px] font-semibold">Vitals recorded</span>
              <span className="block font-mono text-[11px] text-white/60">
                BP 124/82 · SpO₂ 98%
              </span>
            </span>
          </GlassCard>
        </div>
      </div>

      <div>
        <div className="flex flex-wrap gap-2">
          {roles.map((r) => (
            <span
              key={r.label}
              className="inline-flex items-center gap-1.5 rounded-pill border border-white/12 bg-white/[0.07] px-3 py-1.5 text-[12px] font-medium text-white/85"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: r.color }} />
              {r.label}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[12.5px] text-white/50">
          One sign-in, and a console shaped for every role.
        </p>
      </div>
    </aside>
  );
}

function GlassCard({
  children,
  className = '',
  delay,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: string;
}) {
  return (
    <div
      className={`absolute flex items-center gap-3 rounded-[16px] border border-white/15 bg-white/10 px-3.5 py-3 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.5)] backdrop-blur-md ${className}`}
      style={delay ? { animationDelay: delay } : undefined}
    >
      {children}
    </div>
  );
}

function EyeGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ArrowGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function PulseGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </svg>
  );
}
