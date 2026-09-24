'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiRequestError } from '@/lib/api';
import { pageFromQuery } from '@/lib/pagination';
import { useAuth } from '@/components/auth-provider';
import { IconSearch } from '@/components/icons';
import { AllPatientsView, type AllPatientsState } from '@/components/all-patients-view';

/**
 * Every active patient, newest registration first, thirty a page.
 *
 * Its own screen rather than the empty state of "Find a patient": one answers
 * "who is registered here", the other "where is this person", and a search box
 * that shows a list until you type is a list pretending to be a search.
 *
 * **The page lives in the URL** — `?page=4` — and nowhere else (decision a,
 * 21 Sep 2026). Held in React state instead, a patient opened from page 4 would
 * come Back to page 1, a refresh would start over, and no page could be linked
 * to. The URL is the state; this component only reads it.
 *
 * Choosing a patient opens exactly what choosing one from search opens — the
 * same `PatientTable`, the same link, the same record.
 */
export default function AllPatientsPage() {
  return (
    <Suspense fallback={null}>
      <AllPatients />
    </Suspense>
  );
}

function AllPatients() {
  const { can } = useAuth();
  const params = useSearchParams();
  const page = pageFromQuery(params.get('page'));

  const [state, setState] = useState<AllPatientsState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });

    void (async () => {
      try {
        const result = await api.allPatients(page);
        if (!cancelled) setState({ kind: 'loaded', ...result });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message:
              err instanceof ApiRequestError ? err.error.message : 'Could not load the patients.',
          });
        }
      }
    })();

    // A slow response for page 3 must not land after the one for page 4 and
    // overwrite it.
    return () => {
      cancelled = true;
    };
  }, [page]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Patient 360</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">All patients</h1>
          <p className="mt-1 text-[14px] text-ink-60">Everyone registered here, newest first.</p>
        </div>
        <Link href="/patients" className="btn-secondary">
          <IconSearch size={16} />
          Find a patient
        </Link>
      </header>

      <AllPatientsView state={state} canRegister={can('patient:write')} />
    </div>
  );
}
