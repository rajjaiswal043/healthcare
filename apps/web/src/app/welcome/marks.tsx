'use client';

import { Caveat } from 'next/font/google';

/**
 * Drawing pieces shared by the welcome page and the sign-in page: the product
 * mark, the line icons, and the hand-drawn notes, ticket and stamp that sit
 * around the screenshots.
 *
 * Kept beside the welcome page rather than in `components/` because nothing in
 * the console uses them — they are the public face, not the product.
 */

const hand = Caveat({ subsets: ['latin'], display: 'swap' });

/* ---- Product mark --------------------------------------------------------- */

export function DoctorDeskMark({ size = 30, light = false }: { size?: number; light?: boolean }) {
  const stroke = light ? '#0B4F49' : 'white';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect
        width="32"
        height="32"
        rx="10"
        className={light ? 'fill-white' : 'fill-clinical-deep'}
      />
      <path
        d="M16 8.5v15M8.5 16h15"
        stroke={stroke}
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity="0.22"
      />
      <path
        d="M7.5 17h3.6l2-4.2 3 8 2.2-5.3 1.2 1.5h5"
        stroke={stroke}
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ---- Line icons ----------------------------------------------------------- */

type IconProps = { size?: number; className?: string };

function Icon({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
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
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);
export const IconChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);
export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 9l7 7 7-7" />
  </Icon>
);
export const IconMail = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8l9 6 9-6" />
    <rect x="3" y="5" width="18" height="14" rx="2" />
  </Icon>
);
export const IconLock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3M12 14v2" />
  </Icon>
);
export const IconBuilding = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 21V5a2 2 0 012-2h7a2 2 0 012 2v16M4 21h16M15 9h3a2 2 0 012 2v10M8 7h2M8 11h2M8 15h2" />
  </Icon>
);
export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
    <path d="M9.5 12l2 2 3.5-3.5" />
  </Icon>
);
export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.85 12.15L19 4M18 5l2 2M15 8l2 2" />
  </Icon>
);
export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 4.2A9.9 9.9 0 0112 4c5 0 9.3 3.1 10.5 7.5a13 13 0 01-3.4 4.9M6.6 6.6A13 13 0 001.5 11.5C2.7 15.9 7 19 12 19c1.5 0 2.9-.3 4.3-.8" />
  </Icon>
);
export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Icon>
);
export const IconUserPlus = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="4" />
    <path d="M2 21a7 7 0 0114 0M18 8v6M21 11h-6" />
  </Icon>
);
export const IconUsers = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2 20a7 7 0 0114 0M17 4.5a3.5 3.5 0 010 7M18 20a6.5 6.5 0 00-2-4.7" />
  </Icon>
);
export const IconHome = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 10.5L12 3l9 7.5M5.5 9.5V20h13V9.5" />
    <path d="M9.5 20v-5h5v5" />
  </Icon>
);
export const IconMenu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 12.5l5 5 10-11" />
  </Icon>
);
export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5L2.8 20h18.4L12 4.5z" />
    <path d="M12 10v4M12 17.2v.1" />
  </Icon>
);
export const IconX = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const IconCalendar = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Icon>
);
export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Icon>
);
export const IconReceipt = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 3h14v18l-2.3-1.6L14.4 21l-2.4-1.6L9.6 21l-2.3-1.6L5 21z" />
    <path d="M9 8h6M9 12h6" />
  </Icon>
);
export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 15V10a6 6 0 10-12 0v5l-1.5 3h15L18 15z" />
    <path d="M10 21h4" />
  </Icon>
);
export const IconFlask = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 3h6M10 3v6.5L4.8 18.2A2 2 0 006.5 21h11a2 2 0 001.7-2.8L14 9.5V3" />
    <path d="M7.5 15h9" />
  </Icon>
);
export const IconRx = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 20V4h5a4 4 0 010 8H6M10 12l8 8M18 13l-5 6" />
  </Icon>
);
export const IconTag = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12V4a1 1 0 011-1h8l9 9-9 9-9-9z" />
    <circle cx="8" cy="8" r="1.5" />
  </Icon>
);
export const IconKeyboard = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </Icon>
);

/* ---- Hand-drawn notes ----------------------------------------------------- */

/** A note in handwriting. Decorative: the same words are never the only copy. */
export function Handwritten({
  children,
  className = '',
  rotate = -3,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  rotate?: number;
  style?: React.CSSProperties;
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

const ARROWS = {
  left: { path: 'M76 20C58 8 34 6 8 17', head: 'M17 8 8 17l12 5' },
  'down-left': { path: 'M70 6C60 30 40 46 12 52', head: 'M24 44 12 52l14 3' },
  'down-right': { path: 'M8 6c10 24 30 40 58 46', head: 'M54 44l12 8-14 3' },
};

export function HandArrow({
  className = '',
  color = 'currentColor',
  direction = 'down-right',
}: {
  className?: string;
  color?: string;
  direction?: keyof typeof ARROWS;
}) {
  const a = ARROWS[direction];
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
      <path d={a.path} />
      <path d={a.head} />
    </svg>
  );
}

/** A rubber stamp, slightly uneven, as if inked by hand. */
export function InkStamp({
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

/** The paper token slip a clinic used to tear off a roll. */
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
  lines: Array<[string, string]>;
  footer: string;
  rotate?: number;
  className?: string;
}) {
  // Scalloped top and bottom edges, cut with a mask rather than drawn.
  const edge =
    'radial-gradient(circle at 6px 0, transparent 5px, #000 5.5px) top left / 12px 51% repeat-x, radial-gradient(circle at 6px 100%, transparent 5px, #000 5.5px) bottom left / 12px 51% repeat-x';
  return (
    <div
      aria-hidden="true"
      className={`relative w-[210px] bg-[#FFFEFB] px-5 pb-6 pt-6 font-mono text-[#2a2824] shadow-[0_18px_30px_-12px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.15)] ${className}`}
      style={{ transform: `rotate(${rotate}deg)`, WebkitMask: edge, mask: edge }}
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

export const HAND_DRAW_CSS = `
@keyframes hm-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
.hm-draw path{stroke-dasharray:1;stroke-dashoffset:1;animation:hm-draw 1.1s .5s cubic-bezier(.6,0,.3,1) forwards}
@media (prefers-reduced-motion: reduce){.hm-draw path{stroke-dashoffset:0;animation:none}}
`;

/* ---- Night look ----------------------------------------------------------- */

const NIGHT = '[data-look="night"]';

/**
 * Re-colours the light utility classes under `[data-look="night"]`.
 *
 * The console has no dark theme, so these public pages carry their own: a map
 * of class selector to declarations, each scoped both to descendants of the
 * night root and to the root itself.
 */
export function nightLookCss(rules: Record<string, string>): string {
  const body = Object.entries(rules)
    .map(([selectors, decl]) => {
      const scoped = selectors
        .split(',')
        .map((s) => s.trim())
        .flatMap((s) => [`${NIGHT} ${s}`, `${NIGHT}${s}`])
        .join(',');
      return `${scoped}{${decl}}`;
    })
    .join('\n');
  return `${NIGHT}{color-scheme:dark;color:#E4EAE8}\nhtml:has(${NIGHT}){background:#0E1315}\nbody:has(${NIGHT}){background:#0E1315}\n${body}`;
}
