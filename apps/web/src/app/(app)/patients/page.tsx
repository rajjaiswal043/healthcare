'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiRequestError, type PatientSummary } from '@/lib/api';
import { pageFromQuery } from '@/lib/pagination';
import { SEARCH_CAP, adoptionFor, isSearchTerm, urlWriteFor } from '@/lib/patient-search';
import { useAuth } from '@/components/auth-provider';
import { PatientTable, PatientTableSkeleton } from '@/components/patient-table';
import { AllPatientsView, type AllPatientsState } from '@/components/all-patients-view';
import { IconSearch, IconUserPlus, IconUsers } from '@/components/icons';

/**
 * Patients: the list, and the search over it, on one screen.
 *
 * THESE WERE TWO SCREENS. "Find a patient" opened to an empty box, and "All
 * patients" listed everyone — and the argument for keeping them apart was that
 * one answers "where is this person" and the other "who is registered here", so
 * a search box sitting above a list is a list pretending to be a search.
 *
 * What changed is that the clinic answered it. The finance desk lists every
 * open bill with a search for the rest, the day board lists everyone here today
 * with a search over it, and both read better than the search-first versions
 * they replaced. A receptionist does not arrive knowing which of two menu items
 * holds the person they are looking for; they arrive with a name, or with no
 * name at all. One screen serves both, and the empty box is not a dead end any
 * more — it is the whole register.
 *
 * TWO QUERIES, NOT A FILTER, which is the one thing to keep straight here:
 * `allPatients` is paged and ordered by registration, `searchPatients` is
 * ranked and capped. So pagination genuinely disappears while searching,
 * because there is nothing to page through — and the count says when the cap
 * has been hit rather than quietly showing the top of a longer list.
 *
 * THE URL IS THE STATE, as it was on the list before this: `?q=` or `?page=`,
 * never both. A patient opened from page 4 comes Back to page 4, a search can
 * be sent to somebody, and a refresh lands where it left off.
 *
 * AND IT IS THE STATE IN BOTH DIRECTIONS since 27 Oct 2026. It used to be
 * written only, which meant a term pushed at this screen — by the header box,
 * by the keyboard shortcut, by Back — never reached the input and was then
 * deleted off the URL again. `patient-search.ts` has the account and the rules.
 */
export default function PatientsPage() {
  return (
    <Suspense fallback={null}>
      <Patients />
    </Suspense>
  );
}

function Patients() {
  const params = useSearchParams();
  const router = useRouter();
  const { can } = useAuth();

  /**
   * The box is local state, reconciled with the URL in both directions.
   *
   * Reading the URL back on every render would fight the person typing — each
   * write re-renders this component and would reset the cursor — so it is read
   * back only when it says something this screen did not write.
   */
  const [query, setQuery] = useState(params.get('q') ?? '');
  const searching = isSearchTerm(query);
  const page = pageFromQuery(params.get('page'));

  /** What the URL currently claims is being searched for. */
  const queryOnUrl = params.get('q');

  /**
   * The term this screen itself last put on the URL — `null` for having taken
   * one off.
   *
   * The initial URL counts as written: a refresh on `?q=sharma` starts with
   * that word already in the box, and adopting it as well would be a second
   * search for the same name.
   */
  const writtenByUs = useRef<string | null>(params.get('q'));

  /**
   * The last term actually sent to the server.
   *
   * Writing the URL re-renders this component with new `params`, which runs the
   * effect below a second time for the same word. Without this it would search
   * twice for every search.
   *
   * Cleared again when a request fails, because a search that failed did not
   * happen. Without that, one dropped response made that name permanently
   * unsearchable: retyping it matched this ref and fired nothing, and the only
   * way out was a different word or a reload.
   */
  const lastSearched = useRef<string | null>(null);

  const [results, setResults] = useState<PatientSummary[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [searchError, setSearchError] = useState<string | null>(null);

  const [list, setList] = useState<AllPatientsState>({ kind: 'loading' });

  /**
   * Which request is the current one.
   *
   * Two searches can be in flight at once, and the first one sent is not
   * reliably the first one back: "sha" ranks several hundred patients where
   * "sharma" ranks two. The older response landing last showed results for a
   * word already typed past — or an empty "No patient matches" for a name with
   * plenty. The register fetch below has always been guarded this way; the
   * search never was.
   */
  const requestId = useRef(0);

  const search = useCallback(async (q: string) => {
    const id = ++requestId.current;
    setSearchState('searching');
    setSearchError(null);

    try {
      const { patients } = await api.searchPatients(q);
      if (id !== requestId.current) return;
      setResults(patients);
      setSearchState('done');
    } catch (err) {
      if (id !== requestId.current) return;
      // So the same word can be sent again on the next keystroke.
      lastSearched.current = null;
      setResults([]);
      setSearchError(err instanceof ApiRequestError ? err.error.message : 'Search failed');
      setSearchState('error');
    }
  }, []);

  /**
   * A term that arrived from somewhere else goes into the box.
   *
   * Not debounced: the header search, the keyboard shortcut, Back, Forward and
   * a `?q=` link somebody was sent all land here as a changed query string, and
   * every one of them is a person already waiting for a result. `adoptionFor`
   * decides, so the one case that must NOT adopt — this screen's own write,
   * re-rendering it with new params while somebody is mid-word — stays a rule
   * with a test rather than a condition buried in an effect.
   */
  useEffect(() => {
    const adoption = adoptionFor(queryOnUrl, writtenByUs.current);
    if (adoption.kind === 'NONE') return;

    writtenByUs.current = queryOnUrl;
    setQuery(adoption.query);
  }, [queryOnUrl]);

  /**
   * Debounced: the receptionist is typing, not submitting. The URL is written
   * on the same beat with `replace` rather than `push`, so eight keystrokes
   * leave one history entry and Back goes where they came from instead of
   * walking the word backwards one letter at a time.
   */
  useEffect(() => {
    const trimmed = query.trim();

    const t = setTimeout(() => {
      if (isSearchTerm(trimmed)) {
        if (lastSearched.current !== trimmed) {
          lastSearched.current = trimmed;
          void search(trimmed);
        }
      } else {
        lastSearched.current = null;
        setResults([]);
        setSearchState('idle');
      }

      const write = urlWriteFor(query, queryOnUrl);
      if (write.kind === 'WRITE') {
        // Recorded BEFORE the write, so the re-render it causes is not read
        // back as somebody else's search.
        writtenByUs.current = write.term;
        router.replace(write.href, { scroll: false });
      }
    }, 250);

    return () => clearTimeout(t);
  }, [query, queryOnUrl, search, router]);

  /**
   * The register, when nothing is being searched for.
   *
   * Not fetched at all while searching — the list underneath is replaced, not
   * filtered, so loading it would be a page of rows nobody will see.
   */
  useEffect(() => {
    if (searching) return;

    let cancelled = false;
    setList({ kind: 'loading' });

    void (async () => {
      try {
        const result = await api.allPatients(page);
        if (!cancelled) setList({ kind: 'loaded', ...result });
      } catch (err) {
        if (!cancelled) {
          setList({
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
  }, [page, searching]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-[24px] font-bold">Patients</h1>
          <p className="text-[13.5px] text-ink-60">
            {searching
              ? searchState === 'searching'
                ? 'Searching…'
                : searchState === 'done'
                  ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}`
                  : ''
              : list.kind === 'loaded'
                ? `${list.total.toLocaleString('en-IN')} registered`
                : 'Everyone registered here, newest first'}
          </p>
        </div>

        {can('patient:write') && (
          <Link href="/patients/register" className="btn-primary !py-1.5 !text-[13px]">
            <IconUserPlus size={15} />
            Register a patient
          </Link>
        )}
      </header>

      <label className="relative block">
        <span className="sr-only">Find a patient</span>
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-20">
          <IconSearch size={16} />
        </span>
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name, mobile, UHID or ABHA, e.g. Sharma · 9876543210 · SNC00042"
          className="field-input-icon"
          autoComplete="off"
          aria-describedby="search-status"
        />
      </label>

      {/* Spoken, not just drawn: a screen reader hears the count change rather
          than the table silently becoming a different table. */}
      <p id="search-status" className="sr-only" role="status" aria-live="polite">
        {searching && searchState === 'done' && `${results.length} matches for ${query.trim()}`}
        {searchState === 'error' && searchError}
      </p>

      {searchError && (
        <div role="alert" className="card p-4 text-[13.5px] text-coral-text">
          {searchError}
          {/* Said out loud, because a failed search no longer counts as one
              already made — the same name goes again on the next keystroke. */}
          <span className="mt-1 block text-ink-60">Type the name again to retry.</span>
        </div>
      )}

      {searching ? (
        <>
          {searchState === 'searching' && results.length === 0 && <PatientTableSkeleton />}

          {searchState === 'done' && results.length === 0 && (
            <div className="card flex flex-col items-center px-6 py-12 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-panel bg-ink/5 text-ink-20">
                <IconUsers size={22} />
              </span>
              <p className="mt-4 font-display text-[18px] font-bold">No patient matches</p>
              <p className="mt-1 max-w-sm text-[13.5px] text-ink-60">
                Nothing found for &ldquo;{query.trim()}&rdquo;. Check the spelling, or register them
                as a new patient.
              </p>
              {can('patient:write') && (
                <Link href="/patients/register" className="btn-primary mt-5">
                  <IconUserPlus size={16} />
                  Register a new patient
                </Link>
              )}
            </div>
          )}

          {results.length > 0 && (
            <>
              <PatientTable patients={results} />
              {/*
                SAID, NOT HIDDEN. Search comes back ranked and capped, so a name
                shared by thirty people shows the closest twenty-five and the
                other five are simply absent. A list that silently stops is how
                somebody concludes a patient was never registered.
              */}
              {results.length >= SEARCH_CAP && (
                <p className="field-hint !mt-0">
                  Showing the closest {SEARCH_CAP} matches. Add a mobile number or a UHID to narrow
                  it.
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <AllPatientsView state={list} canRegister={can('patient:write')} />
      )}
    </div>
  );
}
