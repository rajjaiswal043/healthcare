'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import {
  DoctorDeskMark,
  HAND_DRAW_CSS,
  HandArrow,
  Handwritten,
  IconArrowRight,
  IconBell,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconEyeOff,
  IconFlask,
  IconHome,
  IconKey,
  IconKeyboard,
  IconLock,
  IconMenu,
  IconReceipt,
  IconRx,
  IconSearch,
  IconShield,
  IconTag,
  IconUserPlus,
  IconUsers,
  IconX,
  nightLookCss,
} from './marks';

/* ---- Page configuration --------------------------------------------------- */

/**
 * Everything on this page that belongs to the business rather than the product.
 *
 * Left blank until it is real. Each block below renders only when its fields
 * are filled, so an empty string hides a section instead of printing a
 * placeholder to a clinic owner.
 */
const SITE = {
  companyName: '',
  address: '',
  email: '',
  phone: '',
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

const SECTIONS = [
  { id: 'top', label: 'Overview' },
  { id: 'workflow', label: 'How it works' },
  { id: 'features', label: 'Features' },
  { id: 'roles', label: 'Roles' },
  { id: 'display', label: 'Waiting room' },
  { id: 'security', label: 'Security' },
  { id: 'faq', label: 'FAQ' },
];

const NAV = [
  { href: '#features', label: 'Features' },
  { href: '#workflow', label: 'How it works' },
  { href: '#roles', label: 'Roles' },
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
];

const HEADER_DEMO =
  'wl-btn group hidden h-10 items-center gap-2 whitespace-nowrap rounded-pill bg-clinical pl-4 pr-3 text-[13.5px] font-semibold text-white shadow-sm transition-all hover:bg-clinical-text hover:shadow sm:inline-flex';
const HERO_CTA =
  'wl-btn group inline-flex h-[52px] items-center justify-center gap-2.5 rounded-pill bg-clinical px-7 text-[15.5px] font-bold text-white shadow-sm transition-colors hover:bg-clinical-deep active:translate-y-px';

/* Scoped to this page: only present while it is mounted, so the console's own
   type and motion are untouched. */
const PAGE_CSS = `
/* In-page links (nav, section rail, hero buttons) glide to their section
   instead of jumping. Only present while this page is mounted, so the console
   is unaffected; the global reduced-motion rule turns it back into a jump. */
html{scroll-behavior:smooth}
.wl-root>:not(.wl-keep){font-family:var(--font-sans),ui-sans-serif,system-ui,sans-serif}
.wl-root>:not(.wl-keep) :is(h1,h2){font-family:var(--font-display),ui-sans-serif,system-ui,sans-serif;font-weight:700;letter-spacing:-.04em}
.wl-root>:not(.wl-keep) h3{font-weight:600;letter-spacing:-.01em}
.wl-serif{font-family:inherit;font-style:normal;font-weight:700}
.wl-root .wl-btn{text-transform:none;letter-spacing:0;font-size:14px;font-weight:600;padding-top:0}
.wl-root .wl-nav{text-transform:none;letter-spacing:0;font-size:14px;font-weight:500;padding-top:.5rem}
.wl-label{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.14em}
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
/* Clinic marks retain a consistent accent on the light landing page. */
${HAND_DRAW_CSS}${nightLookCss({
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
  '.bg-ink\\/6, .bg-ink\\/10, .bg-ink\\/12, .bg-ink\\/15': 'background-color:rgba(228,234,232,.1)',
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
  '.bg-\\[\\#FFFDF8\\]': 'background-color:#1C2426',
  '.bg-\\[\\#e2e6f6\\]': 'background-color:rgba(143,160,230,.18)',
  '.text-\\[\\#2b3a75\\]': 'color:#B9C4F0',
})}`;

/* ---- Page ----------------------------------------------------------------- */

export function WelcomePage() {
  const { session, loading } = useAuth();
  const signedIn = !loading && !!session;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const staff = signedIn
    ? { href: '/', label: 'Open console', short: 'Console' }
    : { href: '/login', label: 'Staff sign-in', short: 'Sign in' };

  const [demoOpen, setDemoOpen] = useState(false);
  const closeDemo = useCallback(() => setDemoOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // In-page anchors scroll smoothly, and the skip link also moves focus.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const link = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
      const id = link?.getAttribute('href')?.slice(1);
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      e.preventDefault();
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      if (id === 'main') target.focus({ preventScroll: true });
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const demoButton = (className: string, arrowSize: number, label = 'Book a demo') =>
    SITE.email ? (
      <button type="button" onClick={() => setDemoOpen(true)} className={className}>
        {label}
        <ArrowBubble size={arrowSize} />
      </button>
    ) : (
      <a href="#contact" className={className}>
        {label}
        <ArrowBubble size={arrowSize} />
      </a>
    );

  return (
    <div data-look="light" className="wl-root relative isolate min-h-screen overflow-x-clip">
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      <SectionRail sections={SECTIONS} />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-pill focus:bg-ink focus:px-5 focus:py-3 focus:text-[14px] focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-50 border-b border-ink/8 bg-white/95 px-4 py-2 shadow-sm backdrop-blur sm:px-6">
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-2 sm:h-14 sm:gap-3">
          <Link
            href="/welcome"
            className="flex items-center gap-2 text-ink"
            aria-label="DoctorDesk home"
          >
            <DoctorDeskMark size={30} />
            <span className="whitespace-nowrap font-display text-[16.5px] font-extrabold tracking-display">
              DoctorDesk
            </span>
          </Link>
          <nav className="hidden items-center lg:flex" aria-label="Page sections">
            {NAV.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="wl-nav rounded-pill px-3.5 py-2 text-[14px] font-medium text-ink-60 transition-colors hover:bg-ink/5 hover:text-ink"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-1.5">
            {/*
              Straight to /login since 28 Oct 2026. This used to swallow the
              click and open the login page inside a dialog over the landing
              page, which put a full application screen — its own fonts,
              its own layout — inside a marketing panel, and it did not read
              as either one thing or the other.
            */}
            <Link
              href={staff.href}
              onClick={() => setMenuOpen(false)}
              className="wl-btn inline-flex h-10 items-center gap-2 whitespace-nowrap px-3 text-[14px] font-semibold text-ink-60 transition-colors hover:text-ink"
            >
              {!signedIn && (
                <span className="hidden text-ink-40 sm:inline-flex">
                  <IconLock size={14} />
                </span>
              )}
              <span className="sm:hidden">{signedIn ? staff.short : 'Sign in'}</span>
              <span className="hidden sm:inline">{signedIn ? staff.label : 'Clinic sign-in'}</span>
            </Link>
            {!signedIn &&
              (SITE.email ? (
                <button type="button" onClick={() => setDemoOpen(true)} className={HEADER_DEMO}>
                  Book a demo
                  <ArrowBubble size={12} small />
                </button>
              ) : (
                <a href="#contact" className={HEADER_DEMO}>
                  Book a demo
                  <ArrowBubble size={12} small />
                </a>
              ))}
            <button
              ref={menuButton}
              type="button"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-60 transition-colors hover:bg-ink/5 focus-visible:outline-clinical lg:hidden"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-controls="welcome-mobile-menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <IconX size={18} /> : <IconMenu size={18} />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="welcome-mobile-menu"
            className="mx-auto mt-2 max-w-5xl rounded-card border border-ink/10 bg-white/95 p-2 shadow-lg backdrop-blur-xl lg:hidden"
            aria-label="Page sections"
          >
            {NAV.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setMenuOpen(false)}
                className="flex items-center justify-between rounded-panel px-4 py-3 text-[15px] font-medium text-ink-60 hover:bg-ink/5 hover:text-ink"
              >
                {l.label}
                <span className="text-ink-20">
                  <IconArrowRight size={14} />
                </span>
              </a>
            ))}
            {!signedIn &&
              (SITE.email ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setDemoOpen(true);
                  }}
                  className="flex min-h-11 w-full items-center justify-between rounded-panel px-4 py-3 text-left text-[15px] font-semibold text-clinical-text hover:bg-clinical-tint"
                >
                  Book a demo
                  <IconArrowRight size={14} />
                </button>
              ) : (
                <a
                  href="#contact"
                  onClick={() => setMenuOpen(false)}
                  className="flex min-h-11 items-center justify-between rounded-panel px-4 py-3 text-[15px] font-semibold text-clinical-text hover:bg-clinical-tint"
                >
                  Book a demo
                  <IconArrowRight size={14} />
                </a>
              ))}
          </nav>
        )}
      </header>

      <main id="main" tabIndex={-1} className="outline-none">
        {/* ---- Hero ---- */}
        <section
          id="top"
          className="relative isolate bg-clinical-tint px-4 pb-14 pt-10 text-ink sm:px-6 sm:pb-20 sm:pt-14 lg:pb-24"
        >
          <div className="mx-auto max-w-6xl">
            <div className="grid items-start gap-8 md:grid-cols-[1fr_0.9fr] lg:grid-cols-[1.1fr_0.9fr] lg:gap-12">
              <div>
                <p className="wl-rise wl-label text-clinical-text">
                  OPD software for Indian clinics
                </p>
                <h1
                  className="wl-rise mt-5 max-w-[12ch] text-[clamp(38px,5.4vw,68px)] font-bold leading-[1.02] tracking-[-0.04em]"
                  style={{ animationDelay: '80ms' }}
                >
                  More time for patients.{' '}
                  <span className="wl-serif block text-clinical">Less to juggle.</span>
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
                  {signedIn ? (
                    <Link href={staff.href} className={HERO_CTA}>
                      Open your console
                      <ArrowBubble size={15} />
                    </Link>
                  ) : (
                    demoButton(HERO_CTA, 15)
                  )}
                  <a
                    href="#workflow"
                    className="wl-btn self-center text-[16px] font-bold text-clinical-text underline decoration-clinical/30 decoration-2 underline-offset-[6px] transition-colors hover:decoration-clinical sm:self-auto"
                  >
                    See how it works
                  </a>
                </div>
              </div>
              <div className="wl-rise" style={{ animationDelay: '200ms' }}>
                <QueueDemo />
              </div>
            </div>
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
            className="wl-rise relative mx-auto mt-12 max-w-6xl sm:mt-16"
            style={{ animationDelay: '420ms' }}
          >
            <span className="absolute -top-16 left-[3%] hidden items-end gap-1 text-coral-text lg:flex">
              <Handwritten className="text-[26px]" rotate={-4}>
                A clearer view of the day
              </Handwritten>
              <HandArrow className="-mb-8 h-12 w-16" />
            </span>
            <ConsolePreview />
          </div>
        </section>

        {/* ---- How it works ---- */}
        <section id="workflow" className="scroll-mt-24 bg-white px-4 py-16 sm:px-6 lg:py-24">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="How it works"
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
              <Workflow />
            </Reveal>
          </div>
        </section>

        {/* ---- Features ---- */}
        <section
          id="features"
          className="scroll-mt-24 bg-clinical-tint px-4 py-16 text-ink sm:px-6 lg:py-24"
        >
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="Features"
                title={<>Built for the fortieth patient of the day.</>}
                body="The first patient is easy. By the fortieth the queue is long, the doctor is running late and someone wants a receipt reprinted. Every screen here was drawn with that hour in mind."
              />
            </Reveal>
            <p className="mt-4 text-[13.5px] text-ink-60">
              Interface previews use fictional patient names, health details, tokens and amounts.
            </p>
            <Features />
          </div>
        </section>

        {/* ---- Roles ---- */}
        <section id="roles" className="scroll-mt-24 bg-white px-4 py-16 sm:px-6 lg:py-24">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="Roles"
                title={<>Five people share the desk PC. Each gets their own screen.</>}
                body="Front desk, doctor, nurse, owner and admin sign in at the same place and land on what their job needs. Each role has its own colour, so anyone walking past can see whose session is open."
              />
            </Reveal>
            <Roles night={false} />
          </div>
        </section>

        <WaitingRoom />

        {/* ---- Security ---- */}
        <section id="security" className="scroll-mt-24 bg-white px-4 py-16 sm:px-6 lg:py-24">
          <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[0.95fr_1.05fr]">
            <Reveal>
              <SectionHead
                align="left"
                eyebrow="Security"
                title={<>Your patients stay in your clinic.</>}
                body={
                  'Clinics on the same system can’t see each other’s records. The database itself enforces that, on every row.' +
                  (SITE.dataRegion ? ` Patient data is stored in ${SITE.dataRegion}.` : '')
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
                ].map((item) => (
                  <li key={item.title} className="flex gap-4">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-panel bg-clinical text-white shadow-sm">
                      {item.icon}
                    </span>
                    <div>
                      <h3 className="text-[16px] font-bold">{item.title}</h3>
                      <p className="mt-1 text-[14px] leading-relaxed text-ink-60">{item.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
              {(SITE.privacyUrl || SITE.dataUrl) && (
                <p className="mt-9 flex flex-wrap gap-x-5 gap-y-2 text-[14px] font-semibold">
                  {SITE.dataUrl && (
                    <a
                      className="text-clinical-text underline underline-offset-4"
                      href={SITE.dataUrl}
                    >
                      How we handle patient data
                    </a>
                  )}
                  {SITE.privacyUrl && (
                    <a
                      className="text-clinical-text underline underline-offset-4"
                      href={SITE.privacyUrl}
                    >
                      Privacy policy
                    </a>
                  )}
                </p>
              )}
            </Reveal>
            <Reveal delay={120}>
              <AuditTrail />
            </Reveal>
          </div>
        </section>

        <LogoMarquee />

        {/* ---- FAQ ---- */}
        <section id="faq" className="scroll-mt-24 bg-white px-4 py-16 sm:px-6 lg:py-24">
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
              <Faq />
            </Reveal>
          </div>
        </section>

        {(SITE.pilot.quote || SITE.founder.story) && (
          <section aria-label="Who is behind it" className="bg-white px-4 pb-16 sm:px-6 lg:pb-24">
            <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-2">
              {SITE.pilot.quote && SITE.pilot.name && (
                <Reveal>
                  <figure className="h-full rounded-[28px] border border-ink/10 bg-white/70 p-8 backdrop-blur-xl sm:p-10">
                    <p className="text-[14px] font-semibold text-ink-40">Used every day at</p>
                    <p className="mt-1 font-display text-[20px] font-extrabold tracking-[-0.02em]">
                      {SITE.pilot.clinic}
                      {SITE.pilot.city && <span className="text-ink-40">, {SITE.pilot.city}</span>}
                    </p>
                    <blockquote className="wl-serif mt-6 text-[clamp(22px,2.4vw,30px)] leading-snug text-ink">
                      “{SITE.pilot.quote}”
                    </blockquote>
                    <figcaption className="mt-6 text-[14.5px]">
                      <span className="font-semibold text-ink">{SITE.pilot.name}</span>
                      {SITE.pilot.role && <span className="text-ink-60"> · {SITE.pilot.role}</span>}
                    </figcaption>
                  </figure>
                </Reveal>
              )}
              {SITE.founder.name && SITE.founder.story && (
                <Reveal delay={80}>
                  <div className="h-full rounded-[28px] border border-ink/10 bg-white/70 p-8 backdrop-blur-xl sm:p-10">
                    <p className="text-[14px] font-semibold text-ink-40">Who is behind it</p>
                    <p className="mt-4 text-[16.5px] leading-relaxed text-ink-60">
                      {SITE.founder.story}
                    </p>
                    <p className="mt-6 text-[14.5px]">
                      <span className="font-semibold text-ink">{SITE.founder.name}</span>
                      {SITE.founder.role && (
                        <span className="text-ink-60"> · {SITE.founder.role}</span>
                      )}
                    </p>
                  </div>
                </Reveal>
              )}
            </div>
          </section>
        )}

        {/* ---- Contact ---- */}
        <section id="contact" className="scroll-mt-24 bg-clinical-tint px-4 py-14 sm:px-6 lg:py-20">
          <div className="mx-auto grid max-w-6xl items-center gap-7 rounded-card-lg border border-ink/8 bg-white p-6 shadow-sm sm:p-9 lg:grid-cols-[1fr_auto] lg:p-12">
            <div>
              <p className="eyebrow">A better clinic day starts here</p>
              <h2 className="mt-3 max-w-2xl text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-display">
                See how DoctorDesk can fit your clinic.
              </h2>
              <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-60 sm:text-[16px]">
                {SITE.email || SITE.phone
                  ? 'Explore the workflow, or get in touch using the contact details below.'
                  : 'Explore the workflow or get demo information.'}
              </p>
              {(SITE.email || SITE.phone) && (
                <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[14px] font-semibold">
                  {SITE.email && (
                    <a
                      className="text-clinical-text underline underline-offset-4"
                      href={`mailto:${SITE.email}`}
                    >
                      {SITE.email}
                    </a>
                  )}
                  {SITE.phone && (
                    <a
                      className="text-clinical-text underline underline-offset-4"
                      href={`tel:${SITE.phone.replace(/[^\d+]/g, '')}`}
                    >
                      {SITE.phone}
                    </a>
                  )}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
              {!signedIn &&
                (SITE.email ? (
                  <button
                    type="button"
                    onClick={() => setDemoOpen(true)}
                    className="btn-primary min-h-11 whitespace-nowrap"
                  >
                    Book a demo
                    <IconArrowRight size={15} />
                  </button>
                ) : (
                  <a href="#faq" className="btn-primary min-h-11 whitespace-nowrap">
                    Book a demo
                    <IconArrowRight size={15} />
                  </a>
                ))}
              <a href="#workflow" className="btn-secondary min-h-11 whitespace-nowrap">
                See how it works
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-clinical-tint px-4 text-ink sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-10 py-14 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <span className="flex items-center gap-2">
              <DoctorDeskMark size={28} />
              <span className="font-display text-[16px] font-extrabold tracking-display">
                DoctorDesk
              </span>
            </span>
            <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-ink-40">
              Made for outpatient clinics in India.
            </p>
            {(SITE.companyName || SITE.address || SITE.email || SITE.phone) && (
              <address className="mt-4 space-y-1 text-[13.5px] not-italic leading-relaxed text-ink-60">
                {SITE.companyName && (
                  <span className="block font-semibold text-ink">{SITE.companyName}</span>
                )}
                {SITE.address && <span className="block">{SITE.address}</span>}
                {SITE.phone && (
                  <a
                    className="block select-all hover:text-clinical-text"
                    href={`tel:${SITE.phone.replace(/[^\d+]/g, '')}`}
                  >
                    {SITE.phone}
                  </a>
                )}
                {SITE.email && (
                  <a
                    className="block select-all hover:text-clinical-text"
                    href={`mailto:${SITE.email}`}
                  >
                    {SITE.email}
                  </a>
                )}
              </address>
            )}
          </div>
          <FooterLinks title="Product" links={NAV.slice(0, 4)} />
          <FooterLinks
            title="Staff"
            links={[
              { href: staff.href, label: staff.label },
              { href: '/login', label: 'Help signing in' },
            ]}
          />
        </div>
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 border-t border-ink/8 py-6 sm:flex-row">
          <p className="text-[12.5px] text-ink-40">
            © {new Date().getFullYear()} {SITE.companyName || 'DoctorDesk'}
          </p>
          <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-ink-40">
            {SITE.privacyUrl && (
              <a className="hover:text-ink" href={SITE.privacyUrl}>
                Privacy
              </a>
            )}
            {SITE.termsUrl && (
              <a className="hover:text-ink" href={SITE.termsUrl}>
                Terms
              </a>
            )}
            {SITE.statusUrl && (
              <a className="flex items-center gap-2 hover:text-ink" href={SITE.statusUrl}>
                <span className="h-1.5 w-1.5 rounded-full bg-green" />
                System status
              </a>
            )}
          </p>
        </div>
      </footer>

      {demoOpen && SITE.email && <DemoDialog onClose={closeDemo} />}
    </div>
  );
}

function ArrowBubble({ size, small = false }: { size: number; small?: boolean }) {
  return (
    <span
      className={`grid ${small ? 'h-6 w-6' : 'h-7 w-7'} place-items-center rounded-full bg-white/15 transition-transform group-hover:translate-x-0.5`}
    >
      <IconArrowRight size={size} />
    </span>
  );
}

/* ---- Section rail --------------------------------------------------------- */

/** The "01 / 07" ticks down the right edge; the current section is the one past mid-screen. */
function SectionRail({ sections }: { sections: Array<{ id: string; label: string }> }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight / 2;
      let current = sections[0]?.id ?? '';
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) current = s.id;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [sections]);

  const index = sections.findIndex((s) => s.id === active);

  return (
    <nav
      aria-label="Sections"
      className="fixed right-5 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-end gap-1 lg:flex"
    >
      <span className="mb-2 font-mono text-[10.5px] font-semibold tracking-label text-ink-40">
        {String(index + 1).padStart(2, '0')}
        <span className="text-ink-20"> / {String(sections.length).padStart(2, '0')}</span>
      </span>
      {sections.map((s) => {
        const on = s.id === active;
        return (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-label={s.label}
            aria-current={on ? 'true' : undefined}
            className="group flex h-5 items-center gap-3"
          >
            <span className="whitespace-nowrap rounded-pill bg-ink px-2 py-0.5 text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              {s.label}
            </span>
            <span
              className={`h-[2px] rounded-full transition-all duration-300 ${
                on ? 'w-7 bg-clinical' : 'w-3.5 bg-ink/25 group-hover:w-5 group-hover:bg-ink/50'
              }`}
            />
          </a>
        );
      })}
    </nav>
  );
}

/* ---- Dialogs -------------------------------------------------------------- */

/** A modal sheet: traps Tab, closes on Escape or backdrop, and hands focus back. */
function Dialog({
  label,
  onClose,
  className = '',
  keepAppFonts = false,
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  keepAppFonts?: boolean;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

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
      if (e.key !== 'Tab' || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
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
        className="wl-fade absolute inset-0 bg-ink/45 backdrop-blur-md"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`wl-pop relative max-h-[94dvh] w-full overflow-y-auto rounded-t-[28px] bg-bg-soft shadow-[0_40px_120px_-20px_rgba(0,0,0,0.55)] sm:rounded-[28px] ${className}`}
      >
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

function DemoDialog({ onClose }: { onClose: () => void }) {
  const [sent, setSent] = useState(false);
  const field =
    'h-11 w-full rounded-[12px] border border-ink/12 bg-white px-3.5 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-20 focus:border-clinical focus:ring-4 focus:ring-clinical/12';

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const get = (k: string) => String(data.get(k) ?? '').trim();
    const body = [
      `Name: ${get('demo-name')}`,
      `Clinic: ${get('demo-clinic')}`,
      `City: ${get('demo-city') || '-'}`,
      `Phone: ${get('demo-phone')}`,
    ].join('\n');
    const subject = `Demo request: ${get('demo-clinic')}`;
    window.location.href = `mailto:${SITE.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    setSent(true);
  }

  return (
    <Dialog label="Book a demo" onClose={onClose} className="max-w-[520px]">
      <div className="px-6 pb-8 pt-9 sm:px-9">
        {sent ? (
          <div className="pr-8">
            <h2 className="text-[26px] font-extrabold leading-tight tracking-[-0.03em]">
              Your email should be ready to send.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-60">
              We opened your email app with the request written out. If nothing opened, send the
              same details to{' '}
              <span className="select-all font-semibold text-ink">{SITE.email}</span>.
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
                Twenty minutes, at a time that suits your OPD. We’ll call you to fix it.
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
                className={field}
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
                className={field}
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
                  className={field}
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
                  className={field}
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
    </Dialog>
  );
}

/* ---- Shared section pieces ------------------------------------------------ */

/** Fades and lifts its children in the first time they scroll into view. */
function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: React.ReactNode;
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

function SectionHead({
  eyebrow,
  title,
  body,
  align = 'wide',
}: {
  eyebrow: string;
  title: React.ReactNode;
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

/* ---- Hero: interactive queue ---------------------------------------------- */

const DEMO_QUEUE = [
  { token: 'A-07', name: 'Meena Raghavan', note: 'In consultation' },
  { token: 'A-12', name: 'Imran Shaikh', note: 'Back from X-ray' },
  { token: 'A-08', name: 'Suresh Pillai', note: 'Waiting · 6 min' },
  { token: 'A-09', name: 'Kavya Nair', note: 'Booked by phone' },
];

function QueueDemo() {
  const [called, setCalled] = useState(0);
  const rest = DEMO_QUEUE.slice(called);
  const now = rest[0];
  const minutes = 40 + called * 7;
  const clock = `${10 + Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} a.m.`;
  const collected = (14650 + called * 500).toLocaleString('en-IN');

  return (
    <figure className="relative mx-auto max-w-[540px]">
      <div className="rounded-card border border-ink/10 bg-white p-5 shadow-sm sm:p-6">
        <span className="badge-amber">Interactive demo · Sample data</span>
        <p className="mono-label mt-4">OPD queue · Dr. A. Kulkarni</p>
        <p className="mt-1.5 text-[19px] font-extrabold tracking-[-0.02em] text-ink">
          Tuesday, {clock}
        </p>
        <ol className="mt-5 grid gap-2.5" aria-label="Today's queue">
          {rest.map((p, i) => (
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
            onClick={() => setCalled((n) => (now ? n + 1 : 0))}
            className="inline-flex h-11 items-center gap-2 rounded-pill bg-clinical px-5 text-[14.5px] font-bold text-white transition-colors hover:bg-clinical-deep active:translate-y-px"
          >
            <IconBell size={15} />
            {now ? 'Call next' : 'Start over'}
          </button>
        </div>
        <p className="sr-only" aria-live="polite">
          {now ? `Now serving ${now.token}, ${now.name}.` : 'Queue clear.'}
        </p>
      </div>
      <figcaption className="mt-5 text-center text-[13.5px] text-ink-40">
        Try “Call next” — it changes only this preview. Names and amounts are illustrative.
      </figcaption>
    </figure>
  );
}

/* ---- Hero: console screenshot --------------------------------------------- */

const PREVIEW_ROWS = [
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

const BADGE: Record<string, string> = {
  clinical: 'badge-clinical',
  amber: 'badge-amber',
  coral: 'badge-coral',
  green: 'badge-green',
  neutral: 'badge-neutral',
};

/** A static picture of the console, tipped back in 3D and flattening as the page scrolls. */
function ConsolePreview() {
  const tilt = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tilt.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const wide = window.matchMedia('(min-width: 1024px)');
    const update = () => {
      if (reduced.matches || !wide.matches) {
        el.style.transform = '';
        return;
      }
      const deg = Math.max(0, 16 - window.scrollY / 22);
      el.style.transform = `rotateX(${deg.toFixed(2)}deg) scale(${(1 - deg / 320).toFixed(4)})`;
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div className="relative [perspective:2200px]">
      <div
        aria-hidden="true"
        className="absolute inset-x-[8%] -bottom-10 top-[20%] -z-10 rounded-[40px] bg-clinical/25 blur-3xl"
      />
      <div
        ref={tilt}
        className="origin-top transition-transform duration-200 ease-out will-change-transform"
      >
        <div className="overflow-hidden rounded-[20px] border border-ink/10 bg-white shadow-[0_50px_100px_-30px_rgba(11,79,73,0.35),0_18px_40px_-18px_rgba(60,50,35,0.25)] sm:rounded-[24px]">
          <div className="flex items-center gap-3 border-b border-ink/8 bg-bg-soft px-4 py-2.5">
            <span className="flex gap-1.5" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-coral/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-green/70" />
            </span>
            <span className="mx-auto flex max-w-xs flex-1 items-center justify-center gap-1.5 truncate rounded-pill border border-ink/8 bg-white px-3 py-1 font-mono text-[10.5px] text-ink-40">
              <IconLock size={10} />
              Sunrise Clinic · sample data
            </span>
            <span className="w-10" />
          </div>
          <div className="grid md:grid-cols-[190px_1fr] xl:grid-cols-[190px_1fr_250px]">
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
                  { icon: <IconFlask size={15} />, label: 'Diagnostics' },
                  { icon: <IconReceipt size={15} />, label: 'Finance' },
                ].map((n) => (
                  <li
                    key={n.label}
                    className={`flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 ${
                      n.active ? 'bg-[#e2e6f6] font-semibold text-[#2b3a75]' : 'text-ink-60'
                    }`}
                  >
                    {n.icon}
                    <span className="flex-1">{n.label}</span>
                    {n.count && (
                      <span className="rounded-pill bg-[#3a4e9b] px-1.5 font-mono text-[10px] text-white">
                        {n.count}
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
                    Today’s queue
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
                {PREVIEW_ROWS.map((r) => (
                  <div
                    key={r.token}
                    className={`grid grid-cols-[44px_1fr_auto] items-center gap-3 border-b border-ink/6 px-3 py-2.5 last:border-b-0 sm:grid-cols-[44px_1.4fr_1fr_1fr_70px] ${
                      r.tone === 'clinical' ? 'bg-clinical-tint/70' : ''
                    } ${r.tone === 'green' ? 'opacity-60' : ''}`}
                  >
                    <span className="font-mono text-[13px] font-semibold text-ink">{r.token}</span>
                    <span className="min-w-0">
                      <span
                        className={`block truncate text-[13px] font-semibold ${
                          r.tone === 'neutral' ? 'text-ink-40 line-through decoration-ink-20' : ''
                        }`}
                      >
                        {r.name}
                      </span>
                      <span className="block font-mono text-[10.5px] text-ink-40">{r.meta}</span>
                    </span>
                    <span className="hidden text-[12.5px] text-ink-60 sm:block">{r.doctor}</span>
                    <span>
                      <span className={BADGE[r.tone]}>{r.status}</span>
                    </span>
                    <span className="hidden text-right font-mono text-[11.5px] text-ink-40 sm:block">
                      {r.wait}
                    </span>
                  </div>
                ))}
              </div>
            </div>

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
                ].map((u) => (
                  <div
                    key={u.t}
                    className="flex items-center gap-2.5 rounded-[10px] border border-ink/8 bg-white px-2.5 py-2"
                  >
                    <span className="grid h-6 w-7 place-items-center rounded-[6px] bg-clinical-soft font-mono text-[11px] font-bold text-clinical-text">
                      {u.t}
                    </span>
                    <span className="text-[12.5px] font-medium">{u.n}</span>
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

/* ---- How it works --------------------------------------------------------- */

function SampleField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mono-label">{label}</p>
      <p className="mt-1.5 flex h-11 items-center rounded-[12px] border border-ink/10 bg-bg-soft px-3.5 text-[15px] text-ink">
        {value}
      </p>
    </div>
  );
}

function SampleCard({ title, children }: { title: string; children: React.ReactNode }) {
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

function TokenBanner({
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

const STOPS = [
  {
    stop: 'Front desk',
    time: '9:05',
    icon: <IconUserPlus size={16} />,
    eyebrow: 'Reception',
    title: 'Registered before they sit down.',
    points: [
      'Name, mobile number and age are enough to register.',
      'A UHID and a token for the chosen doctor are issued together.',
      'Phone bookings arrive with their token already assigned.',
    ],
    card: (
      <SampleCard title="Register patient">
        <div className="grid gap-4 sm:grid-cols-2">
          <SampleField label="Name" value="Kavya Nair" />
          <SampleField label="Mobile" value="98••• ••210" />
          <SampleField label="Age" value="34" />
          <SampleField label="Doctor" value="Dr. A. Kulkarni" />
        </div>
        <TokenBanner
          token="A-09"
          title="Token issued"
          sub="UHID CL-10482"
          aside="3rd in Dr. Kulkarni’s queue"
        />
      </SampleCard>
    ),
  },
  {
    stop: 'Queue',
    time: '9:12',
    icon: <IconClock size={16} />,
    eyebrow: 'Queue management',
    title: 'Everyone knows who is next.',
    points: [
      'Reception can see the line for each doctor.',
      'Call the next token without changing a patient record.',
      'The sample controls on this page only change this preview.',
    ],
    card: <QueueDemo />,
  },
  {
    stop: 'Doctor',
    time: '9:20',
    icon: <IconCalendar size={16} />,
    eyebrow: 'Consultation',
    title: 'One screen for the whole consult.',
    points: [
      'Vitals, complaints and past visits sit on the same panel.',
      'Medicines go in as structured rows, not a paragraph of free text.',
      'An X-ray or lab test is ordered here, and read here when it is back.',
    ],
    card: (
      <SampleCard title="Consultation · Kavya Nair, 34 F">
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
          ].map(([k, v]) => (
            <li key={k} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <span className="text-[14.5px] font-semibold text-ink">{k}</span>
              <span className="font-mono text-[12.5px] text-ink-60">{v}</span>
            </li>
          ))}
        </ul>
        <TokenBanner
          token="A-09"
          title="X-ray chest PA ordered"
          sub="Sent to the X-ray room"
          aside="Back in ~20 min"
        />
      </SampleCard>
    ),
  },
  {
    stop: 'Checkout',
    time: '10:10',
    icon: <IconReceipt size={16} />,
    eyebrow: 'Billing',
    title: 'Paid, printed and on their way.',
    points: [
      'The consultation and the test are already on the bill.',
      'Cash, UPI or card, or part of each.',
      'Receipt and prescription print with your clinic’s name.',
    ],
    card: (
      <SampleCard title="Bill · Kavya Nair">
        <ul className="divide-y divide-ink/8">
          {[
            ['Consultation · Dr. A. Kulkarni', '₹500'],
            ['X-ray chest PA', '₹400'],
          ].map(([k, v]) => (
            <li key={k} className="flex items-center justify-between gap-3 py-2.5 text-[14.5px]">
              <span className="text-ink-60">{k}</span>
              <span className="font-mono font-semibold text-ink">{v}</span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 py-3 text-[16px] font-bold text-ink">
            Total<span className="font-mono">₹900</span>
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
        <TokenBanner token="A-09" title="Payment recorded" sub="Receipt R-1043 · ₹900" />
      </SampleCard>
    ),
  },
];

function Workflow() {
  const [step, setStep] = useState(0);
  const current = STOPS[step]!;
  const next = STOPS[step + 1];

  return (
    <div className="mt-14">
      <ol className="relative grid grid-cols-4" aria-label="Steps in a clinic visit">
        <span
          aria-hidden="true"
          className="absolute left-[12.5%] right-[12.5%] top-[54px] border-t-2 border-dashed border-ink/15"
        />
        {STOPS.map((s, i) => {
          const on = i === step;
          return (
            <li key={s.stop} className="relative flex justify-center">
              <button
                type="button"
                onClick={() => setStep(i)}
                aria-current={on ? 'step' : undefined}
                aria-label={`${s.stop}, step ${i + 1} of ${STOPS.length}`}
                aria-controls="workflow-preview"
                className="group flex min-w-0 flex-col items-center rounded-card px-0 pb-2 text-center sm:px-2"
              >
                <span
                  className={`mb-2 h-7 rounded-[8px] px-2.5 font-mono text-[13px] font-bold leading-7 text-white transition-opacity ${
                    on ? 'bg-clinical opacity-100' : 'opacity-0'
                  }`}
                  aria-hidden={!on}
                >
                  A-09
                </span>
                <span
                  className={`relative grid h-9 w-9 place-items-center rounded-full transition-colors ${
                    on
                      ? 'bg-clinical text-white ring-4 ring-clinical/20'
                      : i < step
                        ? 'bg-clinical-tint text-clinical-text'
                        : 'border-2 border-ink/15 bg-bg-soft text-ink-60 group-hover:border-clinical/30'
                  }`}
                >
                  {i < step ? <IconCheck size={15} /> : s.icon}
                </span>
                <span
                  className={`mt-3 max-w-full text-[12px] font-bold leading-tight sm:text-[16px] ${
                    on ? 'text-clinical-text' : 'text-ink'
                  }`}
                >
                  {s.stop}
                </span>
                <span className="mt-1 text-[9px] leading-tight text-ink-40 sm:text-[12px]">
                  Step {i + 1} · {s.time}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div
        key={step}
        id="workflow-preview"
        role="region"
        aria-label={`${current.stop} preview`}
        aria-live="polite"
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
        <p className="sr-only" aria-live="polite">
          Step {step + 1} of {STOPS.length}: {current.stop}
        </p>
        <button
          type="button"
          onClick={() => setStep(next ? step + 1 : 0)}
          className="wl-btn group inline-flex h-11 items-center gap-2 rounded-pill bg-clinical px-5 text-[14.5px] font-bold text-white transition-colors hover:bg-clinical-deep"
        >
          {next ? `Next: ${next.stop}` : 'Start again'}
          <span className="transition-transform group-hover:translate-x-0.5">
            <IconArrowRight size={14} />
          </span>
        </button>
      </div>
    </div>
  );
}

/* ---- Features ------------------------------------------------------------- */

function Features() {
  return (
    <div className="mt-14 grid gap-4 lg:grid-cols-3">
      <Reveal className="lg:col-span-2">
        <FeatureCard
          icon={<IconUserPlus size={18} />}
          title="Registration that catches duplicates"
          body="One keyboard-first screen. The duplicate check runs while you type, and the UHID is issued the moment you save."
        >
          <TypingRegistration />
        </FeatureCard>
      </Reveal>

      <Reveal className="lg:row-span-2" delay={80}>
        <FeatureCard
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
                  className={`flex items-center gap-3 rounded-[10px] px-2.5 py-2 ${r.active ? 'bg-clinical-tint' : ''}`}
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
                      <IconArrowRight size={14} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {['Name', 'Mobile', 'UHID', 'ABHA'].map((t) => (
              <span key={t} className="badge-neutral">
                {t}
              </span>
            ))}
          </div>
        </FeatureCard>
      </Reveal>

      <Reveal>
        <FeatureCard
          icon={<IconRx size={18} />}
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
        </FeatureCard>
      </Reveal>

      <Reveal delay={80}>
        <FeatureCard
          icon={<IconFlask size={18} />}
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
        </FeatureCard>
      </Reveal>

      <Reveal>
        <FeatureCard
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
        </FeatureCard>
      </Reveal>

      <Reveal delay={80}>
        <FeatureCard
          icon={<IconTag size={18} />}
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
        </FeatureCard>
      </Reveal>

      <Reveal delay={160}>
        <FeatureCard
          icon={<IconKeyboard size={18} />}
          title="Keyboard-first, everywhere"
          body="Built for the rush hour: every screen works without reaching for the mouse."
        >
          <div className="mt-6 flex flex-wrap items-center gap-2">
            {['Ctrl', 'K'].map((k, i) => (
              <span key={k} className="flex items-center gap-2">
                {i > 0 && <span className="text-ink-20">+</span>}
                <Key>{k}</Key>
              </span>
            ))}
            <span className="ml-1 text-[12.5px] text-ink-40">search anywhere</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Key>Tab</Key>
            <span className="text-ink-20">→</span>
            <Key>Enter</Key>
            <span className="ml-1 text-[12.5px] text-ink-40">register &amp; save</span>
          </div>
        </FeatureCard>
      </Reveal>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  body,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-card-lg border border-ink/8 bg-white/65 p-6 shadow-sm backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-clinical/25 hover:shadow sm:p-7">
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

const TYPED_NAME = 'Priya Shar';
const TYPED_MOBILE = '98••• ••410';

/**
 * Types a name and number, letter by letter, while the card is on screen, and
 * shows the duplicate warning once enough of the name is in. Rests on the
 * finished state when off screen or when motion is reduced.
 */
function TypingRegistration() {
  const ref = useRef<HTMLDivElement>(null);
  const [nameLen, setNameLen] = useState(TYPED_NAME.length);
  const [mobileLen, setMobileLen] = useState(TYPED_MOBILE.length);

  useEffect(() => {
    const el = ref.current;
    if (
      !el ||
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;

    let timers: number[] = [];
    let running = false;
    const clear = () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers = [];
    };
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const play = () => {
      clear();
      setNameLen(0);
      setMobileLen(0);
      let t = 500;
      for (let i = 1; i <= TYPED_NAME.length; i++) {
        t += 85 + Math.random() * 120 + (/[ A-Z]/.test(TYPED_NAME[i - 1] ?? '') ? 90 : 0);
        at(t, () => setNameLen(i));
      }
      t += 450;
      for (let i = 1; i <= TYPED_MOBILE.length; i++) {
        t += 60 + Math.random() * 70;
        at(t, () => setMobileLen(i));
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
          clear();
          setNameLen(TYPED_NAME.length);
          setMobileLen(TYPED_MOBILE.length);
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clear();
    };
  }, []);

  const typingName = nameLen < TYPED_NAME.length;
  const matched = nameLen >= 7;
  const caret = (
    <span className="wl-caret ml-px inline-block h-4 w-px translate-y-0.5 bg-clinical" />
  );

  return (
    <div
      ref={ref}
      className="mt-6 grid gap-3 rounded-[16px] border border-ink/8 bg-bg-soft p-4 sm:grid-cols-2"
    >
      <TypedField label="Full name">
        {TYPED_NAME.slice(0, nameLen)}
        {(typingName || mobileLen === TYPED_MOBILE.length) && caret}
      </TypedField>
      <TypedField label="Mobile">
        {TYPED_MOBILE.slice(0, mobileLen)}
        {!typingName && mobileLen < TYPED_MOBILE.length && caret}
      </TypedField>
      <div
        className={`flex flex-col gap-3 rounded-[12px] border border-amber/40 bg-amber-soft/60 px-3.5 py-3 transition-all duration-500 ease-out sm:col-span-2 sm:flex-row sm:items-center sm:justify-between ${
          matched ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
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

function TypedField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mono-label !text-[9.5px]">{label}</p>
      <div className="mt-1 flex h-10 items-center rounded-[10px] border border-ink/10 bg-white px-3 text-[13.5px] font-medium">
        {children}
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[34px] items-center justify-center rounded-[8px] border border-b-[3px] border-ink/15 bg-white px-2 py-1 font-mono text-[12px] font-semibold text-ink shadow-sm">
      {children}
    </kbd>
  );
}

/* ---- Roles ---------------------------------------------------------------- */

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
];

type RoleTone = { color: string; soft: string; text: string; blank: string; on: string };

/** Status chip colours, per look. `on` is white only in the day look. */
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
type ChipTone = keyof typeof CHIP.day;
const chipsFor = (tone: RoleTone) => CHIP[tone.on !== '#FFFFFF' ? 'night' : 'day'];

/**
 * Tabs for the five roles, each with a mock of that role's own screen.
 * Cycles on its own while in view, and stops for hover, focus or reduced motion.
 */
function Roles({ night }: { night: boolean }) {
  const [index, setIndex] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const role = ROLES[index] ?? ROLES[0]!;
  const box = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), {
      threshold: 0.35,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const autoplay = visible && !hovered && !focused && !reduced;
  useEffect(() => {
    if (!autoplay) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % ROLES.length), 3500);
    return () => clearTimeout(t);
  }, [index, autoplay]);

  const tone: RoleTone = night
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

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + ROLES.length) % ROLES.length;
    setIndex(next);
    tabs.current[next]?.focus();
  }

  return (
    <Reveal className="mt-14">
      <div
        ref={box}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
        }}
      >
        <div
          role="tablist"
          aria-label="Roles"
          onKeyDown={onKeyDown}
          className="mx-auto flex w-full max-w-3xl flex-wrap justify-center gap-1 rounded-[22px] border border-ink/10 bg-white p-1.5 shadow-sm sm:flex-nowrap sm:rounded-pill"
        >
          {ROLES.map((r, i) => {
            const on = i === index;
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
                onClick={() => setIndex(i)}
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
          key={role.key}
          id="role-panel"
          role="tabpanel"
          aria-labelledby={`role-tab-${role.key}`}
          className="wl-rise mt-8 grid items-stretch gap-6 lg:grid-cols-2"
          style={{ animationDuration: '.5s' }}
        >
          <div className="flex flex-col justify-center rounded-card-lg border border-ink/8 bg-white/65 p-7 shadow-sm backdrop-blur-xl sm:p-9">
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

function ScreenHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p className="text-[13.5px] font-bold">{title}</p>
      <p className="font-mono text-[10px] uppercase tracking-label text-ink-40">{meta}</p>
    </div>
  );
}

function Chip({
  children,
  tone,
  role,
}: {
  children: React.ReactNode;
  tone: ChipTone;
  role: RoleTone;
}) {
  const [bg, fg] = chipsFor(role)[tone];
  return (
    <span
      className="shrink-0 rounded-pill px-2 py-0.5 font-mono text-[9.5px] font-medium uppercase tracking-label"
      style={{ backgroundColor: bg, color: fg }}
    >
      {children}
    </span>
  );
}

function Action({
  children,
  tone,
  solid = false,
}: {
  children: React.ReactNode;
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

function FrontDeskScreen({ tone }: { tone: RoleTone }) {
  const rows: Array<{
    t: number;
    n: string;
    chip: [ChipTone, string];
    act?: string;
    solid?: boolean;
  }> = [
    { t: 14, n: 'Geeta Sharma', chip: ['green', 'On the way'], act: 'Check in', solid: true },
    { t: 15, n: 'Ramesh Kumar', chip: ['neutral', 'Waiting · paid'], act: 'Call' },
    { t: 16, n: 'Sunita Patil', chip: ['neutral', 'At home · told to leave'] },
    { t: 17, n: 'Arjun Shah', chip: ['amber', 'Unpaid ₹350'], act: 'Collect' },
  ];
  const [okBg, okFg] = chipsFor(tone).green;
  return (
    <div className="p-4">
      <ScreenHead title="Today’s queue" meta="7 waiting · 4 at home" />
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
            {r.act && (
              <Action tone={tone} solid={r.solid ?? false}>
                {r.act}
              </Action>
            )}
          </li>
        ))}
      </ul>
      <p
        className="mt-3 flex items-center gap-2 rounded-panel px-3 py-2 text-[11.5px]"
        style={{ backgroundColor: okBg, color: okFg }}
      >
        <span aria-hidden="true">●</span>
        Token 18 sent to Meera on WhatsApp, with her live place in line
      </p>
    </div>
  );
}

function DoctorScreen({ tone }: { tone: RoleTone }) {
  const pain = [7, 6, 6, 4, 4, 3];
  const x = (i: number) => 6 + (i / (pain.length - 1)) * 128;
  const y = (v: number) => 6 + (1 - v / 10) * 48;
  const line = pain.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  return (
    <div className="p-4">
      <ScreenHead title="Ramesh Kumar · 64 M" meta="Token 20 · visit 3" />
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
          <Action tone={tone} solid>
            Sign &amp; send
          </Action>
        </div>
      </div>
    </div>
  );
}

function NurseScreen({ tone }: { tone: RoleTone }) {
  return (
    <div className="p-4">
      <ScreenHead title="Vitals · Ramesh Kumar" meta="Before Dr. Rao" />
      <div className="mt-3 grid grid-cols-4 gap-2">
        {[
          ['BP', '138/86'],
          ['Pulse', '82'],
          ['SpO₂', '97%'],
          ['Weight', '71 kg'],
        ].map(([k, v]) => (
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
        <Action tone={tone} solid>
          Save vitals
        </Action>
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
          style={{ borderColor: chipsFor(tone).coral[0] }}
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

function OwnerScreen({ tone }: { tone: RoleTone }) {
  const week = [12.1, 15.4, 14.2, 17.8, 16.3, 21, 18.4];
  const max = Math.max(...week);
  return (
    <div className="p-4">
      <ScreenHead title="This week" meta="Read-only" />
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
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
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

function AdminScreen({ tone }: { tone: RoleTone }) {
  const night = tone.on !== '#FFFFFF';
  return (
    <div className="p-4">
      <ScreenHead title="Clinic settings" meta="14 staff · 2 screens" />
      <ul className="mt-3 space-y-1.5">
        {[
          ['Asha Pawar', 'Front desk', '#3a4e9b'],
          ['Dr. Kiran Rao', 'Doctor', '#6b3fa0'],
          ['Anita Joseph', 'Nurse', '#a83a6e'],
        ].map(([name, role, color]) => (
          <li
            key={name}
            className="flex items-center gap-2.5 rounded-panel border border-ink/8 px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{name}</span>
            <span
              className="rounded-pill px-2 py-0.5 text-[10.5px] font-semibold text-white"
              style={{ backgroundColor: color }}
            >
              {role}
            </span>
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-2 rounded-panel bg-bg-soft p-3">
        {(
          [
            ['Two-factor for admins', true],
            ['WhatsApp consent at registration', true],
            ['Patient names on the TV', false],
          ] as const
        ).map(([label, on]) => (
          <li key={label} className="flex items-center justify-between gap-3 text-[11.5px]">
            {label}
            <span
              aria-hidden="true"
              className="relative h-4 w-7 shrink-0 rounded-full transition-colors"
              style={{
                backgroundColor: on
                  ? tone.color
                  : night
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

/* ---- Waiting room --------------------------------------------------------- */

function WaitingRoom() {
  return (
    <section
      id="display"
      className="relative scroll-mt-24 bg-clinical-tint px-4 py-16 text-ink sm:px-6 lg:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal className="grid items-end gap-6 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="flex items-baseline gap-3">
              <span className="wl-label text-clinical-text">Waiting room</span>
              <span aria-hidden="true" className="h-px flex-1 self-center bg-ink/12" />
            </p>
            <h2 className="mt-5 text-[clamp(30px,4.6vw,52px)] font-extrabold leading-[1.04] tracking-[-0.03em] text-ink">
              The token screen in the{' '}
              <span className="wl-serif font-normal text-clinical-text">waiting room.</span>
            </h2>
          </div>
          <p className="max-w-md text-[16px] leading-relaxed text-ink-60">
            Pair any TV with a key from settings. It shows who each doctor is seeing and who’s next,
            and updates on its own.
          </p>
        </Reveal>

        <div className="mt-10 grid gap-4 lg:grid-cols-[1.6fr_1fr] lg:grid-rows-3">
          <Reveal
            delay={120}
            className="flex flex-col justify-center rounded-card-lg border border-ink/8 bg-gradient-to-br from-clinical-tint to-white to-65% p-4 sm:p-8 lg:row-span-3"
          >
            <div className="relative rounded-[26px] border border-black/40 bg-gradient-to-b from-[#24272c] to-[#0b0c0e] p-2.5 shadow-[0_50px_90px_-45px_rgba(22,24,28,0.55),0_0_0_1px_rgba(255,255,255,0.04)_inset] sm:p-3.5">
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
                      <span className="eyebrow">Sample display · now serving</span>
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
              <IconArrowRight size={12} />
              <span className="rounded-[8px] bg-clinical-soft px-2.5 py-0.5 font-mono text-[19px] font-bold text-clinical">
                20
              </span>
            </div>
            <h3 className="mt-3 font-display text-[17px] font-bold tracking-[-0.015em]">
              Tokens only
            </h3>
            <p className="mt-1 text-[13.5px] leading-snug text-ink-60">
              Patients’ names never go on the wall.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---- Security: audit trail ------------------------------------------------ */

function AuditTrail() {
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="absolute -inset-4 -z-10 rounded-[36px] bg-gradient-to-br from-clinical-soft/70 via-transparent to-amber-soft/60 blur-xl"
      />
      <div className="overflow-hidden rounded-card-lg border border-ink/10 bg-white/75 shadow-lg backdrop-blur-xl">
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
          {[
            {
              t: '09:31:08',
              who: 'Dr. K. Rao',
              what: 'prescription.create',
              ref: 'UH-24-0871',
              c: '#6b3fa0',
            },
            { t: '09:33:41', who: 'P. Singh', what: 'payment.record', ref: 'R-1042', c: '#3a4e9b' },
            { t: '09:34:02', who: 'P. Singh', what: 'receipt.print', ref: 'R-1042', c: '#3a4e9b' },
            {
              t: '09:40:15',
              who: 'A. Joseph',
              what: 'vitals.update',
              ref: 'UH-24-0873',
              c: '#a83a6e',
            },
            {
              t: '10:02:57',
              who: 'R. Kapoor',
              what: 'user.role.update',
              ref: 'staff/14',
              c: '#4c5563',
            },
            {
              t: '10:05:12',
              who: 'S. Menon',
              what: 'price.update',
              ref: 'consult/gp',
              c: '#7a5230',
            },
          ].map((row, i) => (
            <li
              key={row.t}
              className={`grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[76px_120px_1fr_auto] ${
                i === 0 ? 'bg-clinical-tint/60' : ''
              }`}
            >
              <span className="font-mono text-[11.5px] text-ink-40">{row.t}</span>
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.c }} />
                {row.who}
              </span>
              <span className="col-span-2 font-mono text-[12px] text-clinical-text sm:col-span-1">
                {row.what}
              </span>
              <span className="col-span-2 font-mono text-[11.5px] text-ink-40 sm:col-span-1 sm:text-right">
                {row.ref}
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

/* ---- Logo marquee --------------------------------------------------------- */

const SAMPLE_CLINICS: Array<{ name: string; kind: string; mark: React.ReactNode }> = [
  {
    name: 'Neemgrove',
    kind: 'Clinic',
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

function LogoMarquee() {
  // Two identical rows side by side; the strip slides by half its width and loops.
  const row = (hidden: boolean) => (
    <ul className="flex shrink-0" aria-hidden={hidden || undefined}>
      {SAMPLE_CLINICS.map((c) => (
        <li
          key={c.name}
          className="flex w-[220px] shrink-0 flex-col items-center text-center sm:w-[280px]"
        >
          <svg
            viewBox="0 0 34 34"
            width="44"
            height="44"
            className="text-clinical"
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
    <section
      aria-labelledby="logo-preview"
      className="bg-clinical-tint px-4 py-16 text-ink sm:px-6 lg:py-24"
    >
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
        <div className="wl-marquee flex w-max">
          {row(false)}
          {row(true)}
        </div>
      </div>
    </section>
  );
}

/* ---- FAQ & footer --------------------------------------------------------- */

const FAQ = [
  {
    q: 'How can I book a demo?',
    a: SITE.email
      ? `Use any “Book a demo” button to prepare a request for ${SITE.email}.`
      : 'Demo contact details have not been configured on this page yet. Once an email or phone number is added, you can use the contact links here to arrange a demo.',
  },
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
      (SITE.abdm ? ` ${SITE.abdm}.` : ''),
  },
  {
    q: 'Will it look like our clinic, or like your software?',
    a: 'Like your clinic. Your name and logo go on the sign-in page, every screen and the printed prescription, and staff never see our name.',
  },
  {
    q: 'Who can see what?',
    a: 'Each person signs in with their own account and role: front desk, doctor, nurse, owner or administrator. Each role sees only what it needs, and the roles that can change settings must use two-factor sign-in.',
  },
  ...(SITE.pricing.from
    ? [
        {
          q: 'What does it cost?',
          a:
            `From ${SITE.pricing.from} ${SITE.pricing.per}.` +
            (SITE.pricing.trial ? ` ${SITE.pricing.trial}.` : ''),
        },
      ]
    : []),
];

function Faq() {
  return (
    <div className="divide-y divide-ink/8 rounded-card-lg border border-ink/8 bg-white/65 shadow-sm backdrop-blur-xl">
      {FAQ.map((item, i) => (
        <details key={item.q} className="group px-6" open={i === 0}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[15.5px] font-semibold [&::-webkit-details-marker]:hidden">
            {item.q}
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-ink/10 text-ink-40 transition-all duration-300 group-open:rotate-180 group-open:border-clinical/30 group-open:bg-clinical-tint group-open:text-clinical">
              <IconChevronDown size={15} />
            </span>
          </summary>
          <p className="-mt-1 pb-5 pr-12 text-[14.5px] leading-relaxed text-ink-60">{item.a}</p>
        </details>
      ))}
    </div>
  );
}

function FooterLinks({
  title,
  links,
}: {
  title: string;
  links: Array<{ href: string; label: string }>;
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
