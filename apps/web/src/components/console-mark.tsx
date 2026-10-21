/**
 * The DoctorDesk mark: a pulse line in a rounded tile.
 *
 * Used on the public front page and the sign-in page before a clinic is known.
 * Deliberately not doctorsdesk.in's `LogoMark` — a clinic's staff never meet
 * our name (see auth-shell.tsx). `light` inverts it for dark surfaces.
 */
export function ConsoleMark({ size = 30, light = false }: { size?: number; light?: boolean }) {
  const ink = light ? '#0B4F49' : 'white';
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
        stroke={ink}
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity="0.22"
      />
      <path
        d="M7.5 17h3.6l2-4.2 3 8 2.2-5.3 1.2 1.5h5"
        stroke={ink}
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
