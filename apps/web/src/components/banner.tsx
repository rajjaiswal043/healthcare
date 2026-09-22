import { IconAlert, IconCheckCircle, IconInfo } from './icons';

/**
 * A one-line message across a panel: something went wrong, something worked, or
 * something worth knowing. Moved out of the Finance Desk so the promotion panel
 * can say the same things in the same way wherever it is shown.
 */
export function Banner({
  tone,
  children,
}: {
  tone: 'error' | 'info' | 'ok';
  children: React.ReactNode;
}) {
  const skin =
    tone === 'error'
      ? 'border-coral/30 bg-coral/8 text-coral-text'
      : tone === 'ok'
        ? 'border-clinical/30 bg-clinical-tint text-clinical-text'
        : 'border-ink/12 bg-bg-soft text-ink-60';

  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`flex items-start gap-2.5 rounded-card border p-3.5 text-[13.5px] ${skin}`}
    >
      <span className="mt-0.5 shrink-0">
        {tone === 'error' ? (
          <IconAlert size={16} />
        ) : tone === 'ok' ? (
          <IconCheckCircle size={16} />
        ) : (
          <IconInfo size={16} />
        )}
      </span>
      <span>{children}</span>
    </div>
  );
}
