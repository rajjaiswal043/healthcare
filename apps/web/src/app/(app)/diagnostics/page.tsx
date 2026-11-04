'use client';

import { Suspense } from 'react';
import { DiagnosticsBoard } from '@/components/diagnostics-board';

/**
 * The department's worklist at its own address.
 *
 * The board itself is a component because it is ALSO the home page for anybody
 * whose only job is diagnostics — see `app/(app)/page.tsx`. This route stays so
 * that everyone else can reach it: an administrator covering the X-ray room,
 * and the navigation entry that has always pointed here.
 *
 * Wrapped in `Suspense` because the board reads the day off the URL, and
 * `useSearchParams` asks for a boundary to suspend at during prerender.
 */
export default function DiagnosticsPage() {
  return (
    <Suspense fallback={<p className="field-hint">Loading…</p>}>
      <DiagnosticsBoard />
    </Suspense>
  );
}
