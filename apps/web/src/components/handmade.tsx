import { Caveat } from 'next/font/google';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Small hand-made touches for the two public screens (/welcome, /login).
 *
 * The console is a tool, and it stays plain. These pages are where a clinic
 * first meets it, and a page built only from rounded cards and gradients reads
 * like every other SaaS template. So they borrow from the paper an Indian OPD
 * already runs on — the token slip, the rubber stamp, the Rx pad — and from
 * the pen: a few margin notes and underlines, drawn once, never animated in a
 * loop.
 *
 * Rules, so this stays tasteful rather than twee:
 *   - handwriting is for asides only, never for anything someone must read to
 *     do their job (labels, errors, buttons);
 *   - at most two or three hand-drawn marks per screen;
 *   - everything decorative is aria-hidden.
 */

const hand = Caveat({ subsets: ['latin'], weight: ['500', '700'], display: 'swap' });

/** A margin note in handwriting. Decorative; keep the words short. */
export function HandNote({
  children,
  className = '',
  rotate = -3,
  style,
}: {
  children: ReactNode;
  className?: string;
  rotate?: number;
  style?: CSSProperties | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={`${hand.className} inline-block leading-none ${className}`}
      style={{ transform: `rotate(${rotate}deg)`, ...style }}
    >
      {children}
    </span>
  );
}

/**
 * Wraps words with a pen underline drawn beneath them. The stroke draws itself
 * once on load (a CSS animation the global reduced-motion rule neutralises).
 */
export function Underlined({
  children,
  color = '#E4674F',
  className = '',
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span className={`relative inline-block whitespace-nowrap ${className}`}>
      {children}
      <svg
        aria-hidden="true"
        viewBox="0 0 300 18"
        preserveAspectRatio="none"
        className="hm-draw pointer-events-none absolute -bottom-[0.14em] left-[-2%] h-[0.32em] w-[104%]"
        fill="none"
      >
        <path
          d="M3 12.5C48 6.2 104 4.1 158 5.6c46 1.3 93 3.9 139 8.1M22 15.4c61-4.6 131-6 205-3.2"
          stroke={color}
          strokeWidth="3.2"
          strokeLinecap="round"
          pathLength={1}
        />
      </svg>
    </span>
  );
}

/** A loose hand-drawn arrow. `direction` picks which way the head points. */
export function HandArrow({
  className = '',
  color = 'currentColor',
  direction = 'down-right',
}: {
  className?: string;
  color?: string;
  direction?: 'down-right' | 'down-left' | 'left';
}) {
  const d =
    direction === 'left'
      ? { path: 'M76 20C58 8 34 6 8 17', head: 'M17 8 8 17l12 5' }
      : direction === 'down-left'
        ? { path: 'M70 6C60 30 40 46 12 52', head: 'M24 44 12 52l14 3' }
        : { path: 'M8 6c10 24 30 40 58 46', head: 'M54 44l12 8-14 3' };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 80 60"
      className={`pointer-events-none ${className}`}
      fill="none"
      stroke={color}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d.path} />
      <path d={d.head} />
    </svg>
  );
}

/**
 * A rubber stamp, slightly crooked and unevenly inked — the ink texture comes
 * from an SVG turbulence filter, so no two edges look machine-straight.
 */
export function Stamp({
  top,
  middle,
  bottom,
  color = '#C2452D',
  size = 132,
  rotate = -12,
  className = '',
}: {
  top: string;
  middle: string;
  bottom: string;
  color?: string;
  size?: number;
  rotate?: number;
  className?: string;
}) {
  const id = `stamp-${top.replace(/\W/g, '')}-${middle.replace(/\W/g, '')}`;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 140 140"
      className={`pointer-events-none ${className}`}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <defs>
        <filter id={`${id}-ink`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.25" />
          <feComposite in="SourceGraphic" operator="in" />
        </filter>
        <path id={`${id}-arc-top`} d="M22 70a48 48 0 0 1 96 0" />
        <path id={`${id}-arc-bottom`} d="M20 70a50 50 0 0 0 100 0" />
      </defs>
      <g filter={`url(#${id}-ink)`} fill={color} stroke={color} opacity="0.86">
        <circle cx="70" cy="70" r="64" fill="none" strokeWidth="3.4" />
        <circle cx="70" cy="70" r="56" fill="none" strokeWidth="1.4" />
        <text
          fontFamily="var(--font-mono), monospace"
          fontSize="11.5"
          fontWeight="700"
          letterSpacing="2.4"
          stroke="none"
        >
          <textPath href={`#${id}-arc-top`} startOffset="50%" textAnchor="middle">
            {top}
          </textPath>
        </text>
        <rect x="14" y="58" width="112" height="24" fill="none" strokeWidth="2.4" />
        <text
          x="70"
          y="76"
          textAnchor="middle"
          fontFamily="var(--font-display), sans-serif"
          fontSize="17"
          fontWeight="800"
          letterSpacing="1.5"
          stroke="none"
        >
          {middle}
        </text>
        <text
          fontFamily="var(--font-mono), monospace"
          fontSize="10"
          fontWeight="700"
          letterSpacing="2"
          stroke="none"
          dy="6"
        >
          <textPath href={`#${id}-arc-bottom`} startOffset="50%" textAnchor="middle">
            {bottom}
          </textPath>
        </text>
      </g>
    </svg>
  );
}

/**
 * A printed queue token: thermal-paper white, torn edges top and bottom, set
 * slightly off-square the way a slip lands on a desk. Sample data only.
 */
export function TokenSlip({
  heading,
  token,
  lines,
  footer,
  rotate = -4,
  className = '',
}: {
  heading: string;
  token: string;
  lines: ReadonlyArray<readonly [string, string]>;
  footer: string;
  rotate?: number;
  className?: string;
}) {
  const torn =
    'radial-gradient(circle at 6px 0, transparent 5px, #000 5.5px) top left / 12px 51% repeat-x, radial-gradient(circle at 6px 100%, transparent 5px, #000 5.5px) bottom left / 12px 51% repeat-x';
  return (
    <div
      aria-hidden="true"
      className={`relative w-[210px] bg-[#FFFEFB] px-5 pb-6 pt-6 font-mono text-[#2a2824] shadow-[0_18px_30px_-12px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.15)] ${className}`}
      style={{
        transform: `rotate(${rotate}deg)`,
        WebkitMask: torn,
        mask: torn,
      }}
    >
      <p className="text-center text-[10px] font-bold uppercase tracking-[0.2em]">{heading}</p>
      <p className="mt-0.5 text-center text-[9px] text-[#6B6660]">- - - - - - - - - - - - - -</p>
      <p className="mt-2 text-center text-[9.5px] uppercase tracking-[0.18em] text-[#6B6660]">
        Token
      </p>
      <p className="text-center font-display text-[54px] font-extrabold leading-none tracking-[-0.03em]">
        {token}
      </p>
      <div className="mt-3 space-y-1 text-[10.5px]">
        {lines.map(([k, v]) => (
          <p key={k} className="flex justify-between gap-2">
            <span className="text-[#6B6660]">{k}</span>
            <span className="font-semibold">{v}</span>
          </p>
        ))}
      </div>
      <p className="mt-3 border-t border-dashed border-[#9A948C] pt-2 text-center text-[9px] uppercase tracking-[0.14em] text-[#6B6660]">
        {footer}
      </p>
    </div>
  );
}

/** Keyframes the pieces above rely on. Rendered once by each page. */
export const HANDMADE_CSS = `
@keyframes hm-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
.hm-draw path{stroke-dasharray:1;stroke-dashoffset:1;animation:hm-draw 1.1s .5s cubic-bezier(.6,0,.3,1) forwards}
@media (prefers-reduced-motion: reduce){.hm-draw path{stroke-dashoffset:0;animation:none}}
`;
