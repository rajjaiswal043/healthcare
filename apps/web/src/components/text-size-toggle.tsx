'use client';

/**
 * Standard or larger text, remembered per computer.
 *
 * Kept on the PC rather than the person because the PC is what differs: the
 * consultant's chamber PC is set large once and stays large for everyone who
 * uses it, while the reception PC stays standard. Clearing the browser's data
 * puts it back to standard.
 *
 * Set on the welcome page, beside the night switch. The sign-in form reads the
 * same key, so a PC set to large text gets a large sign-in form as well.
 */
export const TEXT_KEY = 'healthcloud.textSize';
export type TextSize = 'standard' | 'large';

export function readTextSize(): TextSize {
  try {
    return window.localStorage.getItem(TEXT_KEY) === 'large' ? 'large' : 'standard';
  } catch {
    return 'standard';
  }
}

export function saveTextSize(size: TextSize): void {
  try {
    window.localStorage.setItem(TEXT_KEY, size);
  } catch {
    // Remembered for this visit only.
  }
}

/**
 * The two-part "Aa | Aa" switch: small A for standard, big A for larger text.
 * Each half says what it does to screen readers, and the current one is marked
 * pressed.
 */
export function TextSizeToggle({
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
      className="inline-flex h-10 shrink-0 items-center gap-0.5 rounded-pill border border-ink/10 bg-white/80 p-0.5 backdrop-blur"
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
            className={`grid h-[34px] min-w-[34px] place-items-center rounded-pill px-2 font-display font-bold leading-none transition-colors ${
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
