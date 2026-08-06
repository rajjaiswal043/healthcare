import type { ReactNode } from 'react';
import { IconEyeOff, IconLock, IconShield } from './icons';

/**
 * The sign-in stage: drifting warm colour and paper grain behind a glassy split
 * card — brand on the left, form on the right.
 *
 * HEIGHT IS A HARD CONSTRAINT HERE. The whole thing must fit one viewport with
 * no page scroll, so:
 *   - the stage is `h-screen` with `overflow-hidden`
 *   - the card is capped to the viewport minus its margin
 *   - the form column scrolls INTERNALLY as a last resort, so a very short
 *     window degrades to a small inner scroll rather than clipping the button
 *   - the brand panel is hidden below `lg`, where stacking it above the form
 *     would guarantee overflow
 */

// Inline SVG turbulence: no extra request, nothing to cache-bust, and it
// survives a strict content-security policy.
const GRAIN =
  'url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 200%22><filter id=%22n%22><feTurbulence type=%22fractalNoise%22 baseFrequency=%220.9%22/></filter><rect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22 opacity=%220.035%22/></svg>")';

export function TrustRow() {
  const items = [
    { icon: <IconShield size={12} />, label: 'DPDP-ready' },
    { icon: <IconLock size={12} />, label: 'Encrypted' },
    { icon: <IconEyeOff size={12} />, label: 'Audited' },
  ];

  return (
    <div className="mt-5 flex flex-wrap items-center justify-center gap-3 border-t border-dashed border-ink/15 pt-4">
      {items.map((item, i) => (
        <span key={item.label} className="flex items-center gap-3">
          {i > 0 && <span aria-hidden="true" className="h-1 w-1 rounded-full bg-ink/20" />}
          <span className="mono-label flex items-center gap-1.5">
            <span className="text-clinical">{item.icon}</span>
            {item.label}
          </span>
        </span>
      ))}
    </div>
  );
}

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex h-screen w-full items-center justify-center overflow-hidden bg-bg p-3 sm:p-5">
      <div
        aria-hidden="true"
        className="auth-blob pointer-events-none absolute -right-[10%] -top-[12%] h-[520px] w-[520px] rounded-full bg-clinical-soft/70 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="auth-blob-slow pointer-events-none absolute -bottom-[16%] -left-[12%] h-[600px] w-[600px] rounded-full bg-amber-soft/50 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="auth-blob pointer-events-none absolute left-[42%] top-[38%] h-[360px] w-[360px] rounded-full bg-coral-soft/25 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 mix-blend-multiply"
        style={{ backgroundImage: GRAIN }}
      />

      <div className="relative z-10 grid max-h-full w-full max-w-[1040px] overflow-hidden rounded-card-lg border border-ink/10 bg-white/60 shadow-lg backdrop-blur-xl lg:h-[min(620px,calc(100vh-2.5rem))] lg:grid-cols-[1.05fr_0.95fr]">
        {/* Brand panel — hidden below lg, where stacking it would force a scroll. */}
        <section className="relative hidden flex-col items-center justify-center gap-9 border-r border-ink/10 bg-gradient-to-br from-white/60 to-bg-soft/60 px-12 py-10 text-center lg:flex">
          <p className="flex items-center gap-2.5 font-display text-[23px] font-extrabold tracking-display text-ink">
            <LogoMark size={28} />
            Health<span className="text-clinical">Cloud</span>
          </p>

          <figure className="relative m-0 flex max-w-[400px] flex-col items-center gap-5">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-11 left-1/2 -translate-x-1/2 select-none font-display text-[7rem] font-bold leading-none text-clinical/12"
            >
              &ldquo;
            </span>
            <blockquote className="relative z-10 m-0 font-display text-[clamp(22px,2.6vw,30px)] font-bold leading-[1.12] tracking-display text-ink">
              <span className="block">Every patient relationship,</span>
              <span className="block text-clinical-text">in one place.</span>
            </blockquote>
            <figcaption className="mono-label flex items-center gap-3">
              <span aria-hidden="true" className="inline-block h-px w-9 bg-clinical" />
              Clinic CRM for India
            </figcaption>
          </figure>

          <p className="flex items-center gap-2 text-[12.5px] text-ink-40">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-clinical shadow-[0_0_8px_rgba(15,118,110,.55)]"
            />
            ABDM-aware · Built for Indian OPD
          </p>
        </section>

        {/* Form panel. Scrolls internally only if the window is unusually short. */}
        <section className="flex min-h-0 flex-col justify-center overflow-y-auto bg-white/75 px-6 py-7 backdrop-blur-sm sm:px-9">
          <div className="mx-auto w-full max-w-[350px]">
            {/* Compact brand lockup for the small-screen layout, where the
                brand panel above is hidden. */}
            <p className="mb-5 flex items-center gap-2 font-display text-[19px] font-extrabold lg:hidden">
              <LogoMark size={24} />
              Health<span className="text-clinical">Cloud</span>
            </p>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}

export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="9" className="fill-clinical" />
      <path
        d="M9 16h3.2l1.6-3.6 2.6 7.2 1.7-3.6H23"
        stroke="white"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
