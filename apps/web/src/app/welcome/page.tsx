'use client';

import Link from 'next/link';
import { Josefin_Sans } from 'next/font/google';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/components/auth-provider';
import { ConsoleMark } from '@/components/console-mark';
import { HANDMADE_CSS, HandArrow, HandNote } from '@/components/handmade';
import {
  readTextSize,
  saveTextSize,
  TextSizeToggle,
  type TextSize,
} from '@/components/text-size-toggle';
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
 * The page's one typeface. Geometric, set medium and tight for headings, with
 * small labels in wide-spaced capitals. Only this page uses it: the console
 * keeps its own fonts, and so does the sign-in pop-up, which is the real
 * sign-in page.
 */
const josefin = Josefin_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-josefin',
  display: 'swap',
});

const CSS = `
/* In-page links (nav, section rail, hero buttons) glide to their section
   instead of jumping. Only present while this page is mounted, so the console
   is unaffected; the global reduced-motion rule turns it back into a jump. */
html{scroll-behavior:smooth}
[data-text="large"] main{zoom:1.12}
/* Josefin for everything on this page except the sign-in pop-up (.wl-keep).
   The mono font stays, for tokens, times and other data in the drawn screens. */
.wl-root>:not(.wl-keep){--font-display:var(--font-josefin);--font-sans:var(--font-josefin);font-family:var(--font-josefin),"Helvetica Neue",Arial,sans-serif;letter-spacing:.019em}
.wl-root>:not(.wl-keep) :is(h1,h2){font-weight:500;letter-spacing:-.05em}
.wl-root>:not(.wl-keep) h3{font-weight:600;letter-spacing:-.01em}
/* Accent words: same face and weight as the heading, set apart by colour. */
.wl-serif{font-family:inherit;font-style:normal;font-weight:inherit}
/* Josefin's letters sit high in the line box; nudging buttons down 3px
   re-centres the text between their edges. */
.wl-root .wl-btn{text-transform:uppercase;letter-spacing:.2em;font-size:13px;font-weight:500;padding-top:3px}
.wl-root .wl-nav{text-transform:uppercase;letter-spacing:.2em;font-size:12px;font-weight:500;padding-top:calc(.5rem + 2px)}
.wl-label{font-size:13px;font-weight:500;text-transform:uppercase;letter-spacing:.42em}
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
@keyframes wl-marquee{to{transform:translateX(-50%)}}
.wl-marquee{animation:wl-marquee 45s linear infinite}
.wl-marquee:hover{animation-play-state:paused}
@media (prefers-reduced-motion: reduce){.wl-marquee{animation:none}}
/* Clinic marks: their own colour by day, a lighter one at night. */
.wl-mark{color:var(--mark)}
[data-look="night"] .wl-mark{color:var(--mark-night)}
`;

/** Every section the side rail tracks, in page order. */
const SECTIONS = [
  { id: 'top', label: 'Overview' },
  { id: 'tour', label: 'Clinic tour' },
  { id: 'features', label: 'Features' },
  { id: 'roles', label: 'Roles' },
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
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
];

/** The header's "Book a demo": the console's dark pill, with the arrow chip. */
const DEMO_BUTTON =
  'wl-btn group hidden h-10 items-center gap-2 whitespace-nowrap rounded-pill bg-ink pl-4 pr-3 text-[13.5px] font-semibold text-white shadow-sm transition-all hover:bg-clinical-deep hover:shadow sm:inline-flex';

/** The hero's main button: the big clinical pill, with the arrow chip. */
const HERO_BUTTON =
  'wl-btn group inline-flex h-[52px] items-center justify-center gap-2.5 rounded-pill bg-clinical px-7 text-[15.5px] font-bold text-white shadow-[0_10px_30px_-10px_rgba(15,118,110,0.7)] transition-all hover:bg-clinical-deep active:translate-y-px';

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

  /** Standard or larger text, for this page and the sign-in form alike. */
  const [textSize, setTextSize] = useState<TextSize>('standard');
  useEffect(() => setTextSize(readTextSize()), []);

  function chooseTextSize(next: TextSize) {
    setTextSize(next);
    saveTextSize(next);
  }

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
      data-text={textSize}
      className={`${josefin.variable} wl-root relative isolate min-h-screen overflow-x-clip`}
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
          className={`mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 rounded-pill border pl-3 pr-2 transition-all duration-300 sm:pl-4 ${
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

          <nav className="hidden items-center xl:flex" aria-label="Page sections">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="wl-nav rounded-pill px-3.5 py-2 text-[13.5px] font-medium text-ink-60 transition-colors hover:bg-ink/5 hover:text-ink"
              >
                {n.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-1.5">
            <span className="hidden sm:inline-flex">
              <TextSizeToggle size={textSize} onChange={chooseTextSize} />
            </span>
            <NightToggle look={look} onToggle={toggleLook} />
            {/* Two doors, side by side: an outlined one for staff, a filled one
                for the clinic owner. Signed-in staff only need the first. */}
            <Link
              href={primary.href}
              onClick={openSignIn}
              className="wl-btn inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-pill border border-ink/15 bg-white/70 px-4 text-[13.5px] font-semibold text-ink backdrop-blur transition-colors hover:border-clinical/30 hover:bg-white"
            >
              {!signedIn && (
                <span className="hidden text-ink-40 sm:inline-flex">
                  <IconLock size={14} />
                </span>
              )}
              <span className="sm:hidden">{signedIn ? primary.short : 'Sign in'}</span>
              <span className="hidden sm:inline">
                {signedIn ? primary.label : 'Clinic sign-in'}
              </span>
            </Link>
            {!signedIn &&
              (BUSINESS.email ? (
                <button type="button" onClick={() => setDemoOpen(true)} className={DEMO_BUTTON}>
                  Book a demo
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5">
                    <ArrowRight size={12} />
                  </span>
                </button>
              ) : (
                <a href="#faq" className={DEMO_BUTTON}>
                  Book a demo
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5">
                    <ArrowRight size={12} />
                  </span>
                </a>
              ))}
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-full text-ink-60 hover:bg-ink/5 xl:hidden"
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
            className="mx-auto mt-2 max-w-5xl rounded-card border border-ink/10 bg-white/95 p-2 shadow-lg backdrop-blur-xl xl:hidden"
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
            {/* Two columns: the statement on the left, a queue you can work on
                the right. Stacks on phones, statement first. */}
            <div className="grid items-center gap-14 lg:grid-cols-[1.1fr_0.9fr] lg:gap-12">
              <div>
                <p className="wl-rise wl-label text-clinical-text">
                  OPD software for Indian clinics
                </p>

                <h1
                  className="wl-rise mt-6 text-[clamp(42px,6.2vw,80px)] font-extrabold leading-[0.98] tracking-[-0.045em]"
                  style={{ animationDelay: '80ms' }}
                >
                  {/* Heavy sans for the statement, a real italic serif for the
                      part that matters. Static on purpose: a headline that
                      changes while you read it is one more moving thing on a
                      screen in a busy clinic. */}
                  One clinic day.{' '}
                  <span className="wl-serif block text-clinical">One connected workspace.</span>
                </h1>

                <p
                  className="wl-rise mt-7 max-w-[540px] text-[clamp(16px,1.6vw,19px)] leading-relaxed text-ink-60"
                  style={{ animationDelay: '160ms' }}
                >
                  Register patients, run the queue, consult, order lab and X-ray tests, and bill,
                  all in one browser tab.
                </p>

                <div
                  className="wl-rise mt-9 flex flex-col items-stretch gap-5 sm:flex-row sm:items-center sm:gap-8"
                  style={{ animationDelay: '240ms' }}
                >
                  {/* This page is for the people who choose and pay for the
                      software. Staff have the sign-in button in the header. */}
                  {signedIn ? (
                    <Link href={primary.href} className={HERO_BUTTON}>
                      Open your console
                      <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5">
                        <ArrowRight size={15} />
                      </span>
                    </Link>
                  ) : BUSINESS.email ? (
                    <button type="button" onClick={() => setDemoOpen(true)} className={HERO_BUTTON}>
                      Book a demo
                      <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5">
                        <ArrowRight size={15} />
                      </span>
                    </button>
                  ) : (
                    <a href="#faq" className={HERO_BUTTON}>
                      Book a demo
                      <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5">
                        <ArrowRight size={15} />
                      </span>
                    </a>
                  )}
                  <a
                    href="#tour"
                    className="wl-btn self-center text-[16px] font-bold text-clinical-text underline decoration-clinical/30 decoration-2 underline-offset-[6px] transition-colors hover:decoration-clinical sm:self-auto"
                  >
                    See a clinic day
                  </a>
                </div>
              </div>

              <div className="wl-rise" style={{ animationDelay: '200ms' }}>
                <QueueDemo />
              </div>
            </div>

            {/* The four beats of a visit, numbered along the foot of the hero. */}
            <ol
              className="wl-rise mt-14 grid gap-x-8 gap-y-6 border-t border-ink/12 pt-7 sm:grid-cols-2 lg:grid-cols-4"
              style={{ animationDelay: '380ms' }}
            >
              {[
                {
                  t: 'Wait from home',
                  b: 'Token and live place in line on WhatsApp. A message when it is time to leave.',
                },
                {
                  t: 'Consult',
                  b: 'Pain since the last visit, last medicines and X-ray on one panel.',
                },
                {
                  t: 'Recover',
                  b: 'A 20-second check-in every few days. Rising pain goes to a person.',
                },
                {
                  t: 'Come back',
                  b: 'Every review due, who came back, and a one-tap nudge for the rest.',
                },
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

        {/* ==== Clinic tour =============================================== */}
        <section
          id="tour"
          className="scroll-mt-24 border-y border-ink/8 bg-white/25 px-4 py-24 sm:px-6 lg:py-32"
        >
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="Clinic tour"
                title={
                  <>
                    Follow token A-09{' '}
                    <span className="wl-serif text-clinical">through the clinic.</span>
                  </>
                }
                body="The screens reception, the doctor and billing use. Choose a stop to open one."
              />
            </Reveal>
            <Reveal delay={100}>
              <ClinicTour />
            </Reveal>
          </div>
        </section>

        {/* ==== Features bento ============================================ */}
        <section id="features" className="scroll-mt-24 px-4 py-24 sm:px-6 lg:py-32">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="Features"
                title={<>Built for the fortieth patient of the day.</>}
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
                title={<>Five people share the desk PC. Each gets their own screen.</>}
                body="Front desk, doctor, nurse, owner and admin sign in at the same place and land on what their job needs. Each role has its own colour, so anyone walking past can see whose session is open."
              />
            </Reveal>
            <RolesShowcase night={look === 'night'} />
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
                title={<>Your patients stay in your clinic.</>}
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

        {/* ==== Logo preview ============================================== */}
        <LogoStrip />

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
                title={<>What clinic owners ask first.</>}
                body="Staff with a sign-in question will find the answers on the sign-in page itself, under “Trouble signing in?”."
              />
            </Reveal>
            <Reveal delay={100}>
              <FaqList />
            </Reveal>
          </div>
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
  keepAppFonts = false,
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  /** Leave the console's fonts in place, for content that is a real app screen. */
  keepAppFonts?: boolean;
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
    <div
      className={`fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-6 ${keepAppFonts ? 'wl-keep' : ''}`}
    >
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
    <Modal label="Staff sign-in" onClose={onClose} className="max-w-[1000px]" keepAppFonts>
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
              Your email should be ready to send.
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
                Book a demo.
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
 * The heading's accent words (`wl-serif text-clinical`) are set apart by colour.
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
        <span className="wl-label text-clinical-text">{eyebrow}</span>
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
/*  Hero queue demo                                                            */
/* -------------------------------------------------------------------------- */

/** Sample patients for the hero card. Illustrative, and labelled as such. */
const DEMO_QUEUE = [
  { token: 'A-07', name: 'Meena Raghavan', note: 'In consultation' },
  { token: 'A-12', name: 'Imran Shaikh', note: 'Back from X-ray' },
  { token: 'A-08', name: 'Suresh Pillai', note: 'Waiting · 6 min' },
  { token: 'A-09', name: 'Kavya Nair', note: 'Booked by phone' },
] as const;

/** What each finished consultation adds to the day's collections. */
const DEMO_FEE = 500;

/**
 * A small OPD queue the visitor can actually work: "Call next" finishes the
 * patient in the chamber, moves everyone up, adds the fee to the day's total
 * and moves the clock on. When the queue runs out it offers to start over.
 */
function QueueDemo() {
  const [called, setCalled] = useState(0);
  const rows = DEMO_QUEUE.slice(called);
  const now = rows[0];

  const minutes = 40 + called * 7;
  const time = `${10 + Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} a.m.`;
  const collected = (14650 + called * DEMO_FEE).toLocaleString('en-IN');

  return (
    <figure className="relative mx-auto max-w-[540px]">
      {/* The soft disc behind the card */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -z-10 aspect-square w-[118%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-clinical-tint/70"
      />

      <div className="rounded-[28px] border border-ink/10 bg-white p-5 shadow-[0_30px_80px_-30px_rgba(40,50,45,0.35)] sm:p-6">
        <span className="badge-amber">Interactive demo · Sample data</span>
        <p className="mono-label mt-4">OPD queue · Dr. A. Kulkarni</p>
        <p className="mt-1.5 text-[19px] font-extrabold tracking-[-0.02em] text-ink">
          Tuesday, {time}
        </p>

        <ol className="mt-5 grid gap-2.5" aria-label="Today's queue">
          {rows.map((p, i) => (
            <li
              key={p.token}
              className={`wl-fade flex items-center gap-3.5 rounded-[16px] border p-3 ${
                i === 0
                  ? 'border-clinical/30 bg-clinical-tint'
                  : i === 1
                    ? 'border-ink/10 bg-bg-soft'
                    : 'border-ink/8 bg-white'
              }`}
            >
              <span
                className={`grid h-12 w-[60px] shrink-0 place-items-center rounded-[12px] font-mono text-[15px] font-bold ${
                  i === 0 ? 'bg-clinical text-white' : 'bg-ink/6 text-ink'
                }`}
              >
                {p.token}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15.5px] font-bold text-ink">{p.name}</span>
                <span className="block text-[13.5px] text-ink-60">
                  {i === 0 ? 'In consultation' : p.note}
                </span>
              </span>
              {i === 0 && <span className="badge-clinical">Now</span>}
              {i === 1 && <span className="badge-amber">Next</span>}
            </li>
          ))}
          {!now && (
            <li className="wl-fade rounded-[16px] border border-dashed border-ink/15 p-6 text-center text-[14.5px] text-ink-60">
              Queue clear. Everyone has been seen.
            </li>
          )}
        </ol>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-dashed border-ink/12 pt-4">
          <span className="flex items-center gap-2 text-[14px] text-ink-60">
            <span className="text-ink-40">
              <IconReceipt size={16} />
            </span>
            ₹{collected} collected today
          </span>
          <button
            type="button"
            onClick={() => setCalled((c) => (now ? c + 1 : 0))}
            className="inline-flex h-11 items-center gap-2 rounded-pill bg-clinical px-5 text-[14.5px] font-bold text-white transition-colors hover:bg-clinical-deep active:translate-y-px"
          >
            <IconBell size={15} />
            {now ? 'Call next' : 'Start over'}
          </button>
        </div>

        {/* Tells screen-reader users what "Call next" just did. */}
        <p className="sr-only" aria-live="polite">
          {now ? `Now serving ${now.token}, ${now.name}.` : 'Queue clear.'}
        </p>
      </div>

      <figcaption className="mt-5 text-center text-[13.5px] text-ink-40">
        Try &ldquo;Call next&rdquo;. Names and amounts are illustrative.
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/*  Clinic tour                                                                */
/* -------------------------------------------------------------------------- */

/** One labelled, read-only field in a tour card. */
function TourField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mono-label">{label}</p>
      <p className="mt-1.5 flex h-11 items-center rounded-[12px] border border-ink/10 bg-bg-soft px-3.5 text-[15px] text-ink">
        {value}
      </p>
    </div>
  );
}

/** The sample screen each stop of the tour shows, wrapped in the same card. */
function TourCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-ink/10 bg-white shadow-[0_30px_80px_-34px_rgba(40,50,45,0.35)]">
      <div className="flex items-center justify-between gap-3 border-b border-ink/8 bg-bg-soft px-5 py-3.5 sm:px-6">
        <p className="text-[15.5px] font-bold text-ink">{title}</p>
        <span className="badge-amber">Sample data</span>
      </div>
      <div className="p-5 sm:p-6">{children}</div>
    </div>
  );
}

/** A token chip with a line of text beside it: the "what just happened" row. */
function TourResult({
  token,
  title,
  sub,
  aside,
}: {
  token: string;
  title: string;
  sub: string;
  aside?: string;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[16px] bg-clinical-tint p-4">
      <span className="grid h-12 w-[60px] place-items-center rounded-[12px] bg-clinical font-mono text-[15px] font-bold text-white">
        {token}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-ink">{title}</span>
        <span className="block font-mono text-[12.5px] text-ink-60">{sub}</span>
      </span>
      {aside && <span className="text-[14px] text-ink-60">{aside}</span>}
    </div>
  );
}

/**
 * The three stops of one visit. Every bullet is something the console does:
 * registration issues a UHID and a token together, tests are ordered and read
 * inside the consultation, payments take cash, UPI, card or a mix of them.
 */
const TOUR_STEPS: {
  stop: string;
  time: string;
  eyebrow: string;
  title: string;
  points: string[];
  card: ReactNode;
}[] = [
  {
    stop: 'Front desk',
    time: '9:05',
    eyebrow: 'Reception',
    title: 'Registered before they sit down.',
    points: [
      'Name, mobile number and age are enough to register.',
      'A UHID and a token for the chosen doctor are issued together.',
      'Phone bookings arrive with their token already assigned.',
    ],
    card: (
      <TourCard title="Register patient">
        <div className="grid gap-4 sm:grid-cols-2">
          <TourField label="Name" value="Kavya Nair" />
          <TourField label="Mobile" value="98••• ••210" />
          <TourField label="Age" value="34" />
          <TourField label="Doctor" value="Dr. A. Kulkarni" />
        </div>
        <TourResult
          token="A-09"
          title="Token issued"
          sub="UHID CL-10482"
          aside="3rd in Dr. Kulkarni’s queue"
        />
      </TourCard>
    ),
  },
  {
    stop: 'Doctor',
    time: '9:20',
    eyebrow: 'Consultation',
    title: 'One screen for the whole consult.',
    points: [
      'Vitals, complaints and past visits sit on the same panel.',
      'Medicines go in as structured rows, not a paragraph of free text.',
      'An X-ray or lab test is ordered here, and read here when it is back.',
    ],
    card: (
      <TourCard title="Consultation · Kavya Nair, 34 F">
        <div className="grid grid-cols-3 gap-2.5">
          {[
            ['BP', '118/76'],
            ['Pulse', '82'],
            ['SpO₂', '99%'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-[12px] bg-bg-soft px-3 py-2.5">
              <p className="mono-label">{k}</p>
              <p className="mt-1 font-mono text-[16px] font-bold text-ink">{v}</p>
            </div>
          ))}
        </div>
        <p className="mono-label mt-5">Prescription</p>
        <ul className="mt-2 divide-y divide-ink/8 rounded-[12px] border border-ink/10">
          {[
            ['Tab. Paracetamol 650 mg', '1-0-1 · 3 days'],
            ['Tab. Pantoprazole 40 mg', '1-0-0 · 5 days'],
          ].map(([drug, dose]) => (
            <li key={drug} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <span className="text-[14.5px] font-semibold text-ink">{drug}</span>
              <span className="font-mono text-[12.5px] text-ink-60">{dose}</span>
            </li>
          ))}
        </ul>
        <TourResult
          token="A-09"
          title="X-ray chest PA ordered"
          sub="Sent to the X-ray room"
          aside="Back in ~20 min"
        />
      </TourCard>
    ),
  },
  {
    stop: 'Checkout',
    time: '10:10',
    eyebrow: 'Billing',
    title: 'Paid, printed and on their way.',
    points: [
      'The consultation and the test are already on the bill.',
      'Cash, UPI or card, or part of each.',
      'Receipt and prescription print with your clinic’s name.',
    ],
    card: (
      <TourCard title="Bill · Kavya Nair">
        <ul className="divide-y divide-ink/8">
          {[
            ['Consultation · Dr. A. Kulkarni', '₹500'],
            ['X-ray chest PA', '₹400'],
          ].map(([item, amt]) => (
            <li key={item} className="flex items-center justify-between gap-3 py-2.5 text-[14.5px]">
              <span className="text-ink-60">{item}</span>
              <span className="font-mono font-semibold text-ink">{amt}</span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 py-3 text-[16px] font-bold text-ink">
            Total
            <span className="font-mono">₹900</span>
          </li>
        </ul>
        <div className="mt-2 flex gap-2">
          {['Cash', 'UPI', 'Card'].map((m) => (
            <span
              key={m}
              className={`rounded-pill px-4 py-1.5 text-[13.5px] font-semibold ${
                m === 'UPI' ? 'bg-clinical text-white' : 'border border-ink/12 text-ink-60'
              }`}
            >
              {m}
            </span>
          ))}
        </div>
        <TourResult token="A-09" title="Payment recorded" sub="Receipt R-1043 · ₹900" />
      </TourCard>
    ),
  },
];

/**
 * Three stops along a dashed line, with the token riding on the current one,
 * and the screen for that stop underneath. Back, next, or click any stop.
 */
function ClinicTour() {
  const [step, setStep] = useState(0);
  const current = TOUR_STEPS[step]!;
  const next = TOUR_STEPS[step + 1];

  return (
    <div className="mt-14">
      <ol className="relative grid grid-cols-3" aria-label="Stops in the visit">
        <span
          aria-hidden="true"
          className="absolute left-[16.66%] right-[16.66%] top-[54px] border-t-2 border-dashed border-ink/15"
        />
        {TOUR_STEPS.map((s, i) => {
          const active = i === step;
          return (
            <li key={s.stop} className="relative flex justify-center">
              <button
                type="button"
                onClick={() => setStep(i)}
                aria-current={active ? 'step' : undefined}
                className="group flex flex-col items-center rounded-card px-2 pb-2 text-center"
              >
                <span
                  className={`mb-2 h-7 rounded-[8px] px-2.5 font-mono text-[13px] font-bold leading-7 text-white transition-opacity ${
                    active ? 'bg-clinical opacity-100' : 'opacity-0'
                  }`}
                  aria-hidden={!active}
                >
                  A-09
                </span>
                <span
                  className={`relative grid h-9 w-9 place-items-center rounded-full font-mono text-[14px] font-bold transition-colors ${
                    active
                      ? 'bg-clinical text-white ring-4 ring-clinical/20'
                      : i < step
                        ? 'bg-clinical-tint text-clinical-text'
                        : 'border-2 border-ink/15 bg-bg-soft text-ink-60 group-hover:border-clinical/30'
                  }`}
                >
                  {i < step ? <IconCheck size={15} /> : i + 1}
                </span>
                <span
                  className={`mt-3 text-[clamp(15px,1.6vw,18px)] font-bold ${
                    active ? 'text-clinical-text' : 'text-ink'
                  }`}
                >
                  {s.stop}
                </span>
                <span className="mt-1 whitespace-nowrap font-mono text-[11px] text-ink-40 sm:text-[12.5px]">
                  Step {i + 1} · {s.time}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div
        key={step}
        className="wl-fade mt-12 grid items-center gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16"
      >
        <div>
          <p className="wl-label text-clinical-text">{current.eyebrow}</p>
          <h3 className="mt-4 text-[clamp(26px,3.2vw,38px)] font-extrabold leading-[1.05] tracking-[-0.03em]">
            {current.title}
          </h3>
          <ul className="mt-7 divide-y divide-ink/8 border-y border-ink/10">
            {current.points.map((p) => (
              <li key={p} className="py-4 text-[16px] leading-relaxed text-ink-60">
                {p}
              </li>
            ))}
          </ul>
        </div>
        {current.card}
      </div>

      <div className="mt-12 flex items-center justify-between gap-4 border-t border-ink/10 pt-6">
        <button
          type="button"
          onClick={() => setStep((s) => s - 1)}
          className={`text-[14.5px] font-semibold text-ink-60 hover:text-ink ${step === 0 ? 'invisible' : ''}`}
        >
          ← Back
        </button>
        {/* Not shown; tells screen-reader users which stop just opened. */}
        <p className="sr-only" aria-live="polite">
          Step {step + 1} of {TOUR_STEPS.length}: {current.stop}
        </p>
        <button
          type="button"
          onClick={() => setStep(next ? step + 1 : 0)}
          className="wl-btn group inline-flex h-11 items-center gap-2 rounded-pill bg-clinical px-5 text-[14.5px] font-bold text-white transition-colors hover:bg-clinical-deep"
        >
          {next ? `Next: ${next.stop}` : 'Start again'}
          <span className="transition-transform group-hover:translate-x-0.5">
            <ArrowRight size={14} />
          </span>
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Logo preview                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Six made-up clinics, to show how a row of clinic marks will sit on the page.
 * None of them is a client, and the heading says so: no invented customers.
 * Swap in real logos, with permission, once there are some.
 */
const PREVIEW_CLINICS: {
  name: string;
  kind: string;
  color: string;
  night: string;
  mark: ReactNode;
}[] = [
  {
    name: 'Neemgrove',
    kind: 'Clinic',
    color: '#0F5E57',
    night: '#4CC3B3',
    mark: (
      <>
        <path d="M6 26C6 13 15 6 28 6c0 13-7 22-20 22Z" fill="currentColor" />
        <path d="M9 24 22 11" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      </>
    ),
  },
  {
    name: 'Tulsivan',
    kind: 'Children’s care',
    color: '#6E8B3D',
    night: '#9DBB66',
    mark: (
      <>
        <path d="M17 8c4 6 7 10 7 14a7 7 0 0 1-14 0c0-4 3-8 7-14Z" fill="currentColor" />
        <path
          d="M14 23a3 3 0 0 0 3 3"
          stroke="#fff"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </>
    ),
  },
  {
    name: 'Saffron Hill',
    kind: 'Eye centre',
    color: '#A8792B',
    night: '#D9A94F',
    mark: (
      <>
        <circle cx="17" cy="17" r="5.5" fill="currentColor" />
        <path
          d="M17 3v5M17 26v5M3 17h5M26 17h5M7 7l3.5 3.5M23.5 23.5 27 27M7 27l3.5-3.5M23.5 10.5 27 7"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    name: 'Ridgeway',
    kind: 'Family health',
    color: '#B4615E',
    night: '#E08F8B',
    mark: (
      <path
        d="M3 27 12 13l5 7 5-9 9 16Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
    ),
  },
  {
    name: 'Monsoon Street',
    kind: 'Diagnostics',
    color: '#45698C',
    night: '#8FB3D6',
    mark: (
      <>
        <path
          d="M10 19a5 5 0 0 1 1-9.9A7 7 0 0 1 24.5 10 4.5 4.5 0 0 1 24 19Z"
          fill="currentColor"
        />
        <path
          d="M12 23l-1.5 4M18 23l-1.5 4M24 23l-1.5 4"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    name: 'Pebble Bay',
    kind: 'Dental',
    color: '#6B4A6B',
    night: '#C49AC4',
    mark: (
      <path
        d="M11 6c-4 0-6 3-6 7 0 5 2 7 3 13 .4 2.5 3.4 2.5 4 0l1.6-6c.5-2 3.3-2 3.8 0l1.6 6c.6 2.5 3.6 2.5 4 0 1-6 3-8 3-13 0-4-2-7-6-7-2.5 0-3.5 1.5-4.5 1.5S13.5 6 11 6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
    ),
  },
];

/** The clinic marks, drifting sideways and fading out at both edges. */
function LogoStrip() {
  const row = (hidden: boolean) => (
    <ul className="flex shrink-0" aria-hidden={hidden || undefined}>
      {PREVIEW_CLINICS.map((c) => (
        <li
          key={c.name}
          className="flex w-[220px] shrink-0 flex-col items-center text-center sm:w-[280px]"
        >
          <svg
            viewBox="0 0 34 34"
            width="44"
            height="44"
            className="wl-mark"
            style={{ '--mark': c.color, '--mark-night': c.night } as React.CSSProperties}
            aria-hidden="true"
          >
            {c.mark}
          </svg>
          <span className="mt-5 font-display text-[19px] font-extrabold tracking-[-0.02em] text-ink">
            {c.name}
          </span>
          <span className="mt-1.5 font-mono text-[11.5px] uppercase tracking-label text-ink-60">
            {c.kind}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-labelledby="logo-preview" className="px-4 pb-24 pt-8 sm:px-6 lg:pb-28">
      <div className="mx-auto max-w-6xl text-center">
        <p className="flex items-center justify-center gap-5">
          <span aria-hidden="true" className="h-px w-12 bg-ink/15 sm:w-20" />
          <span id="logo-preview" className="wl-label text-clinical-text">
            Illustrative clinic logo preview
          </span>
          <span aria-hidden="true" className="h-px w-12 bg-ink/15 sm:w-20" />
        </p>
        <p className="mt-3 text-[15.5px] text-ink-60">
          Fictional clinics, shown for design only, not our clients. Client logos coming soon.
        </p>
      </div>

      <div
        className="mx-auto mt-14 max-w-6xl overflow-hidden"
        style={{
          maskImage: 'linear-gradient(to right, transparent, black 15%, black 85%, transparent)',
          WebkitMaskImage:
            'linear-gradient(to right, transparent, black 15%, black 85%, transparent)',
        }}
      >
        {/* Two copies back to back; sliding by half loops without a seam. */}
        <div className="wl-marquee flex w-max">
          {row(false)}
          {row(true)}
        </div>
      </div>
    </section>
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
      'Patients get their token on WhatsApp and wait from home',
      'See who is on the way, running late or told to leave',
      'Take payments and print receipts in one step',
    ],
    only: 'The queue, the cash counter and every patient arriving',
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
      'Pain and exercise check-ins since the last visit, as a chart',
      'Repeat last visit’s medicines in one click, then edit',
      'Send the signed prescription to the patient’s WhatsApp',
    ],
    only: 'Their own patients’ notes, prescriptions and recovery',
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
      'See whose pain is rising between visits',
      'See at a glance who is waiting for which doctor',
    ],
    only: 'Vitals and triage. Reads notes, never writes a prescription',
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
      'How many patients came back for review, week by week',
      'The money those reviews kept, in rupees',
      'Set prices and run promotions from settings',
    ],
    only: 'The numbers. Reads everything, changes none of it',
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
    only: 'Staff, roles, branding and screens. Set once, audited after',
  },
] as const;

/** How long each role stays on screen before the next one comes up. */
const ROLE_ROTATE_MS = 3500;

function RolesShowcase({ night }: { night: boolean }) {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const role = ROLES[active] ?? ROLES[0];

  /*
   * The roles take turns on their own, so a visitor sees what each one gets
   * without having to find the tabs. Three things stop it: a pointer over the
   * section or keyboard focus inside it (someone is reading), the section being
   * off screen (nobody is), and a reduced-motion preference (WCAG 2.2.2 — a
   * reader who asked for stillness gets the tabs and nothing else). Clicking a
   * tab restarts the clock from that role.
   */
  const shell = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inView, setInView] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const el = shell.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), {
      threshold: 0.35,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const rotating = inView && !hovered && !focused && !reduced;

  useEffect(() => {
    if (!rotating) return;
    const t = setTimeout(() => setActive((a) => (a + 1) % ROLES.length), ROLE_ROTATE_MS);
    return () => clearTimeout(t);
  }, [active, rotating]);

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
        ref={shell}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
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
            <p
              className="mt-7 rounded-panel px-3.5 py-2.5 text-[13px] font-medium"
              style={{ backgroundColor: tone.soft, color: tone.text }}
            >
              Sees: {role.only}
            </p>
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
              <RoleScreen roleKey={role.key} tone={tone} />
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

type RoleTone = { color: string; soft: string; text: string; blank: string; on: string };

/**
 * What each role actually has open, drawn as a different SCREEN rather than
 * the same card with different numbers — so the difference between the five
 * logins is visible at a glance, before anybody reads the bullet points.
 * Names and figures are illustrative.
 */
function RoleScreen({ roleKey, tone }: { roleKey: string; tone: RoleTone }) {
  switch (roleKey) {
    case 'front_desk':
      return <FrontDeskScreen tone={tone} />;
    case 'doctor':
      return <DoctorScreen tone={tone} />;
    case 'nurse':
      return <NurseScreen tone={tone} />;
    case 'owner':
      return <OwnerScreen tone={tone} />;
    default:
      return <AdminScreen tone={tone} />;
  }
}

function ScreenTitle({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p className="text-[13.5px] font-bold">{title}</p>
      <p className="font-mono text-[10px] uppercase tracking-label text-ink-40">{meta}</p>
    </div>
  );
}

/** Status colours for both looks. Inline, because the night rules on this page
 * cannot reach a colour set in a style attribute. */
const CHIP = {
  day: {
    green: ['#DCEFE1', '#1F5531'],
    amber: ['#FBEBC4', '#9A6C00'],
    coral: ['#F8C9BE', '#B23A22'],
    neutral: ['rgba(22,24,28,.06)', '#54514B'],
  },
  night: {
    green: ['rgba(46,114,69,.28)', '#8FD3A6'],
    amber: ['rgba(232,178,60,.16)', '#F0C969'],
    coral: ['rgba(228,103,79,.18)', '#F4A593'],
    neutral: ['rgba(228,234,232,.08)', '#B3BDBA'],
  },
} as const;

type ChipTone = keyof (typeof CHIP)['day'];

/** The night look is the one whose text on a role colour is dark. */
const isNight = (tone: RoleTone) => tone.on !== '#FFFFFF';

function Chip({ children, tone, role }: { children: ReactNode; tone: ChipTone; role: RoleTone }) {
  const [bg, fg] = CHIP[isNight(role) ? 'night' : 'day'][tone];
  return (
    <span
      className="shrink-0 rounded-pill px-2 py-0.5 font-mono text-[9.5px] font-medium uppercase tracking-label"
      style={{ backgroundColor: bg, color: fg }}
    >
      {children}
    </span>
  );
}

function MiniButton({
  children,
  tone,
  solid,
}: {
  children: ReactNode;
  tone: RoleTone;
  solid?: boolean;
}) {
  return (
    <span
      className="shrink-0 rounded-pill border px-2.5 py-1 text-[11px] font-semibold"
      style={
        solid
          ? { backgroundColor: tone.color, borderColor: tone.color, color: tone.on }
          : { borderColor: tone.color, color: tone.text }
      }
    >
      {children}
    </span>
  );
}

/** The queue, with the thing to DO on each row. */
function FrontDeskScreen({ tone }: { tone: RoleTone }) {
  const rows = [
    { t: 14, n: 'Geeta Sharma', chip: ['green', 'On the way'], act: 'Check in', solid: true },
    { t: 15, n: 'Ramesh Kumar', chip: ['neutral', 'Waiting · paid'], act: 'Call' },
    { t: 16, n: 'Sunita Patil', chip: ['neutral', 'At home · told to leave'] },
    { t: 17, n: 'Arjun Shah', chip: ['amber', 'Unpaid ₹350'], act: 'Collect' },
  ] as const;
  return (
    <div className="p-4">
      <ScreenTitle title="Today’s queue" meta="7 waiting · 4 at home" />
      <ul className="mt-3 divide-y divide-ink/6 rounded-panel border border-ink/8">
        {rows.map((r) => (
          <li key={r.t} className="flex items-center gap-2.5 px-3 py-2.5">
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-tiny font-mono text-[12px] font-bold"
              style={{ backgroundColor: tone.soft, color: tone.text }}
            >
              {r.t}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold">{r.n}</span>
              <span className="mt-0.5 inline-block">
                <Chip tone={r.chip[0]} role={tone}>
                  {r.chip[1]}
                </Chip>
              </span>
            </span>
            {'act' in r && (
              <MiniButton tone={tone} solid={'solid' in r}>
                {r.act}
              </MiniButton>
            )}
          </li>
        ))}
      </ul>
      <p
        className="mt-3 flex items-center gap-2 rounded-panel px-3 py-2 text-[11.5px]"
        style={{
          backgroundColor: CHIP[isNight(tone) ? 'night' : 'day'].green[0],
          color: CHIP[isNight(tone) ? 'night' : 'day'].green[1],
        }}
      >
        <span aria-hidden="true">●</span>
        Token 18 sent to Meera on WhatsApp, with her live place in line
      </p>
    </div>
  );
}

/** One patient, how they did since last time, and the prescription. */
function DoctorScreen({ tone }: { tone: RoleTone }) {
  const pain = [7, 6, 6, 4, 4, 3];
  const x = (i: number) => 6 + (i / (pain.length - 1)) * 128;
  const y = (v: number) => 6 + (1 - v / 10) * 48;
  const line = pain.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  return (
    <div className="p-4">
      <ScreenTitle title="Ramesh Kumar · 64 M" meta="Token 20 · visit 3" />
      <div className="mt-3 grid grid-cols-[1.1fr_1fr] gap-2.5">
        <div className="rounded-panel border border-ink/8 p-3">
          <p className="font-mono text-[9.5px] uppercase tracking-label text-ink-40">
            Pain since last visit
          </p>
          <svg viewBox="0 0 140 60" className="mt-1 h-[60px] w-full" aria-hidden="true">
            <path d={`${line} L${x(pain.length - 1)},54 L${x(0)},54 Z`} fill={tone.soft} />
            <path
              d={line}
              fill="none"
              stroke={tone.color}
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <circle cx={x(pain.length - 1)} cy={y(3)} r="3.5" fill={tone.color} />
          </svg>
          <p className="text-[12px] font-bold" style={{ color: tone.text }}>
            7 → 3 · exercises 5 of 6 days
          </p>
        </div>
        <div className="rounded-panel border border-ink/8 p-3">
          <p className="font-mono text-[9.5px] uppercase tracking-label text-ink-40">Last time</p>
          <p className="mt-1.5 text-[11.5px] leading-snug">Diclofenac gel 1% · 1-0-1</p>
          <p className="text-[11.5px] leading-snug">Physio 3× a week</p>
          <p className="mt-2 text-[11px] font-semibold" style={{ color: tone.text }}>
            Repeat these →
          </p>
        </div>
      </div>
      <div className="mt-2.5 rounded-panel border border-ink/8 p-3">
        <p className="font-mono text-[9.5px] uppercase tracking-label text-ink-40">
          Today’s prescription
        </p>
        <p className="mt-1.5 text-[11.5px]">1. Diclofenac gel 1% · 1-0-1 · 2 weeks</p>
        <p className="text-[11.5px]">2. Calcium + D3 · 0-0-1 · 1 month</p>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-40">
            Review in 2 weeks · check-ins every 3 days
          </span>
          <MiniButton tone={tone} solid>
            Sign &amp; send
          </MiniButton>
        </div>
      </div>
    </div>
  );
}

/** A vitals form being filled, and the room she is watching. */
function NurseScreen({ tone }: { tone: RoleTone }) {
  const vitals = [
    ['BP', '138/86'],
    ['Pulse', '82'],
    ['SpO₂', '97%'],
    ['Weight', '71 kg'],
  ];
  return (
    <div className="p-4">
      <ScreenTitle title="Vitals · Ramesh Kumar" meta="Before Dr. Rao" />
      <div className="mt-3 grid grid-cols-4 gap-2">
        {vitals.map(([k, v]) => (
          <div
            key={k}
            className="rounded-panel border-[1.5px] p-2"
            style={{ borderColor: tone.soft }}
          >
            <p className="font-mono text-[9px] uppercase tracking-label text-ink-40">{k}</p>
            <p className="mt-0.5 text-[13.5px] font-bold">{v}</p>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex justify-end">
        <MiniButton tone={tone} solid>
          Save vitals
        </MiniButton>
      </div>
      <p className="mt-3 font-mono text-[9.5px] uppercase tracking-label text-ink-40">
        Waiting room
      </p>
      <ul className="mt-1.5 space-y-1.5">
        <li className="flex items-center gap-2.5 rounded-panel border border-ink/8 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">
            Lata Iyer · dizzy
          </span>
          <Chip tone="amber" role={tone}>
            Seen next
          </Chip>
        </li>
        <li
          className="flex items-center gap-2.5 rounded-panel border px-3 py-2"
          style={{ borderColor: CHIP[isNight(tone) ? 'night' : 'day'].coral[0] }}
        >
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">
            Rekha Iyer · pain 5 → 8 at home
          </span>
          <Chip tone="coral" role={tone}>
            Call back
          </Chip>
        </li>
      </ul>
    </div>
  );
}

/** The money and the return rate, as charts, not rows. */
function OwnerScreen({ tone }: { tone: RoleTone }) {
  const week = [12.1, 15.4, 14.2, 17.8, 16.3, 21.0, 18.4];
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const max = Math.max(...week);
  return (
    <div className="p-4">
      <ScreenTitle title="This week" meta="Read-only" />
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[9.5px] uppercase tracking-label text-ink-40">
            Collected today
          </p>
          <p className="text-[26px] font-extrabold leading-none tracking-[-0.02em]">₹18,400</p>
          <p className="mt-1 text-[11px] text-ink-40">Cash ₹6,200 · UPI ₹12,200</p>
        </div>
        <div className="rounded-panel px-3 py-2 text-right" style={{ backgroundColor: tone.soft }}>
          <p className="font-mono text-[9px] uppercase tracking-label" style={{ color: tone.text }}>
            Came back
          </p>
          <p className="text-[18px] font-extrabold leading-none" style={{ color: tone.text }}>
            83%
          </p>
        </div>
      </div>
      <div
        className="mt-4 flex h-24 items-end gap-2 border-b border-ink/10 pb-1"
        aria-hidden="true"
      >
        {week.map((v, i) => (
          <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
            <div
              className="w-full rounded-t-[4px]"
              style={{
                height: `${(v / max) * 80}px`,
                backgroundColor: i === week.length - 1 ? tone.color : tone.soft,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2" aria-hidden="true">
        {days.map((d, i) => (
          <span key={i} className="flex-1 text-center font-mono text-[9px] text-ink-40">
            {d}
          </span>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-ink-60">
        Reviews kept this week: <strong className="text-ink">₹13,300</strong>
      </p>
    </div>
  );
}

/** Staff, roles and switches: the clinic's setup, not its day. */
function AdminScreen({ tone }: { tone: RoleTone }) {
  const staff = [
    ['Asha Pawar', 'Front desk', '#3a4e9b'],
    ['Dr. Kiran Rao', 'Doctor', '#6b3fa0'],
    ['Anita Joseph', 'Nurse', '#a83a6e'],
  ];
  const switches = [
    ['Two-factor for admins', true],
    ['WhatsApp consent at registration', true],
    ['Patient names on the TV', false],
  ] as const;
  return (
    <div className="p-4">
      <ScreenTitle title="Clinic settings" meta="14 staff · 2 screens" />
      <ul className="mt-3 space-y-1.5">
        {staff.map(([n, r, c]) => (
          <li
            key={n}
            className="flex items-center gap-2.5 rounded-panel border border-ink/8 px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{n}</span>
            <span
              className="rounded-pill px-2 py-0.5 text-[10.5px] font-semibold text-white"
              style={{ backgroundColor: c }}
            >
              {r}
            </span>
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-2 rounded-panel bg-bg-soft p-3">
        {switches.map(([label, on]) => (
          <li key={label} className="flex items-center justify-between gap-3 text-[11.5px]">
            {label}
            <span
              aria-hidden="true"
              className="relative h-4 w-7 shrink-0 rounded-full transition-colors"
              style={{
                backgroundColor: on
                  ? tone.color
                  : isNight(tone)
                    ? 'rgba(228,234,232,.22)'
                    : 'rgba(22,24,28,.18)',
              }}
            >
              <span
                className="absolute top-0.5 h-3 w-3 rounded-full bg-white"
                style={{ left: on ? '14px' : '2px' }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Waiting-room display                                                       */
/* -------------------------------------------------------------------------- */

function DisplayShowcase() {
  return (
    <section id="display" className="relative scroll-mt-24 px-4 py-24 sm:px-6 lg:py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal className="grid items-end gap-6 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="flex items-baseline gap-3 text-[14px] font-semibold">
              <span className="text-ink-60">Waiting room</span>
              <span aria-hidden="true" className="h-px flex-1 self-center bg-ink/12" />
            </p>
            <h2 className="mt-5 text-[clamp(30px,4.6vw,52px)] font-extrabold leading-[1.04] tracking-[-0.03em] text-ink">
              The token screen in the{' '}
              <span className="wl-serif font-normal text-clinical-text">waiting room.</span>
            </h2>
          </div>
          <p className="max-w-md text-[16px] leading-relaxed text-ink-60">
            Pair any TV with a key from settings. It shows who each doctor is seeing and who&rsquo;s
            next, and updates on its own.
          </p>
        </Reveal>

        {/* Bento: the TV gets the big tile, and each promise gets a small tile
            that shows it rather than just saying it. */}
        <div className="mt-10 grid gap-4 lg:grid-cols-[1.6fr_1fr] lg:grid-rows-3">
          <Reveal
            delay={120}
            className="flex flex-col justify-center rounded-card-lg border border-ink/8 bg-gradient-to-br from-clinical-tint to-white to-65% p-4 sm:p-8 lg:row-span-3"
          >
            <div className="relative rounded-[26px] border border-black/40 bg-gradient-to-b from-[#24272c] to-[#0b0c0e] p-2.5 shadow-[0_50px_90px_-45px_rgba(22,24,28,0.55),0_0_0_1px_rgba(255,255,255,0.04)_inset] sm:p-3.5">
              {/* Camera dot on the bezel */}
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-[5px] h-1 w-1 -translate-x-1/2 rounded-full bg-white/20 sm:top-[7px]"
              />
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
          </Reveal>

          <Reveal delay={180} className="rounded-card-lg border border-ink/8 bg-white p-5">
            <p className="mono-label">Pair in seconds</p>
            <div aria-hidden="true" className="mt-3 flex gap-1.5">
              {'K7P42Q'.split('').map((c, i) => (
                <span
                  key={i}
                  className="grid h-10 w-8 place-items-center rounded-[9px] border border-ink/10 bg-bg-soft font-mono text-[17px] font-bold"
                >
                  {c}
                </span>
              ))}
            </div>
            <h3 className="mt-3 font-display text-[17px] font-bold tracking-[-0.015em]">
              Any smart TV or browser
            </h3>
            <p className="mt-1 text-[13.5px] leading-snug text-ink-60">
              Type the key from settings. Nothing to install.
            </p>
          </Reveal>

          <Reveal delay={240} className="rounded-card-lg border border-ink/8 bg-white p-5">
            <span className="flex items-center gap-2 font-mono text-[12px] text-clinical-text">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-clinical shadow-[0_0_0_5px_rgba(15,118,110,0.15)]"
              />
              Updated 2s ago
            </span>
            <h3 className="mt-3 font-display text-[17px] font-bold tracking-[-0.015em]">
              One board per doctor
            </h3>
            <p className="mt-1 text-[13.5px] leading-snug text-ink-60">
              Moves on its own as the desk calls patients in.
            </p>
          </Reveal>

          <Reveal delay={300} className="rounded-card-lg border border-ink/8 bg-white p-5">
            <div aria-hidden="true" className="flex items-center gap-2.5">
              <span className="text-[13px] text-ink-20 line-through">Meera Pillai</span>
              <ArrowRight size={12} />
              <span className="rounded-[8px] bg-clinical-soft px-2.5 py-0.5 font-mono text-[19px] font-bold text-clinical">
                20
              </span>
            </div>
            <h3 className="mt-3 font-display text-[17px] font-bold tracking-[-0.015em]">
              Tokens only
            </h3>
            <p className="mt-1 text-[13.5px] leading-snug text-ink-60">
              Patients&rsquo; names never go on the wall.
            </p>
          </Reveal>
        </div>
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
