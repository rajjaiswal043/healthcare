'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Newsreader } from 'next/font/google';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiRequestError, type MfaChallenge } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import type { ClinicBrand } from '@/components/auth-shell';
import { ClinicLogo } from '@/components/clinic-logo';
import { ConsoleMark } from '@/components/console-mark';
import {
  HANDMADE_CSS,
  HandArrow,
  HandNote,
  Stamp,
  TokenSlip,
  Underlined,
} from '@/components/handmade';
import {
  IconAlert,
  IconArrowLeft,
  IconBuilding,
  IconEyeOff,
  IconKey,
  IconLock,
  IconMail,
  IconShield,
  IconUsers,
} from '@/components/icons';

type Stage = 'credentials' | 'mfa-code' | 'mfa-enrol';

/**
 * A real italic serif for the one accent word in a heading. The display face
 * (Bricolage) has no italic, and a sans the browser has slanted for you is one
 * of the quicker tells of a page nobody actually set.
 */
const serif = Newsreader({
  subsets: ['latin'],
  style: ['italic'],
  weight: ['400', '500'],
  variable: '--font-serif',
  display: 'swap',
});

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

/**
 * The last few people who signed in on this computer, for the quick switch.
 *
 * A front-desk PC is shared across a shift, and handing it over used to mean
 * typing the clinic and email again every time. Only what is already on the
 * screen after a sign-in is kept — name, email, clinic — never the password,
 * which is always typed fresh. Each person can remove themselves ("Forget me").
 */
const RECENT_KEY = 'healthcloud.recentSignIns';
const MAX_RECENT = 3;

type RecentUser = { email: string; name: string; slug: string; clinic: string };

/*
 * Stored as one tab-separated line per person rather than JSON: there is no
 * zod on this page to validate a parsed blob with, and four plain fields read
 * back by position are checked as they are read — a line that isn't exactly
 * four non-empty fields is dropped.
 */
const clean = (v: string) => v.replace(/[\t\n\r]+/g, ' ').trim();

function readRecents(): RecentUser[] {
  try {
    return (window.localStorage.getItem(RECENT_KEY) ?? '')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((p) => p.length === 4 && p.every((v) => v.length > 0))
      .map(([slug = '', email = '', name = '', clinic = '']) => ({ slug, email, name, clinic }))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function writeRecents(list: RecentUser[]) {
  try {
    window.localStorage.setItem(
      RECENT_KEY,
      list
        .slice(0, MAX_RECENT)
        .map((r) => [r.slug, r.email, r.name, r.clinic].map(clean).join('\t'))
        .join('\n'),
    );
  } catch {
    // Storage disabled: the quick switch simply doesn't appear.
  }
}

const sameRecent = (a: RecentUser, b: RecentUser) => a.email === b.email && a.slug === b.slug;

/** "Pooja Singh" → "Pooja"; "Dr. Kiran Rao" → "Dr. Rao": what colleagues call each other. */
const shortName = (name: string) => {
  const words = name.trim().split(/\s+/);
  return /^dr\.?$/i.test(words[0] ?? '')
    ? `Dr. ${words[words.length - 1] ?? ''}`
    : (words[0] ?? name);
};

const initialsOf = (name: string) =>
  name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

/**
 * Light or night. Shared with the welcome page through the same key, so the
 * choice follows the person from one to the other. Until somebody chooses, the
 * night look comes on by itself between 10 pm and 5 am — the same hours the
 * greeting says "Night shift".
 */
const LOOK_KEY = 'healthcloud.look';
type Look = 'light' | 'night';

/**
 * Standard or larger text for the sign-in form, remembered per computer.
 *
 * Kept on the PC rather than the person because the PC is what differs: the
 * consultant's chamber PC is set large once and stays large for everyone who
 * signs in there, while the reception PC stays standard. Clearing the browser's
 * data puts it back to standard.
 */
const TEXT_KEY = 'healthcloud.textSize';
type TextSize = 'standard' | 'large';

export default function LoginPage() {
  const router = useRouter();
  const pathname = usePathname();
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

  /** People who signed in on this computer recently, and the one just picked. */
  const [recents, setRecents] = useState<RecentUser[]>([]);
  const [picked, setPicked] = useState<RecentUser | null>(null);

  /**
   * When the last attempt failed because of the network rather than the
   * details. Kept apart from `error` because the advice is different: a wrong
   * password is the person's to fix, a dropped connection is not — and "Could
   * not reach the server" used to send staff round in circles retyping it.
   */
  const [netProblem, setNetProblem] = useState<'offline' | 'unreachable' | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  /** Light or night, for the full page. In the welcome pop-up the page decides. */
  const [look, setLook] = useState<Look>('light');

  /** Text size for the form — here and in the welcome pop-up alike. */
  const [textSize, setTextSize] = useState<TextSize>('standard');

  useEffect(() => {
    let saved: string | null = null;
    let savedSize: string | null = null;
    try {
      saved = window.localStorage.getItem(LOOK_KEY);
      savedSize = window.localStorage.getItem(TEXT_KEY);
    } catch {
      // No storage: fall through to the clock, and standard text.
    }
    if (saved === 'light' || saved === 'night') setLook(saved);
    else {
      const h = new Date().getHours();
      if (h >= 22 || h < 5) setLook('night');
    }
    if (savedSize === 'large') setTextSize('large');
  }, []);

  function chooseTextSize(next: TextSize) {
    setTextSize(next);
    try {
      window.localStorage.setItem(TEXT_KEY, next);
    } catch {
      // Remembered for this visit only.
    }
  }

  function toggleLook() {
    const next: Look = look === 'night' ? 'light' : 'night';
    setLook(next);
    try {
      window.localStorage.setItem(LOOK_KEY, next);
    } catch {
      // Remembered for this visit only.
    }
  }

  /**
   * Offline: try again the moment the connection is back. The details are
   * still in the form, so nobody has to type anything twice.
   */
  useEffect(() => {
    if (netProblem !== 'offline') return;
    const retry = () => formRef.current?.requestSubmit();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [netProblem]);

  function pickRecent(r: RecentUser) {
    setPicked(r);
    setTenantSlug(r.slug);
    setEmail(r.email);
    setPassword('');
    setError(null);
    requestAnimationFrame(() => document.getElementById('password')?.focus());
  }

  function notMe() {
    setPicked(null);
    setEmail('');
    setPassword('');
    requestAnimationFrame(() => document.getElementById('email')?.focus());
  }

  function forgetRecent(r: RecentUser) {
    const list = recents.filter((x) => !sameRecent(x, r));
    setRecents(list);
    writeRecents(list);
    if (picked && sameRecent(picked, r)) notMe();
  }

  /**
   * "Good morning", and today's date, in the desk's own time.
   *
   * Set after mount: the server renders in its own timezone, so computing this
   * during render would greet a Pune front desk with a Frankfurt afternoon and
   * then flicker. Until it lands the heading says "Welcome back", which is
   * never wrong. Late evening and the small hours get their own line, because
   * that is who is signing in then: the night nurse, the on-call doctor.
   */
  const [greeting, setGreeting] = useState<{ hello: string; date: string } | null>(null);

  useEffect(() => {
    const now = new Date();
    const h = now.getHours();
    setGreeting({
      hello:
        h < 5 || h >= 22
          ? 'Night shift'
          : h < 12
            ? 'Good morning'
            : h < 17
              ? 'Good afternoon'
              : 'Good evening',
      date: now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
    });
  }, []);

  /**
   * Restore the last clinic, once.
   *
   * In an effect rather than in `useState`'s initialiser because this component
   * renders on the server first: reading localStorage during render would make
   * the server and client markup disagree, and React would discard the whole
   * tree rather than reconcile it.
   */
  useEffect(() => {
    setRecents(readRecents());
    try {
      const remembered = window.localStorage.getItem(LAST_CLINIC_KEY);
      if (remembered) {
        setTenantSlug(remembered);
        // The clinic is already filled in, so start the cursor where the
        // person actually has to type. Saves a Tab on every sign-in, forty
        // times a day at a busy desk.
        requestAnimationFrame(() => document.getElementById('email')?.focus());
      }
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
    setNetProblem(null);

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

      // Put this person at the front of the quick switch for this computer.
      const me: RecentUser = {
        email: email.trim().toLowerCase(),
        name: result.user.fullName,
        slug: result.tenant.slug,
        clinic: result.tenant.name,
      };
      writeRecents([me, ...readRecents().filter((r) => !sameRecent(r, me))]);

      await refresh();
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err.error.message);
      // Anything else never reached the API at all: a network failure.
      else setNetProblem(navigator.onLine ? 'unreachable' : 'offline');
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
   * The form itself — greeting, fields, two-factor steps, help. Shared by both
   * layouts below, so the full page and the welcome-page pop-up can never
   * drift apart in what they ask for or how they sign someone in.
   */
  const formBlock = (
    <div key={stage} className="login-rise login-scale w-full max-w-[384px]">
      {!onCredentials && (
        <span className="mb-4 grid h-12 w-12 place-items-center rounded-panel bg-clinical text-white shadow-[0_10px_24px_-10px_rgba(15,118,110,0.8)]">
          <IconShield size={22} />
        </span>
      )}

      {onCredentials && (
        <p className="mb-1 h-5 text-[13.5px] font-medium text-ink-40">
          {greeting ? greeting.date : ' '}
        </p>
      )}
      <h1 className="text-[clamp(28px,3.4vw,36px)] font-extrabold leading-[1.05] tracking-[-0.03em]">
        {onCredentials ? (
          greeting ? (
            <>
              {greeting.hello.split(' ')[0]}{' '}
              <span className="login-serif text-clinical">
                {greeting.hello.split(' ').slice(1).join(' ')}
              </span>
              .
            </>
          ) : (
            <>
              Welcome <span className="text-clinical">back</span>
            </>
          )
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

      <form ref={formRef} onSubmit={submit} className="mt-6 space-y-4" noValidate>
        {netProblem && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-[12px] border border-amber/40 bg-amber-soft/60 px-3.5 py-2.5 text-[13px] leading-snug text-amber-text"
          >
            <span className="mt-0.5 shrink-0">
              <OfflineGlyph />
            </span>
            {netProblem === 'offline' ? (
              <span>
                <b className="block font-semibold">This computer is offline.</b>
                What you typed is kept. You&rsquo;ll be signed in as soon as the internet is back.
              </span>
            ) : (
              <span>
                <b className="block font-semibold">The clinic server isn&rsquo;t answering.</b>
                The internet here looks fine. Try again in a minute, and tell your administrator if
                it keeps happening.
              </span>
            )}
          </div>
        )}

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
            {!picked && recents.length > 0 && (
              <div>
                <p className="mb-1.5 text-[12.5px] font-semibold text-ink-60">
                  Signed in on this computer before
                </p>
                <ul className="grid grid-cols-3 gap-2">
                  {recents.map((r) => (
                    <li key={`${r.slug}/${r.email}`} className="group relative">
                      <button
                        type="button"
                        onClick={() => pickRecent(r)}
                        className="flex w-full flex-col items-center gap-1 rounded-[12px] border border-ink/10 bg-white/80 px-1.5 pb-2 pt-2.5 text-center transition-colors hover:border-clinical/40 hover:bg-clinical-tint"
                      >
                        <span className="grid h-8 w-8 place-items-center rounded-full bg-clinical font-display text-[11.5px] font-bold text-white">
                          {initialsOf(r.name)}
                        </span>
                        <span className="w-full truncate text-[12.5px] font-semibold text-ink">
                          {shortName(r.name)}
                        </span>
                        <span className="w-full truncate text-[10.5px] text-ink-40">
                          {r.clinic}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => forgetRecent(r)}
                        aria-label={`Forget ${r.name} on this computer`}
                        title="Forget me on this computer"
                        className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-ink/10 bg-white text-[13px] leading-none text-ink-40 opacity-0 shadow-sm transition-opacity hover:text-coral-text focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                      >
                        &times;
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {picked ? (
              <div className="flex items-center justify-between gap-3 rounded-[14px] border border-ink/10 bg-white/80 px-3.5 py-2.5 shadow-sm">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-clinical font-display text-[12.5px] font-bold text-white">
                    {initialsOf(picked.name)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-semibold text-ink">
                      {picked.name}
                    </span>
                    <span className="block truncate text-[11.5px] text-ink-40">
                      {picked.email} · {picked.clinic}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  onClick={notMe}
                  className="shrink-0 rounded-pill px-2.5 py-1 text-[12.5px] font-semibold text-clinical-text transition-colors hover:bg-clinical-tint"
                >
                  Not you?
                </button>
              </div>
            ) : (
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
              </>
            )}
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
                <span className="block truncate text-[13.5px] font-semibold text-ink">{email}</span>
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

      {/* Most sign-ins happen at a desk PC that three people share. The
          one habit that keeps patient records safe there is signing out,
          so it is said here, once, where the session starts. */}
      {onCredentials && (
        <p className="mt-4 flex items-center justify-center gap-2 rounded-[10px] bg-amber-soft/60 px-3 py-2 text-[12.5px] text-amber-text">
          <IconUsers size={14} />
          Shared desk computer? Sign out whenever you step away.
        </p>
      )}

      <p className="mt-4 text-center text-[13px] text-ink-40 [@media(max-height:760px)]:hidden">
        {onCredentials
          ? 'Forgot your password or new to the clinic? Your administrator can set up or reset your account.'
          : 'Lost access to your authenticator? Ask your clinic administrator to reset it.'}
      </p>
    </div>
  );

  /**
   * Inside the welcome page's sign-in pop-up.
   *
   * The welcome page renders this same component in a dialog instead of sending
   * people off to another page, so the form, its checks and its two-factor
   * steps exist exactly once. A Next.js page takes no props, so it tells from
   * the address: anywhere other than /login, it is embedded. The dialog itself
   * — backdrop, close button, focus — belongs to the welcome page; this
   * supplies only the two panels inside it.
   */
  if (pathname !== '/login') {
    return (
      <div data-text={textSize} className={`${serif.variable} grid md:grid-cols-[1fr_0.95fr]`}>
        <style dangerouslySetInnerHTML={{ __html: LOGIN_CSS + HANDMADE_CSS }} />

        <div className="flex flex-col px-6 pb-7 pt-8 sm:px-10 sm:pb-9 sm:pt-10">
          {/* Right padding on phones keeps the size switch clear of the
              dialog's close button, which sits over this corner there. */}
          <div className="mb-7 flex items-center justify-between gap-3 pr-12 md:pr-0">
            <span className="flex min-w-0 items-center gap-2.5">
              {clinic ? (
                <>
                  <ClinicLogo clinic={clinic} size={28} />
                  <span className="truncate font-display text-[16px] font-extrabold">
                    {clinic.name}
                  </span>
                </>
              ) : (
                <>
                  <ConsoleMark size={28} />
                  <span className="whitespace-nowrap font-display text-[16px] font-extrabold">
                    Clinic <span className="text-clinical">Console</span>
                  </span>
                </>
              )}
            </span>
            <TextSizeToggle size={textSize} onChange={chooseTextSize} />
          </div>

          {formBlock}

          <p className="mt-6 flex items-center gap-2 text-[12.5px] text-ink-40">
            <IconLock size={13} />
            Everything you change is recorded under your name.
          </p>
        </div>

        <PopupArt clinic={clinic} />
      </div>
    );
  }

  /**
   * Layout.
   *
   * HEIGHT IS STILL A HARD CONSTRAINT (scripts/check-viewport-fit.mjs): the page
   * is exactly one viewport tall and never scrolls. The form column scrolls
   * internally as a last resort, and anything decorative — the token slip,
   * the help line — drops out on short screens before the form is squeezed.
   *
   * The brand panel keeps the white-label rule from auth-shell.tsx: once the
   * slug resolves it wears the CLINIC's logo and name, and before that only the
   * neutral "Clinic Console" mark.
   */
  return (
    <main
      data-look={look}
      data-text={textSize}
      className={`${serif.variable} relative flex h-[100dvh] w-full overflow-hidden bg-bg lg:gap-3 lg:p-3`}
    >
      <style dangerouslySetInnerHTML={{ __html: LOGIN_CSS + HANDMADE_CSS }} />

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

          <span className="flex min-w-0 items-center gap-3">
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
            <TextSizeToggle size={textSize} onChange={chooseTextSize} />
            <LookToggle look={look} onToggle={toggleLook} />
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-4 sm:px-8">
          {formBlock}
        </div>

        <footer className="flex shrink-0 items-center justify-center gap-2 px-5 pb-4 text-[12.5px] text-ink-40 sm:px-8 sm:pb-6">
          <IconLock size={13} />
          Everything you change is recorded under your name.
        </footer>
      </section>
    </main>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Night: a low-glare version of this page for the night shift and dim wards.
 *
 * The console's colours are fixed values in tailwind.config.ts, so the night
 * look is a set of overrides for exactly the classes this page uses, active
 * under any [data-look="night"] ancestor — this page's own root, or the
 * welcome page when the form sits in its pop-up. The ground drops to a deep
 * blue-green slate rather than black, text to a soft off-white, and teal is
 * lifted just enough to stay readable on it.
 */
const NIGHT = '[data-look="night"]';

function nightRules(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([selectors, decl]) => {
      const list = selectors
        .split(',')
        .map((sel) => sel.trim())
        .flatMap((sel) => [NIGHT + ' ' + sel, NIGHT + sel]);
      return list.join(',') + '{' + decl + '}';
    })
    .join('\n');
}

const NIGHT_CSS =
  NIGHT +
  // A light default colour too: headings that set no colour of their own
  // inherit it instead of the console's near-black.
  '{color-scheme:dark;color:#E4EAE8}\nhtml:has(' +
  NIGHT +
  '){background:#0E1315}\n' +
  nightRules({
    '.bg-bg': 'background-color:#0E1315',
    '.bg-bg-soft': 'background-color:#151B1D',
    '.bg-white, .focus\\:bg-white:focus': 'background-color:#1A2224',
    '.bg-white\\/70, .bg-white\\/80, .bg-white\\/90': 'background-color:rgba(26,34,36,.86)',
    '.text-ink, .hover\\:text-ink:hover': 'color:#E4EAE8',
    '.text-ink-60': 'color:#B3BDBA',
    '.text-ink-40, .mono-label': 'color:#939D9A',
    '.text-ink-20, .placeholder\\:text-ink-20::placeholder, .placeholder\\:text-ink-20\\/60::placeholder':
      'color:#6A7472',
    '.border-ink\\/10, .border-ink\\/12': 'border-color:rgba(228,234,232,.13)',
    '.hover\\:border-ink\\/20:hover, .hover\\:border-ink\\/25:hover':
      'border-color:rgba(228,234,232,.26)',
    '.hover\\:bg-ink\\/5:hover': 'background-color:rgba(228,234,232,.06)',
    '.bg-ink\\/10': 'background-color:rgba(228,234,232,.1)',
    '.text-clinical, .group:focus-within .group-focus-within\\:text-clinical': 'color:#4CC3B3',
    '.text-clinical-text': 'color:#6AD1C2',
    '.bg-clinical': 'background-color:#1F8F83',
    '.hover\\:bg-clinical-deep:hover': 'background-color:#17766C',
    '.focus\\:border-clinical:focus, .hover\\:border-clinical\\/40:hover': 'border-color:#4CC3B3',
    '.bg-clinical-soft, .hover\\:bg-clinical-tint:hover': 'background-color:rgba(76,195,179,.16)',
    '.bg-clinical-soft\\/70': 'background-color:rgba(76,195,179,.09)',
    '.bg-clinical-deep': 'background-color:#0B2E2B',
    '.bg-amber-soft, .bg-amber-soft\\/50, .bg-amber-soft\\/60':
      'background-color:rgba(232,178,60,.13)',
    '.text-amber-text': 'color:#F0C868',
    '.border-amber\\/40': 'border-color:rgba(232,178,60,.35)',
    '.text-coral-text, .hover\\:text-coral-text:hover': 'color:#F4A08C',
    '.bg-coral\\/8': 'background-color:rgba(228,103,79,.13)',
    '.border-coral\\/30': 'border-color:rgba(228,103,79,.35)',
    // The token slip is paper-white; at night it is dimmed so it doesn't glare.
    '.bg-\\[\\#FFFEFB\\]': 'filter:brightness(.82)',
    // The selected half of the text-size switch.
    '.bg-ink': 'background-color:#3A4648',
  });

/**
 * Larger text. The form's sizes are fixed pixel values, so raising the root
 * font size would change nothing; instead the whole form is zoomed, which keeps
 * every proportion, and borders and labels get heavier on top — what actually
 * helps on a dim, old monitor. Width still fits: percentages resolve against
 * the unzoomed column, so the form never spills past it. On short screens the
 * form column already scrolls on its own, so the page itself never does.
 */
const LARGE_TEXT_CSS = [
  '[data-text="large"] .login-scale{zoom:1.17}',
  '[data-text="large"] .login-scale label{font-weight:700}',
  '[data-text="large"] .login-scale input{border-width:2px}',
].join('\n');

const LOGIN_CSS = `
${NIGHT_CSS}
${LARGE_TEXT_CSS}
.login-serif{font-family:var(--font-serif),Georgia,serif;font-style:italic;font-weight:400;letter-spacing:-.01em}
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
        <h2 className="max-w-[460px] text-[clamp(30px,3vw,46px)] font-extrabold leading-[1.04] tracking-[-0.03em] text-white">
          The whole OPD,{' '}
          <Underlined color="#E8B23C" className="login-serif text-[#7fe0d2]">
            on one screen.
          </Underlined>
        </h2>
        <p className="mt-4 max-w-[400px] text-[15px] leading-relaxed text-white/65">
          Registration, consultations, prescriptions and billing, right where you left them.
        </p>

        {/* The desk, as it looks today: a printed token slip, the OPD stamp,
            and a note in the margin. Decorative, and first to go on short
            screens. The slip wears the clinic's name once it is known —
            before that it says only "OPD", per the white-label rule. */}
        <div
          aria-hidden="true"
          className="relative mt-9 h-[250px] max-w-[460px] [@media(max-height:860px)]:hidden"
        >
          <div className="absolute left-2 top-1">
            <TokenSlip
              heading={clinic ? clinic.name : 'OPD · Out-patient'}
              token="19"
              lines={[
                ['Doctor', 'Dr. K. Rao'],
                ['Room', '2'],
                ['Issued', '09:04'],
              ]}
              footer="Please wait for your number"
            />
          </div>
          <Stamp
            className="absolute left-[222px] top-[122px]"
            top="OUT-PATIENT DEPT"
            middle="OPD OPEN"
            bottom="WALK-INS WELCOME"
            color="#F08A6E"
            size={124}
            rotate={-14}
          />
          <span className="absolute right-0 top-4 flex flex-col items-start text-[#F6D48A]">
            <HandNote className="text-[25px]" rotate={-5}>
              goodbye, token roll —
              <br />
              the numbers are on
              <br />
              the waiting-room TV now
            </HandNote>
            <HandArrow direction="down-left" className="ml-2 mt-1 h-12 w-16" color="#F6D48A" />
          </span>
        </div>
      </div>

      <div>
        <p className="text-[13.5px] leading-relaxed text-white/55">
          Front desk, doctors, nurses, owners and admins all sign in here.
          <br />
          Each lands on their own screen.
        </p>
      </div>
    </aside>
  );
}

/**
 * The right half of the pop-up: the front desk as it looks today. Two printed
 * tokens — the one just served, and the one being called — the OPD stamp, and a
 * note in the margin, on the same deep teal as the full sign-in page. Hidden on
 * phones, where the pop-up is the form and nothing else.
 */
function PopupArt({ clinic }: { clinic: ClinicBrand | null }) {
  const heading = clinic ? clinic.name : 'OPD · Out-patient';
  return (
    <aside
      aria-hidden="true"
      className="relative isolate hidden min-h-[560px] overflow-hidden bg-clinical-deep text-white md:block"
    >
      <div
        className="absolute inset-0 -z-10 opacity-[0.12]"
        style={{
          backgroundImage:
            'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
          backgroundSize: '40px 40px',
          maskImage: 'radial-gradient(ellipse 75% 65% at 50% 45%, black 20%, transparent 80%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 75% 65% at 50% 45%, black 20%, transparent 80%)',
        }}
      />
      <div className="auth-blob absolute -right-24 -top-24 -z-10 h-[340px] w-[340px] rounded-full bg-[#18a092]/60 blur-3xl" />
      <div className="auth-blob-slow absolute -bottom-32 -left-20 -z-10 h-[320px] w-[320px] rounded-full bg-amber/25 blur-3xl" />

      {/* A pulse running behind the slips. */}
      <svg
        className="absolute inset-x-0 top-[44%] -z-10 h-24 w-full"
        viewBox="0 0 600 100"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          d="M0 60h150l12-22 14 46 16-80 16 90 12-34h90l8-12 8 12h274"
          stroke="#7fe0d2"
          strokeOpacity="0.28"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <div className="absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2">
        <div className="relative h-[330px] w-[300px]">
          <div className="absolute left-[92px] top-[6px] opacity-60">
            <TokenSlip
              heading={heading}
              token="18"
              lines={[
                ['Doctor', 'Dr. L. Iyer'],
                ['Room', '1'],
                ['Issued', '08:57'],
              ]}
              footer="Seen · Thank you"
              rotate={7}
            />
          </div>
          <div className="absolute left-0 top-[24px]">
            <TokenSlip
              heading={heading}
              token="19"
              lines={[
                ['Doctor', 'Dr. K. Rao'],
                ['Room', '2'],
                ['Issued', '09:04'],
              ]}
              footer="Please wait for your number"
              rotate={-5}
            />
          </div>
          <Stamp
            className="absolute -right-10 bottom-[-6px]"
            top="OUT-PATIENT DEPT"
            middle="OPD OPEN"
            bottom="WALK-INS WELCOME"
            color="#F08A6E"
            size={128}
            rotate={-14}
          />
        </div>
      </div>

      <span className="absolute right-20 top-9 flex flex-col items-end text-[#F6D48A]">
        <HandNote className="text-[26px]" rotate={4}>
          token 19, you&rsquo;re up!
        </HandNote>
        <HandArrow direction="down-left" className="mr-10 mt-1 h-11 w-14" color="#F6D48A" />
      </span>

      <p className="absolute inset-x-8 bottom-8 text-[26px] font-extrabold leading-[1.08] tracking-[-0.03em]">
        The whole OPD, <span className="login-serif text-[#7fe0d2]">on one screen.</span>
      </p>
    </aside>
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

/** The sun/moon switch between the light and night looks. */
/**
 * The two-part "Aa | Aa" switch: small A for standard, big A for larger text.
 * Each half says what it does to screen readers, and the current one is
 * marked pressed.
 */
function TextSizeToggle({
  size,
  onChange,
}: {
  size: TextSize;
  onChange: (next: TextSize) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Text size"
      className="inline-flex h-9 shrink-0 items-center gap-0.5 rounded-pill border border-ink/10 bg-white/70 p-0.5 shadow-sm backdrop-blur"
    >
      {(['standard', 'large'] as const).map((t) => {
        const on = size === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            aria-pressed={on}
            aria-label={t === 'large' ? 'Larger text' : 'Standard text'}
            title={t === 'large' ? 'Larger text' : 'Standard text'}
            className={`grid h-8 min-w-[34px] place-items-center rounded-pill px-2 font-display font-bold leading-none transition-colors ${
              t === 'large' ? 'text-[16.5px]' : 'text-[12.5px]'
            } ${on ? 'bg-ink text-white' : 'text-ink-60 hover:text-ink'}`}
          >
            Aa
          </button>
        );
      })}
    </div>
  );
}

function LookToggle({ look, onToggle }: { look: Look; onToggle: () => void }) {
  const night = look === 'night';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={night}
      aria-label={night ? 'Switch to the light look' : 'Switch to the night look'}
      title={night ? 'Light look' : 'Night look'}
      className="inline-flex h-9 items-center gap-2 rounded-pill border border-ink/10 bg-white/70 px-3 text-[13px] font-medium text-ink-60 shadow-sm backdrop-blur transition-colors hover:border-ink/20 hover:text-ink"
    >
      {night ? <SunGlyph /> : <MoonGlyph />}
      <span className="hidden sm:inline">{night ? 'Light' : 'Night'}</span>
    </button>
  );
}

function MoonGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  );
}

function SunGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </svg>
  );
}

/** A cloud with a line through it: "no connection". */
function OfflineGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 18h10a4 4 0 0 0 1.2-7.8A6 6 0 0 0 7.1 8.6 4.8 4.8 0 0 0 7 18z" />
      <path d="M3 3l18 18" />
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
