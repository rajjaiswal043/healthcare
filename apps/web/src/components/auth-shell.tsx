import type { ReactNode } from 'react';
import { IconEyeOff, IconLock, IconShield } from './icons';
import { ClinicLogo, type LogoSource } from './clinic-logo';

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
 *
 * Two variants. `platform` is doctorsdesk.in signing into its own console and
 * still wears our name, because that console is ours. `clinic` wears the
 * CLINIC'S name and logo and never ours — full white-label, Narveer's decision
 * on 26 Aug 2026 (docs/07). That is why the clinic side lost the blockquote,
 * "Clinic CRM for India" and "ABDM-aware · Built for Indian OPD": they are our
 * voice, and a clinic does not hear it.
 *
 * The clinic panel therefore has a state nothing else in the app has: **before
 * a slug has been typed there is no clinic**, and the page belongs to nobody.
 * It shows the bundled default mark and neutral words rather than guessing.
 *
 * The `TrustRow` under the form survives white-labelling because it never named
 * us — it makes a claim about the clinic's data, not about who wrote this.
 */

type Variant = 'clinic' | 'platform';

/** Whose sign-in this is, once the slug has resolved. Null until then. */
export interface ClinicBrand extends LogoSource {
  name: string;
}

// Inline SVG turbulence: no extra request, nothing to cache-bust, and it
// survives a strict content-security policy.
const GRAIN =
  'url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 200%22><filter id=%22n%22><feTurbulence type=%22fractalNoise%22 baseFrequency=%220.9%22/></filter><rect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22 opacity=%220.035%22/></svg>")';

export function TrustRow({ variant = 'clinic' }: { variant?: Variant }) {
  const items =
    variant === 'platform'
      ? [
          { icon: <IconShield size={12} />, label: 'Separate realm' },
          { icon: <IconLock size={12} />, label: '10-min session' },
          { icon: <IconEyeOff size={12} />, label: 'No patient access' },
        ]
      : [
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

export function AuthShell({
  children,
  variant = 'clinic',
  clinic = null,
}: {
  children: ReactNode;
  variant?: Variant;
  /** Ignored by the platform variant, which is not a clinic. */
  clinic?: ClinicBrand | null;
}) {
  const platform = variant === 'platform';

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
        {platform ? <PlatformBrand /> : <ClinicBrandPanel clinic={clinic} />}

        {/* Form panel. Scrolls internally only if the window is unusually short. */}
        <section className="flex min-h-0 flex-col justify-center overflow-y-auto bg-white/75 px-6 py-7 backdrop-blur-sm sm:px-9">
          <div className="mx-auto w-full max-w-[350px]">
            {/* Compact lockup for the small-screen layout, where the panel
                above is hidden. */}
            <div className="mb-5 flex items-center gap-2.5 lg:hidden">
              {platform ? (
                <>
                  <LogoMark size={24} />
                  <span className="font-display text-[19px] font-extrabold">
                    doctors<span className="text-clinical">desk.in</span>
                  </span>
                </>
              ) : (
                <>
                  <ClinicLogo clinic={clinic} size={26} />
                  <span className="truncate font-display text-[17px] font-extrabold">
                    {clinic?.name ?? 'Clinic sign-in'}
                  </span>
                </>
              )}
            </div>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * The clinic's half. Their mark, their name, and nothing of ours.
 *
 * Deliberately quiet when `clinic` is null. That is not a loading state to be
 * papered over with a spinner — it is the honest answer to "whose sign-in is
 * this?" before the slug has been typed, and a guess would be worse.
 */
function ClinicBrandPanel({ clinic }: { clinic: ClinicBrand | null }) {
  return (
    <section className="relative hidden flex-col items-center justify-center gap-7 border-r border-ink/10 bg-gradient-to-br from-white/60 to-bg-soft/60 px-12 py-10 text-center lg:flex">
      <ClinicLogo clinic={clinic} size={clinic ? 92 : 72} alt={clinic?.name ?? ''} />

      {clinic ? (
        <div className="flex flex-col items-center gap-4">
          <p className="max-w-[380px] font-display text-[clamp(24px,2.7vw,32px)] font-bold leading-[1.14] tracking-display text-ink">
            {clinic.name}
          </p>
          <p className="mono-label flex items-center gap-3">
            <span aria-hidden="true" className="inline-block h-px w-9 bg-clinical" />
            Staff sign-in
          </p>
        </div>
      ) : (
        <p className="max-w-[300px] text-[13.5px] text-ink-40">
          Enter your clinic&rsquo;s sign-in address and it will appear here.
        </p>
      )}
    </section>
  );
}

/** doctorsdesk.in's own half. This console is ours, so it says so. */
function PlatformBrand() {
  return (
    <section className="relative hidden flex-col items-center justify-center gap-9 border-r border-ink/10 bg-gradient-to-br from-white/60 to-bg-soft/60 px-12 py-10 text-center lg:flex">
      <p className="flex items-center gap-2.5 font-display text-[23px] font-extrabold tracking-display text-ink">
        <LogoMark size={28} />
        doctors<span className="-ml-2.5 text-clinical">desk.in</span>
      </p>

      <figure className="relative m-0 flex max-w-[400px] flex-col items-center gap-5">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-11 left-1/2 -translate-x-1/2 select-none font-display text-[7rem] font-bold leading-none text-clinical/12"
        >
          &ldquo;
        </span>
        <blockquote className="relative z-10 m-0 font-display text-[clamp(22px,2.6vw,30px)] font-bold leading-[1.12] tracking-display text-ink">
          <span className="block">Every clinic on the platform,</span>
          <span className="block text-clinical-text">in one list.</span>
        </blockquote>
        <figcaption className="mono-label flex items-center gap-3">
          <span aria-hidden="true" className="inline-block h-px w-9 bg-clinical" />
          Platform operations
        </figcaption>
      </figure>

      <p className="flex items-center gap-2 text-[12.5px] text-ink-40">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-clinical shadow-[0_0_8px_rgba(15,118,110,.55)]"
        />
        Not a clinic account · Opens no patient record
      </p>
    </section>
  );
}

/**
 * One field, both sign-ins.
 *
 * Anything that changes here — focus ring, icon inset, label size — changes on
 * both by construction.
 */
export function AuthField({
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
  icon: ReactNode;
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

/**
 * doctorsdesk.in's mark.
 *
 * Not used anywhere a clinic can see it — that is what full white-label means.
 * The clinic surfaces use `ClinicLogo`, which falls back to the bundled generic
 * mark rather than to ours.
 */
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
