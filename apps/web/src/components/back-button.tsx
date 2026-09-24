'use client';

import { useRouter } from 'next/navigation';
import { backTarget, hasInAppHistory } from '@/lib/navigation-history';
import { IconArrowLeft } from './icons';

/**
 * "Back", meaning back to wherever this page was opened from.
 *
 * A patient record is reached from "Find a patient" and from "Recent
 * patients", and a Back button hard-coded to one of them sends everybody who
 * came from the other to the wrong list. So it walks the browser's history —
 * when there is in-app history to walk — and otherwise falls back to
 * `fallback`, the page that makes sense for somebody who arrived here directly.
 * See `navigation-history.ts` for why "is there history" is not a question the
 * browser can answer on its own.
 *
 * A button, not a link: where it goes is decided at click time, and an `<a>`
 * with an `href` that is sometimes a lie is worse than an honest button.
 */
export function BackButton({ fallback, className }: { fallback: string; className?: string }) {
  const router = useRouter();

  return (
    <button
      type="button"
      className={className}
      aria-label="Back"
      onClick={() => {
        const target = backTarget(hasInAppHistory(), fallback);
        if (target.kind === 'history') router.back();
        else router.push(target.href);
      }}
    >
      <IconArrowLeft size={16} />
    </button>
  );
}
