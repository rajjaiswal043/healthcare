'use client';

import Link from 'next/link';
import { Newsreader } from 'next/font/google';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/components/auth-provider';
import { ConsoleMark } from '@/components/console-mark';
import { HANDMADE_CSS, HandArrow, HandNote, Underlined } from '@/components/handmade';
import { ScrollScene, SectionRail } from '@/components/scroll-scene';
import LoginPage from '../login/page';
import {
  IconBell,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconEyeOff,
  IconHome,
  IconKey,
  IconLock,
  IconMenu,
  IconReceipt,
  IconSearch,
  IconShield,
  IconStethoscope,
  IconUserPlus,
  IconUsers,
  IconX,
} from '@/components/icons';

/**
 * The public front page.
 *
 * What somebody sees before they have a session: what the console does, and
 * one obvious door — "Staff sign-in", top right — into `/login`. A visitor who
 * already has a session gets "Open console" in the same place instead, so the
 * page never asks a signed-in receptionist to sign in again.
 *
 * Written in the product's own voice ("Clinic Console") and with a mark drawn
 * here, not doctorsdesk.in's: the white-label rule in auth-shell.tsx still
 * holds, and a clinic that sends its staff here never meets our name.
 *
 * Every claim on this page is something the code actually does — the queue,
 * the duplicate check, the waiting-room display, per-role consoles, MFA,
 * audit, Ctrl+K search. No invented customer counts. The names and numbers in
 * the drawn screens are sample data, and read as such.
 *
 * Page-local keyframes live in the <style> below rather than globals.css, so
 * this page can change without touching the console's stylesheet. The global
 * reduced-motion rule still applies to all of them, and the ones that would
 * otherwise leave content hidden have an explicit fallback.
 */

/**
 * A real italic serif for accent words. Bricolage has no italic, and a sans
 * the browser has slanted is one of the quicker tells of an untypeset page.
 */
const serif = Newsreader({
  subsets: ['latin'],
  style: ['italic'],
  weight: ['400', '500'],
  variable: '--font-serif',
  display: 'swap',
});

const CSS = `
/* In-page links (nav, section rail, hero buttons) glide to their section
   instead of jumping. Only present while this page is mounted, so the console
   is unaffected; the global reduced-motion rule turns it back into a jump. */
html{scroll-behavior:smooth}
.wl-serif,.wl-head .text-clinical{font-family:var(--font-serif),Georgia,serif;font-style:italic;font-weight:400;letter-spacing:-.015em}
@keyframes wl-rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.wl-rise{animation:wl-rise .9s cubic-bezier(.2,.7,.2,1) both}
@keyframes wl-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.wl-float{animation:wl-float 6s ease-in-out infinite}
@keyframes wl-blink{50%{opacity:0}}
.wl-caret{animation:wl-blink 1s steps(1) infinite}
@media (prefers-reduced-motion: reduce){
  .wl-float,.wl-caret{animation:none}
}
@keyframes wl-fade{from{opacity:0}to{opacity:1}}
.wl-fade{animation:wl-fade .25s ease-out both}
@keyframes wl-pop{from{opacity:0;transform:translateY(24px) scale(.98)}to{opacity:1;transform:none}}
.wl-pop{animation:wl-pop .38s cubic-bezier(.2,.8,.2,1) both}
`;

/** Every section the side rail tracks, in page order. */
const SECTIONS = [
  { id: 'top', label: 'Overview' },
  { id: 'paper', label: 'What it replaces' },
  { id: 'features', label: 'Features' },
  { id: 'roles', label: 'Roles' },
  { id: 'workflow', label: 'How it works' },
  { id: 'display', label: 'Waiting room' },
  { id: 'security', label: 'Security' },
  { id: 'faq', label: 'FAQ' },
] as const;

/**
 * ============================================================================
 *  THE BUSINESS BEHIND THE PAGE — fill these in with real details.
 * ============================================================================
 *
 * A clinic owner is deciding whether to trust this product with patient
 * records, and the thing that earns that trust is real-world detail: a company
 * name, a phone number that gets answered, a price, a real clinic that uses it.
 * None of that can be made up, so every field starts empty — and every part of
 * the page that depends on one stays hidden until it is filled in. Nothing
 * invented ever shows. Fill a field, save, and its section appears.
 *
 *   companyName   Legal name, as on invoices ("Cxvoxa Health Pvt Ltd").
 *   address       One line: city and state at least.
 *   email         Where demo requests and questions go. Turns on "Book a demo".
 *   phone         Answered during clinic hours. Shown and tap-to-call.
 *   whatsapp      Country code + number, digits only ("919876543210").
 *   pricing       Starting price as it should read ("₹1,499"), what it covers
 *                 ("per clinic, per month"), and the trial, if any.
 *   pilot         One real clinic, with their permission: the doctor's own
 *                 words, name, role, clinic and city.
 *   founder       Who is behind it, and in two or three plain sentences why.
 *   dataRegion    Where patient data is actually stored, once it is live
 *                 there (the architecture notes choose AWS Mumbai, ap-south-1).
 *   abdm          Only once true, e.g. "ABDM M1 certified". Until then the page
 *                 says only what exists: ABHA numbers stored and searchable.
 *   privacyUrl / termsUrl / dataUrl
 *                 Links to the real documents. Needed before real patient
 *                 data goes in — ideally reviewed by a lawyer.
 *   statusUrl     A real status page. The footer's "all systems normal" line
 *                 only appears when it links to one.
 */
const BUSINESS = {
  companyName: '',
  address: '',
  email: '',
  phone: '',
  whatsapp: '',
  pricing: { from: '', per: 'per clinic, per month', trial: '' },
  pilot: { quote: '', name: '', role: '', clinic: '', city: '' },
  founder: { name: '', role: '', story: '' },
  dataRegion: '',
  abdm: '',
  privacyUrl: '',
  termsUrl: '',
  dataUrl: '',
  statusUrl: '',
};

/** Any way at all for a clinic owner to reach a person. */
const OWNER_CONTACT = Boolean(BUSINESS.email || BUSINESS.phone || BUSINESS.whatsapp);

/**
 * Light or night. Shared with the sign-in page through the same key, so the
 * choice follows the person between them. Until somebody picks, the night look
 * comes on by itself between 10 pm and 5 am.
 */
const LOOK_KEY = 'healthcloud.look';
type Look = 'light' | 'night';

const NAV = [
  { href: '#features', label: 'Features' },
  { href: '#roles', label: 'Roles' },
  { href: '#workflow', label: 'How it works' },
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
];

export default function WelcomePage() {
  const { session, loading } = useAuth();
  const signedIn = !loading && !!session;

  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const primary = signedIn
    ? { href: '/', label: 'Open console', short: 'Console' }
    : { href: '/login', label: 'Staff sign-in', short: 'Sign in' };

  /**
   * Sign-in opens over this page instead of leaving it, and the address bar
   * never changes: the pop-up is plain component state. Ctrl/Cmd/Shift-click
   * and middle click are left alone, so "open in new tab" still goes to /login
   * — as does everything with JavaScript off, since the links keep their real
   * href.
   */
  const [signInOpen, setSignInOpen] = useState(false);

  function openSignIn(e: React.MouseEvent) {
    if (signedIn || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setMenuOpen(false);
    setSignInOpen(true);
  }

  const closeSignIn = useCallback(() => setSignInOpen(false), []);

  const [demoOpen, setDemoOpen] = useState(false);
  const closeDemo = useCallback(() => setDemoOpen(false), []);

  const [look, setLook] = useState<Look>('light');

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(LOOK_KEY);
    } catch {
      // No storage: fall through to the clock.
    }
    if (saved === 'light' || saved === 'night') setLook(saved);
    else {
      const h = new Date().getHours();
      if (h >= 22 || h < 5) setLook('night');
    }
  }, []);

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
   * In-page links scroll to their section without touching the address.
   *
   * One listener for the whole page, so it covers every `href="#…"` link —
   * the nav, the section rail, the hero and footer links, the skip link —
   * without each needing its own handler. The browser's own behaviour would
   * glide there too (the smooth-scroll rule in CSS) but would also write
   * `#features` into the URL; this scrolls and leaves the URL alone. Section
   * `scroll-margin` still applies, so nothing ends up under the header.
   * Modified clicks fall through to the browser as normal.
   */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
      const id = link?.getAttribute('href')?.slice(1);
      const target = id ? document.getElementById(id) : null;
      if (!target) return;

      e.preventDefault();
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      // The skip link's job is to move keyboard focus, not just the view.
      if (id === 'main') target.focus({ preventScroll: true });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <div
      data-look={look}
      className={`${serif.variable} relative isolate min-h-screen overflow-x-clip`}
    >
      <style dangerouslySetInnerHTML={{ __html: CSS + HANDMADE_CSS + NIGHT_CSS }} />
      <ScrollScene />
      <SectionRail sections={SECTIONS} />

      {/* First Tab stop: jump past the header straight to the page. Invisible
          until focused, for anyone driving the page from a keyboard. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-pill focus:bg-ink focus:px-5 focus:py-3 focus:text-[14px] focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>

      {/* ==== Header ======================================================= */}
      <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-4">
        <div
          className={`mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 rounded-pill border pl-3 pr-2 transition-all duration-300 sm:pl-4 ${
            scrolled || menuOpen
              ? 'border-ink/10 bg-white/80 shadow-[0_10px_30px_-14px_rgba(60,50,35,0.35)] backdrop-blur-xl'
              : 'border-transparent bg-transparent'
          }`}
        >
          <Link
            href="/welcome"
            className="flex items-center gap-2"
            aria-label="Clinic Console home"
          >
            <ConsoleMark size={30} />
            <span className="whitespace-nowrap font-display text-[16.5px] font-extrabold tracking-display">
              Clinic <span className="text-clinical">Console</span>
            </span>
          </Link>

          <nav className="hidden items-center md:flex" aria-label="Page sections">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="rounded-pill px-3.5 py-2 text-[13.5px] font-medium text-ink-60 transition-colors hover:bg-ink/5 hover:text-ink"
              >
                {n.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-1.5">
            <NightToggle look={look} onToggle={toggleLook} />
            <Link
              href={primary.href}
              onClick={openSignIn}
              className="group inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-pill bg-ink pl-4 pr-3 text-[13.5px] font-semibold text-white shadow-sm transition-all hover:bg-clinical-deep hover:shadow"
            >
              {!signedIn && (
                <span className="hidden text-white/70 sm:inline-flex">
                  <IconLock size={14} />
                </span>
              )}
              <span className="sm:hidden">{primary.short}</span>
              <span className="hidden sm:inline">{primary.label}</span>
              <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5">
                <ArrowRight size={12} />
              </span>
            </Link>
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-full text-ink-60 hover:bg-ink/5 md:hidden"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <IconX size={18} /> : <IconMenu size={18} />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <nav
            className="mx-auto mt-2 max-w-5xl rounded-card border border-ink/10 bg-white/95 p-2 shadow-lg backdrop-blur-xl md:hidden"
            aria-label="Page sections"
          >
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                onClick={() => setMenuOpen(false)}
                className="flex items-center justify-between rounded-panel px-4 py-3 text-[15px] font-medium text-ink-60 hover:bg-ink/5 hover:text-ink"
              >
                {n.label}
                <span className="text-ink-20">
                  <ArrowRight size={14} />
                </span>
              </a>
            ))}
          </nav>
        )}
      </header>

      <main id="main" tabIndex={-1} className="outline-none">
        {/* ==== Hero ======================================================= */}
        <section id="top" className="relative isolate px-4 pb-20 pt-32 sm:px-6 sm:pt-40 lg:pb-28">
          <HeroBackdrop />

          <div className="mx-auto max-w-6xl">
            <a
              href="#display"
              className="wl-rise group inline-flex items-center gap-2 rounded-pill border border-ink/10 bg-white/75 py-1 pl-1 pr-3 text-[12.5px] font-medium text-ink-60 shadow-sm backdrop-blur transition-colors hover:border-clinical/30 hover:text-ink"
            >
              <span className="rounded-pill bg-clinical px-2 py-0.5 text-[11px] font-bold text-white">
                New
              </span>
              Token screens for the waiting room
              <span className="text-ink-20 transition-transform group-hover:translate-x-0.5">
                <ArrowRight size={12} />
              </span>
            </a>

            <h1
              className="wl-rise mt-7 max-w-4xl text-[clamp(42px,7.4vw,92px)] font-extrabold leading-[0.96] tracking-[-0.045em]"
              style={{ animationDelay: '80ms' }}
            >
              {/* Static on purpose. It used to cycle through four roles, but a
                  headline that changes while you read it is one more moving
                  thing on a screen in a busy clinic, and screen readers only
                  ever heard the first word anyway.

                  Heavy sans for the statement, a real italic serif for the
                  part that matters. */}
              The whole OPD,{' '}
              <Underlined className="wl-serif pr-[0.06em] text-clinical">on one screen.</Underlined>
            </h1>

            <p
              className="wl-rise mt-6 max-w-[560px] text-[clamp(16px,1.6vw,18.5px)] leading-relaxed text-ink-60"
              style={{ animationDelay: '160ms' }}
            >
              Registration, the token queue, prescriptions and the day&rsquo;s collections. Made for
              the front desk at eleven in the morning, with fourteen people waiting and the phone
              ringing.
            </p>

            <div
              className="wl-rise mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center"
              style={{ animationDelay: '240ms' }}
            >
              {/* This page is for the people who choose and pay for the
                  software. Staff have the sign-in button in the header; once
                  an owner can actually reach someone, the main button is theirs. */}
              {OWNER_CONTACT && !signedIn ? (
                <a
                  href="#owners"
                  className="group inline-flex h-[52px] items-center justify-center gap-2.5 rounded-pill bg-clinical px-7 text-[15.5px] font-bold text-white shadow-[0_10px_30px_-10px_rgba(15,118,110,0.7)] transition-all hover:bg-clinical-deep active:translate-y-px"
                >
                  See it for your clinic
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5">
                    <ArrowRight size={15} />
                  </span>
                </a>
              ) : (
                <Link
                  href={primary.href}
                  onClick={openSignIn}
                  className="group inline-flex h-[52px] items-center justify-center gap-2.5 rounded-pill bg-clinical px-7 text-[15.5px] font-bold text-white shadow-[0_10px_30px_-10px_rgba(15,118,110,0.7)] transition-all hover:bg-clinical-deep active:translate-y-px"
                >
                  {signedIn ? 'Open your console' : 'Sign in to your clinic'}
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5">
                    <ArrowRight size={15} />
                  </span>
                </Link>
              )}
              <a
                href="#workflow"
                className="inline-flex h-[52px] items-center justify-center gap-2.5 rounded-pill border-2 border-ink px-6 text-[15.5px] font-bold text-ink transition-colors hover:bg-ink hover:text-white"
              >
                Follow one patient through
              </a>
            </div>

            <p
              className="wl-rise mt-6 max-w-[520px] text-[14px] leading-relaxed text-ink-40"
              style={{ animationDelay: '320ms' }}
            >
              Runs in the browser you already use. Your clinic&rsquo;s own name and logo go on every
              screen.{' '}
              <a
                href="#owners"
                className="font-semibold text-clinical-text underline decoration-clinical/30 underline-offset-4 hover:decoration-clinical"
              >
                {BUSINESS.pricing.from
                  ? `From ${BUSINESS.pricing.from} ${BUSINESS.pricing.per}.`
                  : 'Run a clinic? See how it would work for yours.'}
              </a>
            </p>

            {/* The four beats of a visit, numbered along the foot of the hero. */}
            <ol
              className="wl-rise mt-14 grid gap-x-8 gap-y-6 border-t border-ink/12 pt-7 sm:grid-cols-2 lg:grid-cols-4"
              style={{ animationDelay: '380ms' }}
            >
              {[
                { t: 'Register', b: 'UHID issued the moment the form is saved.' },
                { t: 'Queue', b: 'Gets a token and a doctor. The waiting-room TV updates.' },
                { t: 'Consult', b: 'Vitals, notes and Rx on one panel, printed on the way out.' },
                { t: 'Bill', b: 'Consultation and tests on one receipt. Record complete.' },
              ].map((s, i) => (
                <li key={s.t} className="flex gap-4">
                  <span className="wl-serif text-[44px] leading-[0.8] text-ink-20">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>
                    <span className="block text-[16px] font-bold text-ink">{s.t}</span>
                    <span className="mt-1.5 block text-[13.5px] leading-snug text-ink-60">
                      {s.b}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div
            className="wl-rise relative mx-auto mt-16 max-w-6xl sm:mt-24"
            style={{ animationDelay: '420ms' }}
          >
            {/* A margin note, as if someone had marked up a printout. */}
            <span className="absolute -top-16 left-[3%] hidden items-end gap-1 text-coral-text lg:flex">
              <HandNote className="text-[26px]" rotate={-4}>
                what the front desk sees at 9:30 am
              </HandNote>
              <HandArrow className="-mb-8 h-12 w-16" color="#B23A22" />
            </span>
            <ProductWindow />
          </div>
        </section>

        {/* ==== The paper it replaces ====================================== */}
        <PaperTrail />

        {/* ==== Features bento ============================================ */}
        <section id="features" className="scroll-mt-24 px-4 py-24 sm:px-6 lg:py-32">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="Features"
                title={
                  <>
                    Built for the <span className="text-clinical">fortieth</span> patient of the
                    day.
                  </>
                }
                body="The first patient is easy. By the fortieth the queue is long, the doctor is running late and someone wants a receipt reprinted. Every screen here was drawn with that hour in mind."
              />
            </Reveal>
            <FeatureBento />
          </div>
        </section>

        {/* ==== Roles ====================================================== */}
        <section
          id="roles"
          className="scroll-mt-24 border-y border-ink/8 bg-white/25 px-4 py-24 sm:px-6 lg:py-32"
        >
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="Roles"
                title={
                  <>
                    Five people share the desk PC.{' '}
                    <span className="text-clinical">Each gets their own screen.</span>
                  </>
                }
                body="Front desk, doctor, nurse, owner and admin sign in at the same place and land on what their job needs. Each role has its own colour, so anyone walking past can see whose session is open."
              />
            </Reveal>
            <RolesShowcase night={look === 'night'} />
          </div>
        </section>

        {/* ==== Journey ==================================================== */}
        <section id="workflow" className="scroll-mt-24 px-4 py-24 sm:px-6 lg:py-32">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="How it works"
                title={
                  <>
                    Anil Verma, <span className="text-clinical">9:02 to 9:36.</span>
                  </>
                }
                body="One patient, from the counter to the receipt. His details were typed in once, at registration, and went with him through the visit."
              />
            </Reveal>
            <Journey />
          </div>
        </section>

        {/* ==== Waiting-room display ====================================== */}
        <DisplayShowcase />

        {/* ==== Security =================================================== */}
        <section id="security" className="scroll-mt-24 px-4 py-24 sm:px-6 lg:py-32">
          <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[0.95fr_1.05fr]">
            <Reveal>
              <SectionHead
                align="left"
                eyebrow="Security"
                title={
                  <>
                    Your patients stay <span className="text-clinical">in your clinic.</span>
                  </>
                }
                body={
                  'Clinics on the same system can’t see each other’s records. The database itself enforces that, on every row.' +
                  (BUSINESS.dataRegion ? ` Patient data is stored in ${BUSINESS.dataRegion}.` : '')
                }
              />
              <ul className="mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-2">
                {[
                  {
                    icon: <IconShield size={18} />,
                    title: 'DPDP-ready consent',
                    body: 'Consent is captured at registration and stored with the record it covers.',
                  },
                  {
                    icon: <IconUsers size={18} />,
                    title: 'Clinic-level isolation',
                    body: 'Row-level security keeps each clinic’s patients invisible to every other clinic.',
                  },
                  {
                    icon: <IconKey size={18} />,
                    title: 'Two-factor sign-in',
                    body: 'Roles that hold the clinic’s keys confirm every sign-in with an authenticator code.',
                  },
                  {
                    icon: <IconEyeOff size={18} />,
                    title: 'Every change audited',
                    body: 'Each write records who made it, what changed and when.',
                  },
                ].map((f) => (
                  <li key={f.title} className="flex gap-4">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-panel bg-clinical text-white shadow-sm">
                      {f.icon}
                    </span>
                    <div>
                      <h3 className="text-[16px] font-bold">{f.title}</h3>
                      <p className="mt-1 text-[14px] leading-relaxed text-ink-60">{f.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
              {(BUSINESS.privacyUrl || BUSINESS.dataUrl) && (
                <p className="mt-9 flex flex-wrap gap-x-5 gap-y-2 text-[14px] font-semibold">
                  {BUSINESS.dataUrl && (
                    <a
                      className="text-clinical-text underline underline-offset-4"
                      href={BUSINESS.dataUrl}
                    >
                      How we handle patient data
                    </a>
                  )}
                  {BUSINESS.privacyUrl && (
                    <a
                      className="text-clinical-text underline underline-offset-4"
                      href={BUSINESS.privacyUrl}
                    >
                      Privacy policy
                    </a>
                  )}
                </p>
              )}
            </Reveal>
            <Reveal delay={120}>
              <AuditLog />
            </Reveal>
          </div>
        </section>

        {/* ==== FAQ ======================================================== */}
        <section
          id="faq"
          className="scroll-mt-24 border-t border-ink/8 bg-white/25 px-4 py-24 sm:px-6 lg:py-32"
        >
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead
                align="left"
                eyebrow="FAQ"
                title={
                  <>
                    What clinic owners <span className="text-clinical">ask first.</span>
                  </>
                }
                body="Staff with a sign-in question will find the answers on the sign-in page itself, under “Trouble signing in?”."
              />
            </Reveal>
            <Reveal delay={100}>
              <FaqList />
            </Reveal>
          </div>
        </section>

        {/* ==== Two doors ================================================= */}
        {/* Everything above leads to "Sign in", which leaves a clinic owner who
            is only curious with nowhere to go. So the page ends on two doors:
            one for the people who work there, one for the person who runs it. */}
        <section
          id="owners"
          aria-label="Get started"
          className="scroll-mt-24 px-4 py-20 sm:px-6 lg:py-28"
        >
          <Reveal className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[1.15fr_1fr]">
            <div className="relative isolate overflow-hidden rounded-[32px] bg-clinical-deep px-7 py-12 text-white shadow-lg sm:px-10 lg:py-16">
              <div
                aria-hidden="true"
                className="absolute inset-0 -z-10 opacity-[0.14]"
                style={{
                  backgroundImage:
                    'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
                  backgroundSize: '44px 44px',
                  maskImage: 'radial-gradient(ellipse at 30% 40%, black 10%, transparent 70%)',
                  WebkitMaskImage:
                    'radial-gradient(ellipse at 30% 40%, black 10%, transparent 70%)',
                }}
              />
              <div
                aria-hidden="true"
                className="absolute -right-24 -top-32 -z-10 h-96 w-96 rounded-full bg-[#18a092]/50 blur-3xl"
              />
              <p className="text-[14px] font-semibold text-white/60">I work at a clinic</p>
              <h2 className="mt-3 text-[clamp(30px,4.4vw,52px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-white">
                Today&rsquo;s queue is <span className="wl-serif text-[#7fe0d2]">waiting.</span>
              </h2>
              <p className="mt-4 max-w-md text-[16px] leading-relaxed text-white/70">
                Sign in with your clinic account. New to the team? Your clinic administrator will
                set up your account.
              </p>
              <div className="mt-9">
                <Link
                  href={primary.href}
                  onClick={openSignIn}
                  className="group inline-flex h-12 items-center justify-center gap-2.5 rounded-pill bg-white px-7 text-[15px] font-bold text-clinical-deep shadow-sm transition-all hover:bg-bg-soft"
                >
                  {signedIn ? 'Open console' : 'Staff sign-in'}
                  <span className="transition-transform group-hover:translate-x-0.5">
                    <ArrowRight size={16} />
                  </span>
                </Link>
              </div>
            </div>

            <div className="flex flex-col rounded-[32px] border border-ink/10 bg-white/70 px-7 py-12 backdrop-blur-xl sm:px-10 lg:py-16">
              <p className="text-[14px] font-semibold text-ink-40">I run a clinic</p>
              <h2 className="wl-head mt-3 text-[clamp(28px,3.6vw,44px)] font-extrabold leading-[1.04] tracking-[-0.035em]">
                See it with <span className="text-clinical">your own clinic</span> in mind.
              </h2>
              <p className="mt-4 max-w-sm text-[16px] leading-relaxed text-ink-60">
                A 20-minute call that walks through a morning at your front desk: registration, the
                queue, the doctor&rsquo;s screen and the day&rsquo;s collections.
              </p>
              {BUSINESS.pricing.from && (
                <p className="mt-6 text-[15px] text-ink">
                  <span className="font-display text-[26px] font-extrabold tracking-[-0.02em]">
                    {BUSINESS.pricing.from}
                  </span>{' '}
                  <span className="text-ink-60">{BUSINESS.pricing.per}</span>
                  {BUSINESS.pricing.trial && (
                    <span className="mt-1 block text-[14px] font-semibold text-clinical-text">
                      {BUSINESS.pricing.trial}
                    </span>
                  )}
                </p>
              )}
              <div className="mt-auto flex flex-wrap items-center gap-3 pt-9">
                {BUSINESS.email && (
                  <button
                    type="button"
                    onClick={() => setDemoOpen(true)}
                    className="group inline-flex h-12 items-center justify-center gap-2.5 rounded-pill border-2 border-ink px-7 text-[15px] font-bold text-ink transition-colors hover:bg-ink hover:text-white"
                  >
                    Book a demo
                    <span className="transition-transform group-hover:translate-x-0.5">
                      <ArrowRight size={16} />
                    </span>
                  </button>
                )}
                {BUSINESS.whatsapp && (
                  <a
                    href={`https://wa.me/${BUSINESS.whatsapp}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-12 items-center rounded-pill bg-[#1F8F55] px-6 text-[15px] font-bold text-white hover:bg-[#177544]"
                  >
                    WhatsApp us
                  </a>
                )}
                {BUSINESS.phone && (
                  <a
                    href={`tel:${BUSINESS.phone.replace(/[^+\d]/g, '')}`}
                    className="inline-flex h-12 items-center rounded-pill px-2 text-[15px] font-semibold text-clinical-text underline underline-offset-4"
                  >
                    Call {BUSINESS.phone}
                  </a>
                )}
                {!OWNER_CONTACT && (
                  <p className="inline-flex h-12 items-center rounded-pill border-2 border-dashed border-ink/15 px-6 text-[15px] font-semibold text-ink-40">
                    Demo booking opens soon
                  </p>
                )}
              </div>
            </div>
          </Reveal>
        </section>

        {(BUSINESS.pilot.quote || BUSINESS.founder.story) && (
          <section aria-label="Who is behind it" className="px-4 pb-24 sm:px-6">
            <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-2">
              {BUSINESS.pilot.quote && BUSINESS.pilot.name && (
                <Reveal>
                  <figure className="h-full rounded-[28px] border border-ink/10 bg-white/70 p-8 backdrop-blur-xl sm:p-10">
                    <p className="text-[14px] font-semibold text-ink-40">Used every day at</p>
                    <p className="mt-1 font-display text-[20px] font-extrabold tracking-[-0.02em]">
                      {BUSINESS.pilot.clinic}
                      {BUSINESS.pilot.city && (
                        <span className="text-ink-40">, {BUSINESS.pilot.city}</span>
                      )}
                    </p>
                    <blockquote className="wl-serif mt-6 text-[clamp(22px,2.4vw,30px)] leading-snug text-ink">
                      &ldquo;{BUSINESS.pilot.quote}&rdquo;
                    </blockquote>
                    <figcaption className="mt-6 text-[14.5px]">
                      <span className="font-semibold text-ink">{BUSINESS.pilot.name}</span>
                      {BUSINESS.pilot.role && (
                        <span className="text-ink-60"> · {BUSINESS.pilot.role}</span>
                      )}
                    </figcaption>
                  </figure>
                </Reveal>
              )}
              {BUSINESS.founder.name && BUSINESS.founder.story && (
                <Reveal delay={80}>
                  <div className="h-full rounded-[28px] border border-ink/10 bg-white/70 p-8 backdrop-blur-xl sm:p-10">
                    <p className="text-[14px] font-semibold text-ink-40">Who is behind it</p>
                    <p className="mt-4 text-[16.5px] leading-relaxed text-ink-60">
                      {BUSINESS.founder.story}
                    </p>
                    <p className="mt-6 text-[14.5px]">
                      <span className="font-semibold text-ink">{BUSINESS.founder.name}</span>
                      {BUSINESS.founder.role && (
                        <span className="text-ink-60"> · {BUSINESS.founder.role}</span>
                      )}
                    </p>
                  </div>
                </Reveal>
              )}
            </div>
          </section>
        )}
      </main>

      {/* ==== Footer ======================================================= */}
      <footer className="border-t border-ink/8 bg-bg-soft px-4 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-10 py-14 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <span className="flex items-center gap-2">
              <ConsoleMark size={28} />
              <span className="font-display text-[16px] font-extrabold tracking-display">
                Clinic <span className="text-clinical">Console</span>
              </span>
            </span>
            <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-ink-40">
              Made for outpatient clinics in India.
            </p>
            {(BUSINESS.companyName || BUSINESS.address || BUSINESS.email || BUSINESS.phone) && (
              <address className="mt-4 space-y-1 text-[13.5px] not-italic leading-relaxed text-ink-60">
                {BUSINESS.companyName && (
                  <span className="block font-semibold text-ink">{BUSINESS.companyName}</span>
                )}
                {BUSINESS.address && <span className="block">{BUSINESS.address}</span>}
                {BUSINESS.phone && <span className="block select-all">{BUSINESS.phone}</span>}
                {BUSINESS.email && <span className="block select-all">{BUSINESS.email}</span>}
              </address>
            )}
          </div>
          <FooterCol title="Product" links={NAV.slice(0, 4)} />
          <FooterCol
            title="Staff"
            links={[
              { href: primary.href, label: primary.label },
              { href: '/login', label: 'Help signing in' },
            ]}
          />
        </div>
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 border-t border-ink/8 py-6 sm:flex-row">
          <p className="text-[12.5px] text-ink-40">
            © {new Date().getFullYear()} {BUSINESS.companyName || 'Clinic Console'}
          </p>
          <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-ink-40">
            {BUSINESS.privacyUrl && (
              <a className="hover:text-ink" href={BUSINESS.privacyUrl}>
                Privacy
              </a>
            )}
            {BUSINESS.termsUrl && (
              <a className="hover:text-ink" href={BUSINESS.termsUrl}>
                Terms
              </a>
            )}
            {BUSINESS.statusUrl && (
              <a className="flex items-center gap-2 hover:text-ink" href={BUSINESS.statusUrl}>
                <span className="h-1.5 w-1.5 rounded-full bg-green" />
                System status
              </a>
            )}
          </p>
        </div>
      </footer>

      {signInOpen && !signedIn && <SignInDialog onClose={closeSignIn} />}
      {demoOpen && BUSINESS.email && <DemoDialog onClose={closeDemo} />}
    </div>
  );
}

/* ========================================================================== */
/*  Building blocks                                                            */
/* ========================================================================== */

/**
 * The modal shell both pop-ups use: the page dims and blurs behind a card,
 * focus is kept inside while it is open and handed back to whatever opened it
 * afterwards, Escape and the backdrop close it, and the page behind does not
 * scroll. On phones it rises from the bottom as a sheet.
 */
function Modal({
  label,
  onClose,
  className = '',
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-6">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="wl-fade absolute inset-0 bg-[#0c1a19]/45 backdrop-blur-md"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`wl-pop relative max-h-[94dvh] w-full overflow-y-auto rounded-t-[28px] bg-bg-soft shadow-[0_40px_120px_-20px_rgba(0,0,0,0.55)] sm:rounded-[28px] ${className}`}
      >
        {/* A zero-height sticky strip, so the close button stays in reach when a
            tall card (larger text, two-factor steps) scrolls inside the dialog. */}
        <div className="pointer-events-none sticky top-0 z-10 flex h-0 justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${label.toLowerCase()}`}
            className="pointer-events-auto mr-4 mt-4 grid h-10 w-10 shrink-0 place-items-center rounded-full border border-ink/10 bg-white/90 text-ink shadow-sm backdrop-blur transition-colors hover:bg-white"
          >
            <IconX size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The sign-in pop-up: a two-panel card, the form on the left and the front
 * desk on the right. Its contents are the real sign-in page
 * (app/login/page.tsx), which lays itself out for a dialog when it is not at
 * /login.
 */
function SignInDialog({ onClose }: { onClose: () => void }) {
  return (
    // No overflow-hidden here: with larger text the form is taller than a
    // laptop screen, and the dialog has to be able to scroll to its button.
    <Modal label="Staff sign-in" onClose={onClose} className="max-w-[1000px]">
      <LoginPage />
    </Modal>
  );
}

/**
 * "Book a demo", for clinic owners. There is no server behind it: submitting
 * opens the visitor's own email app with the request already written out to
 * BUSINESS.email. The page cannot tell whether the email app opened, so
 * the confirmation says so and shows the address to use instead.
 */
function DemoDialog({ onClose }: { onClose: () => void }) {
  const [sent, setSent] = useState(false);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const field = (k: string) => String(data.get(k) ?? '').trim();
    const body = [
      `Name: ${field('demo-name')}`,
      `Clinic: ${field('demo-clinic')}`,
      `City: ${field('demo-city') || '-'}`,
      `Phone: ${field('demo-phone')}`,
    ].join('\n');
    const subject = `Demo request: ${field('demo-clinic')}`;
    window.location.href = `mailto:${BUSINESS.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    setSent(true);
  }

  const input =
    'h-11 w-full rounded-[12px] border border-ink/12 bg-white px-3.5 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-20 focus:border-clinical focus:ring-4 focus:ring-clinical/12';

  return (
    <Modal label="Book a demo" onClose={onClose} className="max-w-[520px]">
      <div className="px-6 pb-8 pt-9 sm:px-9">
        {sent ? (
          <div className="pr-8">
            <h2 className="text-[26px] font-extrabold leading-tight tracking-[-0.03em]">
              Your email should be <span className="wl-serif text-clinical">ready to send.</span>
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-60">
              We opened your email app with the request written out. If nothing opened, send the
              same details to{' '}
              <span className="select-all font-semibold text-ink">{BUSINESS.email}</span>.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-7 inline-flex h-11 items-center rounded-pill bg-clinical px-6 text-[14.5px] font-bold text-white hover:bg-clinical-deep"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div className="pr-8">
              <h2 className="text-[26px] font-extrabold leading-tight tracking-[-0.03em]">
                Book a <span className="wl-serif text-clinical">demo.</span>
              </h2>
              <p className="mt-2 text-[14.5px] text-ink-60">
                Twenty minutes, at a time that suits your OPD. We&rsquo;ll call you to fix it.
              </p>
            </div>
            <label
              className="grid gap-1.5 text-[13px] font-semibold text-ink-60"
              htmlFor="demo-name"
            >
              Your name
              <input
                id="demo-name"
                name="demo-name"
                required
                autoComplete="name"
                className={input}
              />
            </label>
            <label
              className="grid gap-1.5 text-[13px] font-semibold text-ink-60"
              htmlFor="demo-clinic"
            >
              Clinic
              <input
                id="demo-clinic"
                name="demo-clinic"
                required
                autoComplete="organization"
                className={input}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label
                className="grid gap-1.5 text-[13px] font-semibold text-ink-60"
                htmlFor="demo-city"
              >
                City
                <input
                  id="demo-city"
                  name="demo-city"
                  autoComplete="address-level2"
                  className={input}
                />
              </label>
              <label
                className="grid gap-1.5 text-[13px] font-semibold text-ink-60"
                htmlFor="demo-phone"
              >
                Phone
                <input
                  id="demo-phone"
                  name="demo-phone"
                  type="tel"
                  required
                  autoComplete="tel"
                  inputMode="tel"
                  className={input}
                />
              </label>
            </div>
            <button
              type="submit"
              className="mt-2 inline-flex h-12 items-center justify-center rounded-pill bg-clinical text-[15px] font-bold text-white transition-colors hover:bg-clinical-deep"
            >
              Write the request
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}

/** Fades a block up the first time it scrolls into view. */
function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{ transitionDelay: shown ? `${delay}ms` : '0ms' }}
      className={`transition-[opacity,transform] duration-700 ease-out ${
        shown ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
      } ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A section's opening: a numbered label row ruled across the width, then a big
 * heavy heading. 'wide' puts the body copy to the right of the heading on large
 * screens; 'left' stacks them, for heads that sit in a two-column section.
 * The heading's accent words (`text-clinical`) are set in the italic serif.
 */
function SectionHead({
  eyebrow,
  title,
  body,
  align = 'wide',
}: {
  eyebrow: string;
  title: ReactNode;
  body: string;
  align?: 'wide' | 'left';
}) {
  const wide = align === 'wide';
  return (
    <div>
      <p className="flex items-baseline gap-3">
        <span className="text-[14px] font-semibold text-ink-60">{eyebrow}</span>
        <span aria-hidden="true" className="h-px flex-1 self-center bg-ink/12" />
      </p>
      <div
        className={wide ? 'mt-7 grid items-end gap-6 lg:grid-cols-[1.25fr_1fr] lg:gap-16' : 'mt-7'}
      >
        <h2 className="wl-head text-[clamp(32px,5vw,60px)] font-extrabold leading-[0.98] tracking-[-0.04em]">
          {title}
        </h2>
        <p
          className={`text-[16.5px] leading-relaxed text-ink-60 ${wide ? 'max-w-md lg:pb-2' : 'mt-5 max-w-xl'}`}
        >
          {body}
        </p>
      </div>
    </div>
  );
}

function HeroBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(22,24,28,0.055) 1px, transparent 1px), linear-gradient(to bottom, rgba(22,24,28,0.055) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse 70% 55% at 50% 0%, black 30%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 70% 55% at 50% 0%, black 30%, transparent 100%)',
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero product window                                                        */
/* -------------------------------------------------------------------------- */

const QUEUE_ROWS = [
  {
    token: '19',
    name: 'Anil Verma',
    meta: '42 · M',
    doctor: 'Dr. Rao',
    status: 'In chamber',
    tone: 'clinical',
    wait: '—',
  },
  {
    token: '20',
    name: 'Meera Pillai',
    meta: '67 · F',
    doctor: 'Dr. Rao',
    status: 'Waiting',
    tone: 'amber',
    wait: '23 min',
  },
  {
    token: '21',
    name: 'Arjun Mehta',
    meta: '29 · M',
    doctor: 'Dr. Iyer',
    status: 'Priority',
    tone: 'coral',
    wait: '2 min',
  },
  {
    token: '22',
    name: 'Venkatalakshmi Subramanian',
    meta: '58 · F',
    doctor: 'Dr. Iyer',
    status: 'Waiting',
    tone: 'amber',
    wait: '1 min',
  },
  {
    token: '17',
    name: 'Sameer Qureshi',
    meta: '35 · M',
    doctor: 'Dr. Iyer',
    status: 'No-show',
    tone: 'neutral',
    wait: '—',
  },
  {
    token: '18',
    name: 'Rohan Das',
    meta: '51 · M',
    doctor: 'Dr. Rao',
    status: 'Seen',
    tone: 'green',
    wait: 'Paid',
  },
] as const;

const BADGE_TONE = {
  clinical: 'badge-clinical',
  amber: 'badge-amber',
  coral: 'badge-coral',
  green: 'badge-green',
  neutral: 'badge-neutral',
} as const;

/**
 * A still of the queue screen, drawn rather than screenshotted so it stays
 * sharp at every size and costs no image request. On desktop it starts tilted
 * back and settles flat as the page scrolls; the transform is written straight
 * to the element so scrolling never re-renders React.
 */
function ProductWindow() {
  const tiltRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tiltRef.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const desktop = window.matchMedia('(min-width: 1024px)');

    const apply = () => {
      if (reduce.matches || !desktop.matches) {
        el.style.transform = '';
        return;
      }
      const t = Math.max(0, 16 - window.scrollY / 22);
      el.style.transform = `rotateX(${t.toFixed(2)}deg) scale(${(1 - t / 320).toFixed(4)})`;
    };

    apply();
    window.addEventListener('scroll', apply, { passive: true });
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
    };
  }, []);

  return (
    <div className="relative [perspective:2200px]">
      {/* Glow under the window */}
      <div
        aria-hidden="true"
        className="absolute inset-x-[8%] -bottom-10 top-[20%] -z-10 rounded-[40px] bg-clinical/25 blur-3xl"
      />

      <div
        ref={tiltRef}
        className="origin-top transition-transform duration-200 ease-out will-change-transform"
      >
        <div className="overflow-hidden rounded-[20px] border border-ink/10 bg-white shadow-[0_50px_100px_-30px_rgba(11,79,73,0.35),0_18px_40px_-18px_rgba(60,50,35,0.25)] sm:rounded-[24px]">
          {/* Browser chrome */}
          <div className="flex items-center gap-3 border-b border-ink/8 bg-bg-soft px-4 py-2.5">
            <span className="flex gap-1.5" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-coral/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-green/70" />
            </span>
            <span className="mx-auto flex max-w-xs flex-1 items-center justify-center gap-1.5 truncate rounded-pill border border-ink/8 bg-white px-3 py-1 font-mono text-[10.5px] text-ink-40">
              <IconLock size={10} />
              sunrise-clinic · queue
            </span>
            <span className="w-10" />
          </div>

          <div className="grid md:grid-cols-[190px_1fr] xl:grid-cols-[190px_1fr_250px]">
            {/* Sidebar */}
            <aside className="hidden flex-col border-r border-ink/8 bg-bg-soft/60 p-3 md:flex">
              <div className="flex items-center gap-2 px-2 py-2">
                <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-clinical font-display text-[11px] font-bold text-white">
                  SC
                </span>
                <span className="text-[13px] font-bold leading-tight">Sunrise Clinic</span>
              </div>
              <ul className="mt-3 space-y-0.5 text-[12.5px]">
                {[
                  { icon: <IconHome size={15} />, label: 'Home' },
                  { icon: <IconClock size={15} />, label: 'Queue', active: true, count: '7' },
                  { icon: <IconUsers size={15} />, label: 'Patients' },
                  { icon: <IconCalendar size={15} />, label: 'Appointments' },
                  { icon: <FlaskGlyph size={15} />, label: 'Diagnostics' },
                  { icon: <IconReceipt size={15} />, label: 'Finance' },
                ].map((item) => (
                  <li
                    key={item.label}
                    className={`flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 ${
                      item.active ? 'bg-[#e2e6f6] font-semibold text-[#2b3a75]' : 'text-ink-60'
                    }`}
                  >
                    {item.icon}
                    <span className="flex-1">{item.label}</span>
                    {item.count && (
                      <span className="rounded-pill bg-[#3a4e9b] px-1.5 font-mono text-[10px] text-white">
                        {item.count}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-auto rounded-panel border border-ink/8 bg-white p-2.5">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-[#3a4e9b] text-[10.5px] font-bold text-white">
                    PS
                  </span>
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate text-[12px] font-semibold">Pooja Singh</span>
                    <span className="block text-[10.5px] text-[#2b3a75]">Front desk</span>
                  </span>
                </div>
              </div>
            </aside>

            {/* Main */}
            <div className="min-w-0 p-4 sm:p-5">
              <div className="flex items-center gap-3">
                <div className="flex flex-1 items-center gap-2 rounded-pill border border-ink/10 bg-bg-soft px-3 py-2 text-[12.5px] text-ink-40">
                  <IconSearch size={14} />
                  <span className="flex-1 truncate">Search name, mobile, UHID or ABHA</span>
                  <kbd className="hidden rounded-[6px] border border-ink/12 bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink-40 sm:inline">
                    Ctrl K
                  </kbd>
                </div>
                <span className="relative hidden h-9 w-9 place-items-center rounded-full border border-ink/10 text-ink-60 sm:grid">
                  <IconBell size={15} />
                  <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-coral" />
                </span>
              </div>

              <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
                <div className="text-left">
                  <p className="mono-label">Wed, 24 Sep · OPD 2</p>
                  <p className="mt-1 font-display text-[22px] font-bold tracking-display">
                    Today&rsquo;s queue
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-pill bg-clinical px-3.5 py-2 text-[12.5px] font-semibold text-white">
                  <IconUserPlus size={14} />
                  Add walk-in
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                {[
                  { k: 'Waiting', v: '07', c: 'text-amber-text', bar: 'bg-amber', w: '45%' },
                  {
                    k: 'In chamber',
                    v: '02',
                    c: 'text-clinical-text',
                    bar: 'bg-clinical',
                    w: '15%',
                  },
                  { k: 'Seen today', v: '23', c: 'text-green-text', bar: 'bg-green', w: '78%' },
                  { k: 'Collected', v: '₹18,400', c: 'text-ink', bar: 'bg-ink/70', w: '62%' },
                ].map((s) => (
                  <div
                    key={s.k}
                    className="rounded-panel border border-ink/8 bg-white p-3 text-left"
                  >
                    <p className="mono-label !text-[9.5px]">{s.k}</p>
                    <p className={`mt-1 font-display text-[20px] font-bold leading-none ${s.c}`}>
                      {s.v}
                    </p>
                    <div className="mt-2.5 h-1 rounded-full bg-ink/6">
                      <div className={`h-1 rounded-full ${s.bar}`} style={{ width: s.w }} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 overflow-hidden rounded-panel border border-ink/8 text-left">
                <div className="grid grid-cols-[44px_1fr_auto] items-center gap-3 border-b border-ink/8 bg-bg-soft px-3 py-2 sm:grid-cols-[44px_1.4fr_1fr_1fr_70px]">
                  <span className="mono-label !text-[9.5px]">Token</span>
                  <span className="mono-label !text-[9.5px]">Patient</span>
                  <span className="mono-label hidden !text-[9.5px] sm:block">Doctor</span>
                  <span className="mono-label !text-[9.5px]">Status</span>
                  <span className="mono-label hidden text-right !text-[9.5px] sm:block">Wait</span>
                </div>
                {QUEUE_ROWS.map((r) => (
                  <div
                    key={r.token}
                    className={`grid grid-cols-[44px_1fr_auto] items-center gap-3 border-b border-ink/6 px-3 py-2.5 last:border-b-0 sm:grid-cols-[44px_1.4fr_1fr_1fr_70px] ${
                      r.tone === 'clinical' ? 'bg-clinical-tint/70' : ''
                    } ${r.tone === 'green' ? 'opacity-60' : ''}`}
                  >
                    <span className="font-mono text-[13px] font-semibold text-ink">{r.token}</span>
                    <span className="min-w-0">
                      <span
                        className={`block truncate text-[13px] font-semibold ${r.tone === 'neutral' ? 'text-ink-40 line-through decoration-ink-20' : ''}`}
                      >
                        {r.name}
                      </span>
                      <span className="block font-mono text-[10.5px] text-ink-40">{r.meta}</span>
                    </span>
                    <span className="hidden text-[12.5px] text-ink-60 sm:block">{r.doctor}</span>
                    <span>
                      <span className={BADGE_TONE[r.tone]}>{r.status}</span>
                    </span>
                    <span className="hidden text-right font-mono text-[11.5px] text-ink-40 sm:block">
                      {r.wait}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right rail */}
            <aside className="hidden border-l border-ink/8 bg-bg-soft/60 p-4 text-left xl:block">
              <p className="mono-label">In chamber · Room 2</p>
              <div className="mt-3 rounded-panel border border-ink/8 bg-white p-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-clinical-soft font-display text-[12px] font-bold text-clinical-text">
                    AV
                  </span>
                  <span className="leading-tight">
                    <span className="block text-[13.5px] font-semibold">Anil Verma</span>
                    <span className="block font-mono text-[10.5px] text-ink-40">UH-24-0871</span>
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-1.5">
                  {[
                    { l: 'BP', v: '124/82' },
                    { l: 'Pulse', v: '78' },
                    { l: 'SpO₂', v: '98%' },
                    { l: 'Temp', v: '98.4°' },
                  ].map((v) => (
                    <div key={v.l} className="rounded-[8px] bg-bg-soft px-2 py-1.5">
                      <p className="font-mono text-[9px] uppercase tracking-label text-ink-40">
                        {v.l}
                      </p>
                      <p className="font-mono text-[12.5px] font-semibold">{v.v}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11.5px] text-ink-40">with Dr. Kiran Rao · 12 min</p>
              </div>

              <p className="mono-label mt-5">Up next</p>
              <div className="mt-2 space-y-1.5">
                {[
                  { t: '20', n: 'Meera Pillai' },
                  { t: '21', n: 'Arjun Mehta' },
                ].map((p) => (
                  <div
                    key={p.t}
                    className="flex items-center gap-2.5 rounded-[10px] border border-ink/8 bg-white px-2.5 py-2"
                  >
                    <span className="grid h-6 w-7 place-items-center rounded-[6px] bg-clinical-soft font-mono text-[11px] font-bold text-clinical-text">
                      {p.t}
                    </span>
                    <span className="text-[12.5px] font-medium">{p.n}</span>
                  </div>
                ))}
              </div>
              <span className="mt-4 flex w-full items-center justify-center gap-2 rounded-pill bg-ink py-2.5 text-[12.5px] font-semibold text-white">
                Call next · Token 20
              </span>
            </aside>
          </div>
        </div>
      </div>

      {/* Floating notices */}
      <div
        className="wl-float absolute -left-6 top-[34%] hidden items-center gap-3 rounded-panel border border-ink/8 bg-white/95 px-4 py-3 shadow-lg backdrop-blur lg:flex xl:-left-14"
        aria-hidden="true"
      >
        <span className="grid h-9 w-9 place-items-center rounded-full bg-amber-soft text-amber-text">
          <IconUsers size={16} />
        </span>
        <span className="text-left">
          <span className="block text-[13px] font-semibold leading-tight">Possible duplicate</span>
          <span className="block font-mono text-[10.5px] text-ink-40">
            Priya Sharma · UH-24-0192
          </span>
        </span>
      </div>
      <div
        className="wl-float absolute -right-6 bottom-[14%] hidden items-center gap-3 rounded-panel border border-ink/8 bg-white/95 px-4 py-3 shadow-lg backdrop-blur lg:flex xl:-right-14"
        style={{ animationDelay: '-3s' }}
        aria-hidden="true"
      >
        <span className="grid h-9 w-9 place-items-center rounded-full bg-green-soft text-green-text">
          <IconCheck size={16} />
        </span>
        <span className="text-left">
          <span className="block text-[13px] font-semibold leading-tight">Payment recorded</span>
          <span className="block font-mono text-[10.5px] text-ink-40">Receipt R-1042 · ₹850</span>
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The paper it replaces                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Four things on every OPD desk in India, sketched in pen, each pointing at the
 * part of the console that takes its job. Every "now" line names a feature that
 * exists; nothing here is aspirational.
 *
 * The sketches are deliberately a little crooked — drawn, not rendered — and
 * the cards sit at slightly different angles, like index cards pinned to a
 * board.
 */
function PaperTrail() {
  const items = [
    {
      sketch: <SketchTokenRoll />,
      was: 'the token roll',
      now: 'A live queue, and token numbers on the waiting-room TV.',
      href: '#display',
      tilt: -1.2,
    },
    {
      sketch: <SketchRegister />,
      was: 'the big register',
      now: 'Find any patient by name, mobile, UHID or ABHA in one box.',
      href: '#features',
      tilt: 0.8,
    },
    {
      sketch: <SketchReceiptBook />,
      was: 'the carbon receipt book',
      now: 'One bill for consultation and tests, and a receipt in a click.',
      href: '#features',
      tilt: -0.6,
    },
    {
      sketch: <SketchRxPad />,
      was: 'the Rx pad',
      now: 'Prescriptions printed on your own letterhead.',
      href: '#features',
      tilt: 1.1,
    },
  ];

  return (
    <section
      id="paper"
      aria-label="What it replaces"
      className="relative scroll-mt-24 px-4 py-24 sm:px-6 lg:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <SectionHead
            eyebrow="What it replaces"
            title={
              <>
                What goes <Underlined>in the drawer.</Underlined>
              </>
            }
            body="Most OPDs run on the same four things: a token roll, a thick register, a carbon receipt book and an Rx pad. Each one has a screen here that does its job."
          />
        </Reveal>

        <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((it, i) => (
            <li key={it.was}>
              <Reveal delay={i * 90} className="h-full">
                <a
                  href={it.href}
                  className="group flex h-full flex-col rounded-card border border-ink/10 bg-[#FFFDF8] p-5 shadow-sm transition-shadow duration-300 hover:border-clinical/30 hover:shadow-lg"
                  style={{ transform: `rotate(${it.tilt}deg)` }}
                >
                  <div
                    className="grid h-36 place-items-center rounded-[14px] text-ink-60"
                    style={{
                      backgroundImage:
                        'repeating-linear-gradient(to bottom, transparent 0 23px, rgba(58,78,155,0.09) 23px 24px)',
                    }}
                  >
                    {it.sketch}
                  </div>
                  <HandNote className="mt-4 text-[24px] text-ink-60" rotate={-2}>
                    <span className="line-through decoration-coral decoration-2">{it.was}</span>
                  </HandNote>
                  <p className="mt-3 flex-1 text-[14.5px] font-medium leading-snug text-ink">
                    {it.now}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-clinical-text">
                    See how
                    <span className="transition-transform group-hover:translate-x-0.5">
                      <ArrowRight size={13} />
                    </span>
                  </span>
                </a>
              </Reveal>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Shared pen settings for the sketches: one ink, one nib. */
function Sketch({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 160 110"
      className="h-28 w-40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function SketchTokenRoll() {
  return (
    <Sketch>
      {/* A strip of tear-off tickets, the last one half torn and curling. */}
      <path d="M14 34.6 106.4 32.8 107.2 77.4 14.8 79.2z" />
      <path d="M45 34 45.6 78.6M76 33.4l.6 44.6" strokeDasharray="2.4 3.4" />
      <path d="M107 33c9.6 1.8 18.4-1.2 27.6 3.4l8.4 40.2c-9-3.2-18.4-.6-35.6.8" />
      <path d="M134.4 36.6c-2.4 2.8-2.2 5.8.4 8.6" />
      <path d="M22 43.4c6.4-.2 13-.3 19.4-.2M53 42.9c6.4-.2 13-.3 19.4-.2M84 42.3c6.4-.2 13-.3 19.4-.1M114.6 43.2c5.8.2 11.2.8 16.6 1.8" />
      {[
        { x: 29.5, y: 68, n: '21' },
        { x: 60.8, y: 67.4, n: '22' },
        { x: 91.8, y: 66.8, n: '23' },
      ].map((t) => (
        <text
          key={t.n}
          x={t.x}
          y={t.y}
          textAnchor="middle"
          fontFamily="var(--font-display), sans-serif"
          fontSize="17"
          fontWeight="800"
          stroke="none"
          fill="currentColor"
        >
          {t.n}
        </text>
      ))}
      <text
        x="125"
        y="65"
        textAnchor="middle"
        fontFamily="var(--font-display), sans-serif"
        fontSize="16"
        fontWeight="800"
        stroke="none"
        fill="currentColor"
        transform="rotate(8 125 65)"
      >
        24
      </text>
    </Sketch>
  );
}

function SketchRegister() {
  return (
    <Sketch>
      <path d="M80 22.5c-15-7.4-40-8.8-62-4.1l1.6 73.2c20.6-4.8 44.1-3.6 60.8 4.2" />
      <path d="M80 22.5c15.2-7.2 40.4-8.2 62.4-3.3l-1.9 73c-20.1-4.6-44-3.8-60.9 4.1" />
      <path d="M80 22.5 80.4 95.8" />
      <path d="M28 34.5c13-1.6 26.5-1.6 42 .6M28.4 45.7c13.2-1.4 26.6-1.2 41.6.9M28.6 57c11.6-1.2 24.6-1 41.4.7M29 68.2c12-1 25-1 40.8.8M29.2 79.4c10-.8 20.6-.8 30.8.2" />
      <path d="M90 35.1c14.8-2.4 28.6-2.6 42.2-1M90.2 46.4c14-2 27.8-2.1 41.6-.7M90.4 57.7c13.4-1.8 27-1.8 41.2-.5M90.6 68.9c11-1.5 22.4-1.6 33.4-.8" />
      <path d="M42 28.2v58.4" strokeDasharray="2 4" />
    </Sketch>
  );
}

function SketchReceiptBook() {
  return (
    <Sketch>
      <path d="M36 26.4 124.6 24.8 126 94.4 37.4 95.8z" />
      <path d="M40.6 21.5 128.8 20.4 130 88.8" opacity="0.55" />
      <path d="M36.2 38.4c29.4-1.2 59-1.8 88.6-1.5" strokeDasharray="4 3.2" />
      <text
        x="48"
        y="33.5"
        fontFamily="var(--font-mono), monospace"
        fontSize="8"
        stroke="none"
        fill="currentColor"
      >
        No. 0417
      </text>
      <path d="M48 52.6c18-.8 36-.9 54-.4M48.2 63.4c14.8-.6 29.8-.6 44.6-.2M48.4 74.2c20.4-.7 41-.6 61.4 0" />
      <path d="M106.5 52.4c2.2 0 4.4.1 6.6.3M98 63.2c5 0 10 .1 15 .3" />
      <path d="M92 86.4c4-3.8 7.4-4.4 9.6-1.2 2.4 3.4 5.6 3.2 9.8-1.4" />
    </Sketch>
  );
}

function SketchRxPad() {
  return (
    <Sketch>
      <path d="M44 14.6 118.2 15.8 116.4 99.4 42.4 98.2z" />
      <path d="M52 9.8v9.4M64 9.8v9.4M76 9.9v9.4M88 10v9.4M100 10.1v9.4M112 10.2v9.4" />
      <path d="M54.4 27.8c14.2-.5 28.2-.6 42.4-.2" />
      <path d="M56 44.6V62.4M56 44.8h7.4c5.2 0 7.6 2.2 7.6 5s-2.6 4.8-7.4 4.8H56m7.6.2 9.6 11.2M73.2 57.4 64.8 66.8" />
      <path d="M80 50.2c9.8-.4 19.8-.4 29.4-.1M80.4 60.4c8.2-.3 16.6-.3 25-.1M56.2 76.4c16-.6 32.4-.6 49 0M56.6 86.2c11.4-.4 23-.4 34.6-.1" />
    </Sketch>
  );
}

/* -------------------------------------------------------------------------- */
/*  Marquee                                                                    */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Feature bento                                                              */
/* -------------------------------------------------------------------------- */

function FeatureBento() {
  return (
    <div className="mt-14 grid gap-4 lg:grid-cols-3">
      {/* Registration */}
      <Reveal className="lg:col-span-2">
        <Tile
          icon={<IconUserPlus size={18} />}
          title="Registration that catches duplicates"
          body="One keyboard-first screen. The duplicate check runs while you type, and the UHID is issued the moment you save."
        >
          <RegistrationDemo />
        </Tile>
      </Reveal>

      {/* Search */}
      <Reveal className="lg:row-span-2" delay={80}>
        <Tile
          icon={<IconSearch size={18} />}
          title="Find anyone in one box"
          body="Name, mobile, UHID or ABHA number. No filters, and spelling slips are forgiven."
        >
          <div className="mt-6 overflow-hidden rounded-[16px] border border-ink/8 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-ink/8 px-3.5 py-3 text-[13px]">
              <span className="text-ink-40">
                <IconSearch size={15} />
              </span>
              <span className="flex-1 font-medium">sharma</span>
              <kbd className="rounded-[6px] border border-ink/12 bg-bg-soft px-1.5 py-0.5 font-mono text-[10px] text-ink-40">
                Ctrl K
              </kbd>
            </div>
            <ul className="p-1.5">
              {[
                { n: 'Priya Sharma', m: '34 F · UH-24-0192', active: true },
                { n: 'Rakesh Sharma', m: '58 M · UH-23-1177' },
                { n: 'Anjali Sharma', m: '12 F · UH-24-0457' },
                { n: 'Vivek Sharman', m: '41 M · UH-22-0913' },
              ].map((r) => (
                <li
                  key={r.n}
                  className={`flex items-center gap-3 rounded-[10px] px-2.5 py-2 ${
                    r.active ? 'bg-clinical-tint' : ''
                  }`}
                >
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-bg-soft font-display text-[11px] font-bold text-ink-60">
                    {r.n
                      .split(' ')
                      .map((w) => w[0])
                      .join('')}
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[13px] font-semibold">{r.n}</span>
                    <span className="block font-mono text-[10.5px] text-ink-40">{r.m}</span>
                  </span>
                  {r.active && (
                    <span className="text-clinical">
                      <ArrowRight size={14} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {['Name', 'Mobile', 'UHID', 'ABHA'].map((k) => (
              <span key={k} className="badge-neutral">
                {k}
              </span>
            ))}
          </div>
        </Tile>
      </Reveal>

      {/* Prescriptions */}
      <Reveal>
        <Tile
          icon={<RxGlyph size={18} />}
          title="Prescriptions on your letterhead"
          body="Notes, vitals and Rx on one panel, printed on the way out."
        >
          <div className="relative mt-6 rounded-[14px] border border-ink/8 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between border-b border-dashed border-ink/12 pb-2.5">
              <span className="h-2 w-24 rounded-full bg-ink/15" />
              <span className="h-2 w-12 rounded-full bg-ink/10" />
            </div>
            <p className="mt-3 font-display text-[20px] font-bold text-clinical">℞</p>
            <ul className="mt-1 space-y-2 text-[12px]">
              <li className="flex justify-between gap-2">
                <span className="font-semibold">Tab. Paracetamol 650</span>
                <span className="font-mono text-ink-40">1-0-1 · 5d</span>
              </li>
              <li className="flex justify-between gap-2">
                <span className="font-semibold">Cap. Amoxicillin 500</span>
                <span className="font-mono text-ink-40">1-1-1 · 5d</span>
              </li>
            </ul>
          </div>
        </Tile>
      </Reveal>

      {/* Diagnostics */}
      <Reveal delay={80}>
        <Tile
          icon={<FlaskGlyph size={18} />}
          title="Diagnostics, ordered and billed"
          body="Order tests from the consultation and attach reports to the patient’s history."
        >
          <div className="mt-6 space-y-2">
            {[
              { t: 'Complete blood count', s: 'Report ready', c: 'badge-green' },
              { t: 'HbA1c', s: 'Sample taken', c: 'badge-amber' },
              { t: 'X-ray chest PA', s: 'Ordered', c: 'badge-neutral' },
            ].map((d) => (
              <div
                key={d.t}
                className="flex items-center justify-between gap-3 rounded-[12px] border border-ink/8 bg-white px-3 py-2.5"
              >
                <span className="truncate text-[12.5px] font-semibold">{d.t}</span>
                <span className={d.c}>{d.s}</span>
              </div>
            ))}
          </div>
        </Tile>
      </Reveal>

      {/* Billing */}
      <Reveal>
        <Tile
          icon={<IconReceipt size={18} />}
          title="Billing & receipts"
          body="Consultation and tests on one bill. Part-payments are handled, and the receipt prints in a click."
        >
          <div className="mt-6 rounded-[14px] border border-ink/8 bg-white p-4 font-mono text-[12px] shadow-sm">
            {[
              ['Consultation', '₹500'],
              ['Complete blood count', '₹350'],
              ['Promotion · 10%', '−₹85'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between py-1 text-ink-60">
                <span>{k}</span>
                <span className={v?.startsWith('−') ? 'text-green-text' : ''}>{v}</span>
              </div>
            ))}
            <div className="mt-2 flex items-center justify-between border-t border-dashed border-ink/15 pt-2.5">
              <span className="font-sans text-[13px] font-bold text-ink">Total ₹765</span>
              <span className="badge-green">Paid</span>
            </div>
          </div>
        </Tile>
      </Reveal>

      {/* Promotions */}
      <Reveal delay={80}>
        <Tile
          icon={<TagGlyph size={18} />}
          title="Promotions that apply themselves"
          body="Set up offers once in settings. The desk sees what qualifies right at billing."
        >
          <div className="mt-6 flex flex-col gap-2">
            {[
              { k: 'Senior citizen', v: '10% off consultation', on: true },
              { k: 'Health camp', v: 'Free BP check', on: false },
            ].map((p) => (
              <div
                key={p.k}
                className={`flex items-center justify-between gap-3 rounded-[12px] border px-3 py-2.5 ${
                  p.on ? 'border-clinical/30 bg-clinical-tint' : 'border-ink/8 bg-white'
                }`}
              >
                <span className="leading-tight">
                  <span className="block text-[12.5px] font-semibold">{p.k}</span>
                  <span className="block text-[11.5px] text-ink-40">{p.v}</span>
                </span>
                <span
                  className={`relative h-5 w-9 rounded-full ${p.on ? 'bg-clinical' : 'bg-ink/15'}`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm ${
                      p.on ? 'left-[18px]' : 'left-0.5'
                    }`}
                  />
                </span>
              </div>
            ))}
          </div>
        </Tile>
      </Reveal>

      {/* Keyboard */}
      <Reveal delay={160}>
        <Tile
          icon={<KeyboardGlyph size={18} />}
          title="Keyboard-first, everywhere"
          body="Built for the rush hour: every screen works without reaching for the mouse."
        >
          <div className="mt-6 flex flex-wrap items-center gap-2">
            {['Ctrl', 'K'].map((k, i) => (
              <span key={k} className="flex items-center gap-2">
                {i > 0 && <span className="text-ink-20">+</span>}
                <Kbd>{k}</Kbd>
              </span>
            ))}
            <span className="ml-1 text-[12.5px] text-ink-40">search anywhere</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Kbd>Tab</Kbd>
            <span className="text-ink-20">→</span>
            <Kbd>Enter</Kbd>
            <span className="ml-1 text-[12.5px] text-ink-40">register &amp; save</span>
          </div>
        </Tile>
      </Reveal>
    </div>
  );
}

function Tile({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-card-lg border border-ink/8 bg-white/65 backdrop-blur-xl p-6 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-clinical/25 hover:shadow sm:p-7">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-clinical-soft/0 blur-2xl transition-colors duration-500 group-hover:bg-clinical-soft/70"
      />
      <span className="relative grid h-10 w-10 place-items-center rounded-panel bg-clinical-tint text-clinical ring-1 ring-clinical/15">
        {icon}
      </span>
      <h3 className="relative mt-5 text-[19px] font-bold">{title}</h3>
      <p className="relative mt-2 text-[14px] leading-relaxed text-ink-60">{body}</p>
      <div className="relative mt-auto">{children}</div>
    </article>
  );
}

/**
 * The registration card, typing itself: "Priya Shar" goes in a key at a time
 * at an uneven, human pace, the duplicate warning slides in once the name is
 * specific enough — the way the real check fires while you type — and the
 * mobile number follows. It holds, clears and starts again.
 *
 * Only runs while the card is on screen, and not at all under reduced motion:
 * there it simply shows the finished state. The warning keeps its space while
 * hidden so the card never jumps.
 */
const TYPED_NAME = 'Priya Shar';
const TYPED_MOBILE = '98••• ••410';
/** "Priya S" — the point where there is enough to match on. */
const MATCH_AT = 7;

function RegistrationDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(TYPED_NAME.length);
  const [mobile, setMobile] = useState(TYPED_MOBILE.length);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let timers: number[] = [];
    let running = false;
    const stop = () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers = [];
    };
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

    const play = () => {
      stop();
      setName(0);
      setMobile(0);
      let t = 500;
      for (let i = 1; i <= TYPED_NAME.length; i++) {
        // A space or a capital takes a beat longer, as it does for a person.
        t += 85 + Math.random() * 120 + (/[ A-Z]/.test(TYPED_NAME[i - 1] ?? '') ? 90 : 0);
        at(t, () => setName(i));
      }
      t += 450;
      for (let i = 1; i <= TYPED_MOBILE.length; i++) {
        t += 60 + Math.random() * 70;
        at(t, () => setMobile(i));
      }
      at(t + 3400, play);
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !running) {
          running = true;
          play();
        } else if (!entry?.isIntersecting && running) {
          running = false;
          stop();
          setName(TYPED_NAME.length);
          setMobile(TYPED_MOBILE.length);
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      stop();
    };
  }, []);

  const typingName = name < TYPED_NAME.length;
  const match = name >= MATCH_AT;
  const caret = (
    <span className="wl-caret ml-px inline-block h-4 w-px translate-y-0.5 bg-clinical" />
  );

  return (
    <div
      ref={ref}
      className="mt-6 grid gap-3 rounded-[16px] border border-ink/8 bg-bg-soft p-4 sm:grid-cols-2"
    >
      <MockField label="Full name">
        {TYPED_NAME.slice(0, name)}
        {(typingName || mobile === TYPED_MOBILE.length) && caret}
      </MockField>
      <MockField label="Mobile">
        {TYPED_MOBILE.slice(0, mobile)}
        {!typingName && mobile < TYPED_MOBILE.length && caret}
      </MockField>
      <div
        className={`flex flex-col gap-3 rounded-[12px] border border-amber/40 bg-amber-soft/60 px-3.5 py-3 transition-all duration-500 ease-out sm:col-span-2 sm:flex-row sm:items-center sm:justify-between ${
          match ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
        }`}
      >
        <span className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white font-display text-[12px] font-bold text-amber-text">
            PS
          </span>
          <span className="leading-tight">
            <span className="block text-[13px] font-semibold text-amber-text">
              This may be an existing patient
            </span>
            <span className="block font-mono text-[11px] text-amber-text/80">
              Priya Sharma · 34 F · UH-24-0192
            </span>
          </span>
        </span>
        <span className="self-start rounded-pill bg-white px-3 py-1.5 text-[12px] font-semibold text-amber-text shadow-sm sm:self-auto">
          Open record
        </span>
      </div>
    </div>
  );
}

function MockField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mono-label !text-[9.5px]">{label}</p>
      <div className="mt-1 flex h-10 items-center rounded-[10px] border border-ink/10 bg-white px-3 text-[13.5px] font-medium">
        {children}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[34px] items-center justify-center rounded-[8px] border border-ink/15 border-b-[3px] bg-white px-2 py-1 font-mono text-[12px] font-semibold text-ink shadow-sm">
      {children}
    </kbd>
  );
}

/* -------------------------------------------------------------------------- */
/*  Roles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The five personas, in the same colours the console gives them (globals.css,
 * ROLE SIGNATURES). Kept as literals because the CSS variables only resolve
 * under a `[data-role]` ancestor, and this page shows all five side by side.
 */
const ROLES = [
  {
    key: 'front_desk',
    label: 'Front desk',
    color: '#3a4e9b',
    glow: '#8fa0e6',
    soft: '#e2e6f6',
    text: '#2b3a75',
    person: 'Pooja Singh',
    headline: 'Keeps the line moving',
    body: 'Registration, bookings, the queue and the cash counter: the whole front of house on one screen.',
    points: [
      'Register a patient in under two minutes, with a live duplicate check',
      'Book appointments or add walk-ins straight to the queue',
      'Take payments and print receipts in one step',
      'Find anyone by name, mobile, UHID or ABHA with Ctrl + K',
    ],
    tiles: [
      { k: 'Queue', v: '7 waiting' },
      { k: 'Appointments', v: '12 today' },
      { k: 'Collected', v: '₹18,400' },
    ],
  },
  {
    key: 'doctor',
    label: 'Doctor',
    color: '#6b3fa0',
    glow: '#b894e6',
    soft: '#ede2f7',
    text: '#52307b',
    person: 'Dr. Kiran Rao',
    headline: 'Sees patients, not paperwork',
    body: 'Their own queue, the patient’s history and a prescription pad that prints itself.',
    points: [
      'A personal queue that updates as the desk checks patients in',
      'Previous visits and past tests beside every consultation',
      'Prescriptions printed on the clinic’s own letterhead',
      'Order diagnostics without leaving the consultation',
    ],
    tiles: [
      { k: 'My queue', v: '5 waiting' },
      { k: 'Next', v: 'Token 20' },
      { k: 'Seen', v: '14 today' },
    ],
  },
  {
    key: 'nurse',
    label: 'Nurse',
    color: '#a83a6e',
    glow: '#e693bb',
    soft: '#f7deeb',
    text: '#852c56',
    person: 'Anita Joseph',
    headline: 'Ready before the doctor is',
    body: 'Vitals, triage and the waiting room, handled before the patient walks into the chamber.',
    points: [
      'Record vitals ahead of the consultation',
      'Move urgent patients to the front of the queue',
      'Help the desk with registrations at rush hour',
      'See at a glance who is waiting for which doctor',
    ],
    tiles: [
      { k: 'Vitals due', v: '3 patients' },
      { k: 'Priority', v: '1 flagged' },
      { k: 'Waiting', v: '7 total' },
    ],
  },
  {
    key: 'owner',
    label: 'Owner',
    color: '#7a5230',
    glow: '#d9ad85',
    soft: '#efe1d3',
    text: '#5e3e22',
    person: 'Dr. Suresh Menon',
    headline: 'Knows the numbers by closing time',
    body: 'Collections, finance and pricing: the business side of the clinic, without a spreadsheet.',
    points: [
      'Daily collections that match the cash drawer',
      'Finance reports ready whenever you need them',
      'Set prices and run promotions from settings',
      'Manage doctors and their consulting hours',
    ],
    tiles: [
      { k: 'Today', v: '₹18,400' },
      { k: 'This month', v: '₹4.2 L' },
      { k: 'Outstanding', v: '₹2,150' },
    ],
  },
  {
    key: 'administrator',
    label: 'Administrator',
    color: '#4c5563',
    glow: '#b5bcc7',
    soft: '#e4e6ea',
    text: '#39414d',
    person: 'Rahul Kapoor',
    headline: 'Sets the clinic up once',
    body: 'Staff accounts, roles, branding and screens. Configured in minutes and audited from then on.',
    points: [
      'Invite staff and assign roles and permissions',
      'Put the clinic’s own logo and name on every screen',
      'Pair waiting-room TVs with a screen key',
      'Choose how patient IDs are numbered',
    ],
    tiles: [
      { k: 'Staff', v: '14 active' },
      { k: 'Screens', v: '2 paired' },
      { k: 'Two-factor', v: 'Enforced' },
    ],
  },
] as const;

function RolesShowcase({ night }: { night: boolean }) {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const role = ROLES[active] ?? ROLES[0];

  /*
   * The role colours are set inline, so the page's night rules can't reach
   * them. At night each role wears its lifted colour instead (the same ones the
   * sign-in page uses), with dark text on it; the deep daytime colours — the
   * administrator's slate most of all — would vanish on the dark ground.
   */
  const tone = night
    ? {
        color: role.glow,
        soft: `${role.glow}24`,
        text: role.glow,
        blank: 'rgba(228,234,232,.08)',
        on: '#0E1315',
      }
    : { color: role.color, soft: role.soft, text: role.text, blank: '#F6F4F0', on: '#FFFFFF' };
  const initials = role.person
    .replace(/^Dr\.\s+/, '')
    .split(' ')
    .map((w) => w[0])
    .join('');

  function onKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (active + (e.key === 'ArrowRight' ? 1 : -1) + ROLES.length) % ROLES.length;
    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <Reveal className="mt-14">
      <div
        role="tablist"
        aria-label="Roles"
        onKeyDown={onKey}
        className="mx-auto flex w-full max-w-3xl flex-wrap justify-center gap-1 rounded-[22px] border border-ink/10 bg-white p-1.5 shadow-sm sm:flex-nowrap sm:rounded-pill"
      >
        {ROLES.map((r, i) => {
          const on = i === active;
          return (
            <button
              key={r.key}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`role-tab-${r.key}`}
              aria-selected={on}
              aria-controls="role-panel"
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(i)}
              className={`flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-pill px-4 py-2.5 text-[13.5px] font-semibold transition-all duration-300 ${
                on ? 'shadow-sm' : 'text-ink-60 hover:bg-ink/5 hover:text-ink'
              }`}
              style={
                on
                  ? {
                      backgroundColor: night ? r.glow : r.color,
                      color: night ? '#0E1315' : '#FFFFFF',
                    }
                  : undefined
              }
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: on
                    ? night
                      ? 'rgba(14,19,21,0.6)'
                      : 'rgba(255,255,255,0.8)'
                    : night
                      ? r.glow
                      : r.color,
                }}
              />
              {r.label}
            </button>
          );
        })}
      </div>

      <div
        id="role-panel"
        role="tabpanel"
        aria-labelledby={`role-tab-${role.key}`}
        key={role.key}
        className="wl-rise mt-8 grid items-stretch gap-6 lg:grid-cols-2"
        style={{ animationDuration: '.5s' }}
      >
        <div className="flex flex-col justify-center rounded-card-lg border border-ink/8 bg-white/65 backdrop-blur-xl p-7 shadow-sm sm:p-9">
          <p className="mono-label" style={{ color: tone.text }}>
            {role.label}
          </p>
          <h3 className="mt-3 text-[clamp(24px,3vw,32px)] font-extrabold tracking-[-0.02em]">
            {role.headline}
          </h3>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-60">{role.body}</p>
          <ul className="mt-7 space-y-3.5">
            {role.points.map((p) => (
              <li key={p} className="flex items-start gap-3 text-[14.5px] text-ink">
                <span
                  className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full"
                  style={{ backgroundColor: tone.color, color: tone.on }}
                >
                  <IconCheck size={11} />
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>

        {/* A sketch of that role's console */}
        <div
          className="relative overflow-hidden rounded-card-lg border border-ink/8 p-5 shadow-sm sm:p-7"
          style={{ backgroundColor: tone.soft }}
        >
          <div
            aria-hidden="true"
            className="absolute -right-16 -top-16 h-56 w-56 rounded-full opacity-25 blur-3xl"
            style={{ backgroundColor: tone.color }}
          />
          <div className="relative overflow-hidden rounded-[18px] border border-ink/8 bg-white shadow-lg">
            <div className="h-1.5" style={{ backgroundColor: tone.color }} />
            <div className="flex items-center justify-between gap-3 border-b border-ink/8 px-4 py-3">
              <span className="flex items-center gap-2.5">
                <span
                  className="grid h-9 w-9 place-items-center rounded-full text-[12px] font-bold"
                  style={{ backgroundColor: tone.color, color: tone.on }}
                >
                  {initials}
                </span>
                <span className="leading-tight">
                  <span className="block text-[13.5px] font-semibold">{role.person}</span>
                  <span className="block text-[11.5px] font-medium" style={{ color: tone.text }}>
                    {role.label}
                  </span>
                </span>
              </span>
              <span
                className="rounded-pill px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-label"
                style={{ backgroundColor: tone.soft, color: tone.text }}
              >
                Signed in
              </span>
            </div>
            <div className="p-4">
              <p className="mono-label">First thing on screen</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {role.tiles.map((t) => (
                  <div key={t.k} className="rounded-panel border border-ink/8 bg-bg-soft p-3">
                    <p className="font-mono text-[9.5px] uppercase tracking-label text-ink-40">
                      {t.k}
                    </p>
                    <p className="mt-1 text-[14px] font-bold leading-tight">{t.v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-2">
                {[82, 64, 74].map((w, i) => (
                  <div
                    key={w}
                    className="flex items-center gap-3 rounded-panel border border-ink/6 px-3 py-2.5"
                  >
                    <span
                      className="h-7 w-7 shrink-0 rounded-full"
                      style={{ backgroundColor: i === 0 ? tone.soft : tone.blank }}
                    />
                    <span className="flex-1 space-y-1.5">
                      <span
                        className="block h-2 rounded-full bg-ink/12"
                        style={{ width: `${w}%` }}
                      />
                      <span className="block h-1.5 w-1/3 rounded-full bg-ink/6" />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Journey                                                                    */
/* -------------------------------------------------------------------------- */

function Journey() {
  const steps = [
    {
      time: '09:02',
      icon: <IconUserPlus size={20} />,
      title: 'Arrives',
      body: 'Registered at the desk. The UHID is issued the moment the form is saved.',
      tag: 'UH-24-0871',
    },
    {
      time: '09:04',
      icon: <IconClock size={20} />,
      title: 'Queued',
      body: 'A token is issued, the doctor is assigned and the waiting-room screen updates itself.',
      tag: 'Token 19 · Dr. Rao',
    },
    {
      time: '09:31',
      icon: <IconStethoscope size={20} />,
      title: 'Consulted',
      body: 'Vitals, notes and the prescription on a single panel, printed on the way out.',
      tag: 'Rx printed',
    },
    {
      time: '09:36',
      icon: <IconReceipt size={20} />,
      title: 'Paid',
      body: 'Consultation and tests billed together. Receipt in hand, record complete.',
      tag: '₹850 · R-1042',
    },
  ];

  return (
    <div className="relative mt-16">
      <div
        aria-hidden="true"
        className="absolute left-[12.5%] right-[12.5%] top-7 hidden border-t-2 border-dashed border-clinical/25 lg:block"
      />
      <div
        aria-hidden="true"
        className="absolute bottom-10 left-7 top-7 border-l-2 border-dashed border-clinical/25 lg:hidden"
      />
      <ol className="relative grid gap-6 lg:grid-cols-4 lg:gap-5">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Reveal
              delay={i * 110}
              className="flex gap-5 lg:flex-col lg:items-center lg:text-center"
            >
              <span className="relative grid h-14 w-14 shrink-0 place-items-center rounded-full bg-clinical text-white shadow-[0_0_0_8px_#EFECE6,0_10px_24px_-8px_rgba(15,118,110,0.7)]">
                {s.icon}
              </span>
              <div className="flex-1 rounded-card border border-ink/8 bg-white/65 backdrop-blur-xl p-5 shadow-sm lg:mt-6 lg:w-full">
                <p className="font-mono text-[11.5px] font-semibold text-clinical-text">{s.time}</p>
                <h3 className="mt-1 text-[19px] font-bold">{s.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-60">{s.body}</p>
                <span className="badge-neutral mt-4">{s.tag}</span>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
      <Reveal delay={400}>
        <p className="mt-12 text-center text-[15px] text-ink-60">
          <span className="font-semibold text-ink">34 minutes from arrival to receipt,</span> with
          his details entered once at the front desk.
        </p>
      </Reveal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Waiting-room display                                                       */
/* -------------------------------------------------------------------------- */

function DisplayShowcase() {
  return (
    <section
      id="display"
      className="relative isolate scroll-mt-24 overflow-hidden bg-dark/[0.93] px-4 py-24 text-white sm:px-6 lg:py-32"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-[0.08]"
        style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '26px 26px',
        }}
      />
      <div
        aria-hidden="true"
        className="absolute -left-40 top-10 -z-10 h-[480px] w-[480px] rounded-full bg-clinical/40 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="absolute -right-40 bottom-0 -z-10 h-[420px] w-[420px] rounded-full bg-[#6b3fa0]/25 blur-3xl"
      />

      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[0.85fr_1.15fr]">
        <Reveal>
          <p className="flex items-baseline gap-3 text-[14px] font-semibold">
            <span className="text-white/60">Waiting room</span>
            <span aria-hidden="true" className="h-px flex-1 bg-white/15" />
          </p>
          <h2 className="mt-5 text-[clamp(30px,4.6vw,52px)] font-extrabold leading-[1.04] tracking-[-0.03em] text-white">
            The token screen <span className="wl-serif text-[#5fd6c6]">in the waiting room.</span>
          </h2>
          <p className="mt-5 max-w-md text-[16px] leading-relaxed text-white/65">
            Pair any TV with a key from settings. It shows who each doctor is seeing and who&rsquo;s
            next, and updates on its own. Patients&rsquo; names never go on the wall, only token
            numbers.
          </p>
          <ul className="mt-8 space-y-3.5">
            {[
              'Any smart TV or browser, with nothing to install',
              'One board per doctor, updated live',
              'Shows tokens only, never names or details',
            ].map((t) => (
              <li key={t} className="flex items-center gap-3 text-[14.5px] text-white/85">
                <span aria-hidden="true" className="text-[#5fd6c6]">
                  &ndash;
                </span>
                {t}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={120}>
          <div className="relative">
            <div className="rounded-[26px] border border-white/10 bg-[#0b0c0e] p-2.5 shadow-[0_60px_120px_-40px_rgba(0,0,0,0.8)] sm:p-3.5">
              <div className="overflow-hidden rounded-[16px] bg-bg p-4 text-ink sm:p-6">
                <div className="flex items-center justify-between gap-3 border-b border-ink/10 pb-4">
                  <span className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-panel bg-clinical font-display text-[13px] font-bold text-white">
                      SC
                    </span>
                    <span>
                      <span className="eyebrow">Now serving</span>
                      <span className="block font-display text-[clamp(18px,2.4vw,26px)] font-bold leading-tight tracking-display">
                        Sunrise Clinic
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2 rounded-pill bg-white px-3 py-1.5 font-mono text-[11px] text-ink-60 shadow-sm">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green/60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-green" />
                    </span>
                    10:42 AM
                  </span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {[
                    {
                      d: 'Dr. Kiran Rao',
                      s: 'General Medicine',
                      now: '19',
                      next: ['20', '23', '24'],
                    },
                    { d: 'Dr. Leela Iyer', s: 'Paediatrics', now: '07', next: ['21', '22'] },
                  ].map((b) => (
                    <div
                      key={b.d}
                      className="overflow-hidden rounded-panel border border-ink/8 bg-card shadow-sm"
                    >
                      <div className="flex items-baseline justify-between gap-2 border-b border-ink/8 bg-bg-soft px-4 py-2.5">
                        <span className="font-display text-[15px] font-bold">{b.d}</span>
                        <span className="truncate text-[11px] text-ink-40">{b.s}</span>
                      </div>
                      <div className="px-4 py-3">
                        <p className="mono-label">Now serving</p>
                        <p className="font-mono text-[46px] font-bold leading-none text-clinical sm:text-[54px]">
                          {b.now}
                        </p>
                        <div className="mt-3 border-t border-ink/8 pt-3">
                          <p className="mono-label">Next</p>
                          <div className="mt-1.5 flex gap-1.5">
                            {b.next.map((t) => (
                              <span
                                key={t}
                                className="rounded-[8px] bg-clinical-soft px-2.5 py-1 font-mono text-[15px] font-bold text-clinical-text"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {/* Stand */}
            <div
              aria-hidden="true"
              className="mx-auto h-10 w-16 bg-gradient-to-b from-[#1d2024] to-[#0b0c0e]"
            />
            <div
              aria-hidden="true"
              className="mx-auto h-2.5 w-56 rounded-full bg-[#1d2024] shadow-[0_10px_30px_rgba(0,0,0,0.6)]"
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Audit log                                                                  */
/* -------------------------------------------------------------------------- */

function AuditLog() {
  const rows = [
    {
      t: '09:31:08',
      who: 'Dr. K. Rao',
      what: 'prescription.create',
      ref: 'UH-24-0871',
      c: '#6b3fa0',
    },
    { t: '09:33:41', who: 'P. Singh', what: 'payment.record', ref: 'R-1042', c: '#3a4e9b' },
    { t: '09:34:02', who: 'P. Singh', what: 'receipt.print', ref: 'R-1042', c: '#3a4e9b' },
    { t: '09:40:15', who: 'A. Joseph', what: 'vitals.update', ref: 'UH-24-0873', c: '#a83a6e' },
    { t: '10:02:57', who: 'R. Kapoor', what: 'user.role.update', ref: 'staff/14', c: '#4c5563' },
    { t: '10:05:12', who: 'S. Menon', what: 'price.update', ref: 'consult/gp', c: '#7a5230' },
  ];

  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="absolute -inset-4 -z-10 rounded-[36px] bg-gradient-to-br from-clinical-soft/70 via-transparent to-amber-soft/60 blur-xl"
      />
      <div className="overflow-hidden rounded-card-lg border border-ink/10 bg-white/75 backdrop-blur-xl shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/8 px-5 py-4">
          <span>
            <span className="mono-label block">Audit trail</span>
            <span className="mt-0.5 block text-[16px] font-bold">Today, every write</span>
          </span>
          <span className="flex gap-1.5">
            <span className="badge-clinical">All staff</span>
            <span className="badge-neutral">Live</span>
          </span>
        </div>
        <ul className="divide-y divide-ink/6">
          {rows.map((r, i) => (
            <li
              key={r.t}
              className={`grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[76px_120px_1fr_auto] ${
                i === 0 ? 'bg-clinical-tint/60' : ''
              }`}
            >
              <span className="font-mono text-[11.5px] text-ink-40">{r.t}</span>
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: r.c }} />
                {r.who}
              </span>
              <span className="col-span-2 font-mono text-[12px] text-clinical-text sm:col-span-1">
                {r.what}
              </span>
              <span className="col-span-2 font-mono text-[11.5px] text-ink-40 sm:col-span-1 sm:text-right">
                {r.ref}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-ink/8 bg-bg-soft px-5 py-3">
          <span className="flex items-center gap-2 text-[12px] text-ink-60">
            <IconLock size={13} />
            Append-only · Encrypted at rest
          </span>
          <span className="font-mono text-[11px] text-ink-40">6 of 1,284</span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  FAQ                                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Questions a clinic owner asks before choosing, answered only with what the
 * product does today. Staff sign-in help (accounts, the clinic field,
 * authenticator codes, forgotten passwords) lives on the sign-in page, where
 * the people who need it already are.
 */
const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Do we need to install anything?',
    a: 'No. It runs in any modern browser (Chrome, Edge, Firefox or Safari) on the desk PCs, laptops or tablets you already have. A waiting-room TV only needs a browser too.',
  },
  {
    q: 'Can other clinics see our patients?',
    a: 'No. Each clinic’s records are kept apart by the database itself, row by row, and every change is logged with who made it and when.',
  },
  {
    q: 'Does it work with ABHA?',
    a:
      'You can record a patient’s ABHA number and ABHA address, and find a patient by their ABHA number from the same search box as name, mobile and UHID.' +
      (BUSINESS.abdm ? ' ' + BUSINESS.abdm + '.' : ''),
  },
  {
    q: 'Will it look like our clinic, or like your software?',
    a: 'Like your clinic. Your name and logo go on the sign-in page, every screen and the printed prescription, and staff never see our name.',
  },
  {
    q: 'Who can see what?',
    a: 'Each person signs in with their own account and role: front desk, doctor, nurse, owner or administrator. Each role sees only what it needs, and the roles that can change settings must use two-factor sign-in.',
  },
  ...(BUSINESS.pricing.from
    ? [
        {
          q: 'What does it cost?',
          a:
            `From ${BUSINESS.pricing.from} ${BUSINESS.pricing.per}.` +
            (BUSINESS.pricing.trial ? ' ' + BUSINESS.pricing.trial + '.' : ''),
        },
      ]
    : []),
];

function FaqList() {
  return (
    <div className="divide-y divide-ink/8 rounded-card-lg border border-ink/8 bg-white/65 backdrop-blur-xl shadow-sm">
      {FAQ.map((f, i) => (
        <details key={f.q} className="group px-6" open={i === 0}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[15.5px] font-semibold [&::-webkit-details-marker]:hidden">
            {f.q}
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-ink/10 text-ink-40 transition-all duration-300 group-open:rotate-180 group-open:border-clinical/30 group-open:bg-clinical-tint group-open:text-clinical">
              <IconChevronDown size={15} />
            </span>
          </summary>
          <p className="-mt-1 pb-5 pr-12 text-[14.5px] leading-relaxed text-ink-60">{f.a}</p>
        </details>
      ))}
    </div>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: ReadonlyArray<{ href: string; label: string }>;
}) {
  return (
    <div>
      <p className="mono-label">{title}</p>
      <ul className="mt-4 space-y-2.5">
        {links.map((l) => (
          <li key={l.label}>
            {l.href.startsWith('#') ? (
              <a href={l.href} className="text-[14px] text-ink-60 hover:text-clinical-text">
                {l.label}
              </a>
            ) : (
              <Link
                href={l.href}
                className="text-[14px] font-semibold text-clinical-text hover:text-clinical"
              >
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ========================================================================== */
/*  Glyphs this page needs that the shared icon set does not have              */
/* ========================================================================== */

function Glyph({ size = 18, children }: { size?: number | undefined; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ArrowRight = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Glyph>
);

const FlaskGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M9 3h6M10 3v6.5L4.8 18.2A2 2 0 006.5 21h11a2 2 0 001.7-2.8L14 9.5V3" />
    <path d="M7.5 15h9" />
  </Glyph>
);

const RxGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M6 20V4h5a4 4 0 010 8H6M10 12l8 8M18 13l-5 6" />
  </Glyph>
);

const TagGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M3 12V4a1 1 0 011-1h8l9 9-9 9-9-9z" />
    <circle cx="8" cy="8" r="1.5" />
  </Glyph>
);

const KeyboardGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </Glyph>
);

/* ========================================================================== */
/*  Night look                                                                 */
/* ========================================================================== */

/**
 * The low-glare night look for this page. The console's colours are fixed
 * values in tailwind.config.ts, so night is a set of overrides for the classes
 * this page uses, active under [data-look="night"] on the page root. The
 * sign-in pop-up's own classes come with its own rules (app/login/page.tsx).
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
  // A light default colour too: headings and names that set no colour of their
  // own inherit it instead of the console's near-black.
  '{color-scheme:dark;color:#E4EAE8}\nhtml:has(' +
  NIGHT +
  '){background:#0E1315}\nbody:has(' +
  NIGHT +
  '){background:#0E1315}\n' +
  nightRules({
    '.bg-bg': 'background-color:#0E1315',
    '.bg-bg-soft, .bg-bg-soft\\/60, .hover\\:bg-bg-soft:hover': 'background-color:#151B1D',
    '.bg-card, .bg-white, .bg-white\\/95, .bg-white\\/90, .hover\\:bg-white:hover':
      'background-color:#1A2224',
    '.bg-white\\/80, .bg-white\\/75, .bg-white\\/70, .bg-white\\/65':
      'background-color:rgba(26,34,36,.78)',
    '.bg-white\\/25, .bg-white\\/30': 'background-color:rgba(26,34,36,.35)',
    '.text-ink, .hover\\:text-ink:hover': 'color:#E4EAE8',
    '.text-ink-60': 'color:#B3BDBA',
    '.text-ink-40, .mono-label': 'color:#939D9A',
    '.text-ink-20, .placeholder\\:text-ink-20::placeholder': 'color:#6A7472',
    '.decoration-ink-20': 'text-decoration-color:#6A7472',
    '.border-ink\\/6, .border-ink\\/8, .border-ink\\/10, .border-ink\\/12, .border-ink\\/15':
      'border-color:rgba(228,234,232,.12)',
    '.divide-ink\\/6 > :not([hidden]) ~ :not([hidden]), .divide-ink\\/8 > :not([hidden]) ~ :not([hidden])':
      'border-color:rgba(228,234,232,.1)',
    '.hover\\:border-ink\\/20:hover, .hover\\:border-ink\\/25:hover':
      'border-color:rgba(228,234,232,.26)',
    '.border-ink': 'border-color:#E4EAE8',
    '.bg-ink, .hover\\:bg-ink:hover, .focus\\:bg-ink:focus': 'background-color:#2A3436',
    '.bg-ink\\/6, .bg-ink\\/10, .bg-ink\\/12, .bg-ink\\/15':
      'background-color:rgba(228,234,232,.1)',
    '.bg-ink\\/25': 'background-color:rgba(228,234,232,.22)',
    '.group:hover .group-hover\\:bg-ink\\/50': 'background-color:rgba(228,234,232,.45)',
    '.bg-ink\\/70': 'background-color:rgba(228,234,232,.6)',
    '.hover\\:bg-ink\\/5:hover': 'background-color:rgba(228,234,232,.06)',
    '.text-clinical, .group[open] .group-open\\:text-clinical': 'color:#4CC3B3',
    '.text-clinical-text, .text-clinical-deep, .hover\\:text-clinical-text:hover, .hover\\:text-clinical:hover':
      'color:#6AD1C2',
    '.bg-clinical': 'background-color:#1F8F83',
    '.hover\\:bg-clinical-deep:hover': 'background-color:#17766C',
    '.focus\\:border-clinical:focus': 'border-color:#4CC3B3',
    '.bg-clinical-tint, .bg-clinical-tint\\/70, .bg-clinical-tint\\/60, .hover\\:bg-clinical-tint:hover, .group[open] .group-open\\:bg-clinical-tint':
      'background-color:rgba(76,195,179,.12)',
    '.bg-clinical-soft, .bg-clinical-soft\\/80, .bg-clinical-soft\\/70':
      'background-color:rgba(76,195,179,.16)',
    '.border-clinical\\/25, .border-clinical\\/30, .hover\\:border-clinical\\/25:hover, .hover\\:border-clinical\\/30:hover, .group[open] .group-open\\:border-clinical\\/30':
      'border-color:rgba(76,195,179,.4)',
    '.bg-clinical-deep': 'background-color:#0B2E2B',
    '.group:hover .group-hover\\:bg-clinical-soft\\/70': 'background-color:rgba(76,195,179,.12)',
    '.bg-amber-soft, .bg-amber-soft\\/60, .bg-amber-soft\\/70':
      'background-color:rgba(232,178,60,.13)',
    '.text-amber-text, .text-amber-text\\/80': 'color:#F0C868',
    '.border-amber\\/40': 'border-color:rgba(232,178,60,.35)',
    '.bg-coral-soft\\/50': 'background-color:rgba(228,103,79,.1)',
    '.text-coral-text': 'color:#F4A08C',
    '.bg-green-soft': 'background-color:rgba(46,114,69,.3)',
    '.text-green-text': 'color:#7FD19B',
    '.from-clinical-soft\\/70':
      '--tw-gradient-from:rgba(76,195,179,.14) var(--tw-gradient-from-position)',
    '.to-amber-soft\\/60': '--tw-gradient-to:rgba(232,178,60,.1) var(--tw-gradient-to-position)',
    '.badge-clinical': 'background-color:rgba(76,195,179,.16);color:#6AD1C2',
    '.badge-amber': 'background-color:rgba(232,178,60,.14);color:#F0C868',
    '.badge-coral': 'background-color:rgba(228,103,79,.16);color:#F4A08C',
    '.badge-green': 'background-color:rgba(46,114,69,.32);color:#7FD19B',
    '.badge-neutral': 'background-color:rgba(228,234,232,.08);color:#B3BDBA',
    '.eyebrow': 'color:#6AD1C2',
    // Paper index cards and the queue mock's highlighted row.
    '.bg-\\[\\#FFFDF8\\]': 'background-color:#1C2426',
    '.bg-\\[\\#e2e6f6\\]': 'background-color:rgba(143,160,230,.18)',
    '.text-\\[\\#2b3a75\\]': 'color:#B9C4F0',
    // The workflow nodes wear a ring of the page colour to cut the track.
    '[class*="0_0_0_8px_#EFECE6"]':
      'box-shadow:0 0 0 8px #0E1315,0 10px 24px -8px rgba(15,118,110,.7)',
  });

/** The header's sun/moon switch between the light and night looks. */
function NightToggle({ look, onToggle }: { look: Look; onToggle: () => void }) {
  const night = look === 'night';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={night}
      aria-label={night ? 'Switch to the light look' : 'Switch to the night look'}
      title={night ? 'Light look' : 'Night look'}
      className="grid h-10 w-10 place-items-center rounded-full border border-ink/10 bg-white/80 text-ink-60 backdrop-blur transition-colors hover:border-ink/20 hover:text-ink"
    >
      {night ? (
        <svg
          width="17"
          height="17"
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
      ) : (
        <svg
          width="17"
          height="17"
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
      )}
    </button>
  );
}
