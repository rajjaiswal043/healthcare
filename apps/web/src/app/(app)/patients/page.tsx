'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiRequestError, type PatientSummary } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { PatientTable, PatientTableSkeleton } from '@/components/patient-table';
import { IconSearch, IconUserPlus, IconUsers } from '@/components/icons';

export default function PatientSearchPage() {
  return (
    <Suspense fallback={null}>
      <PatientSearch />
    </Suspense>
  );
}

function PatientSearch() {
  const params = useSearchParams();
  const { can } = useAuth();

  const [query, setQuery] = useState(params.get('q') ?? '');
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setState('idle');
      return;
    }

    setState('searching');
    setError(null);

    try {
      const { patients } = await api.searchPatients(q);
      setResults(patients);
      setState('done');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Search failed');
      setState('error');
    }
  }, []);

  // Debounced: the receptionist is typing, not submitting. 250ms feels live
  // without firing on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => void search(query), 250);
    return () => clearTimeout(t);
  }, [query, search]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Patient 360</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">Find a patient</h1>
          <p className="mt-1 text-[14px] text-ink-60">
            Name, mobile, UHID or ABHA number — one box, no field picker.
          </p>
        </div>
        {can('patient:write') && (
          <Link href="/patients/register" className="btn-primary">
            <IconUserPlus size={16} />
            Register a patient
          </Link>
        )}
      </header>

      <div className="card p-4">
        <label htmlFor="q" className="field-label">
          Search
        </label>
        <div className="relative flex items-center">
          <span className="pointer-events-none absolute left-3.5 text-ink-20">
            <IconSearch size={16} />
          </span>
          <input
            id="q"
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Sharma · 9876543210 · SNC00042"
            className="field-input-icon"
            autoComplete="off"
            aria-describedby="search-status"
          />
        </div>
        <p id="search-status" className="field-hint" role="status" aria-live="polite">
          {state === 'searching' && 'Searching…'}
          {state === 'done' &&
            `${results.length} ${results.length === 1 ? 'match' : 'matches'}${
              results.length === 25 ? ' (showing first 25)' : ''
            }`}
          {state === 'idle' && 'Type at least 2 characters'}
          {state === 'error' && <span className="text-coral-text">{error}</span>}
        </p>
      </div>

      {state === 'searching' && results.length === 0 && <PatientTableSkeleton />}

      {state === 'done' && results.length === 0 && (
        <div className="card flex flex-col items-center px-6 py-12 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-panel bg-ink/5 text-ink-20">
            <IconUsers size={22} />
          </span>
          <p className="mt-4 font-display text-[18px] font-bold">No patient matches</p>
          <p className="mt-1 max-w-sm text-[13.5px] text-ink-60">
            Nothing found for &ldquo;{query}&rdquo;. Check the spelling, or register them as a new
            patient.
          </p>
          {can('patient:write') && (
            <Link href="/patients/register" className="btn-primary mt-5">
              <IconUserPlus size={16} />
              Register a new patient
            </Link>
          )}
        </div>
      )}

      {results.length > 0 && <PatientTable patients={results} />}
    </div>
  );
}
