import Link from 'next/link';
import type { PatientSummary } from '@/lib/api';
import { pageCount } from '@/lib/pagination';
import { IconUserPlus, IconUsers } from './icons';
import { Pagination } from './pagination';
import { PatientTable, PatientTableSkeleton } from './patient-table';

export type AllPatientsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'loaded';
      patients: PatientSummary[];
      page: number;
      pageSize: number;
      total: number;
    };

/** Where page `n` of this list lives. Page 1 is the bare route. */
export function allPatientsHref(page: number): string {
  return page <= 1 ? '/patients/all' : `/patients/all?page=${page}`;
}

const count = (n: number) => n.toLocaleString('en-IN');

/**
 * What the all-patients screen shows, given what the server answered.
 *
 * Separate from the page so it can be rendered on its own — the page reads the
 * URL and fetches, this draws — and so each state is one branch rather than a
 * tangle of flags.
 */
export function AllPatientsView({
  state,
  canRegister,
}: {
  state: AllPatientsState;
  canRegister: boolean;
}) {
  if (state.kind === 'loading') return <PatientTableSkeleton />;

  if (state.kind === 'error') {
    return (
      <div role="alert" className="card p-4 text-[13.5px] text-coral-text">
        {state.message}
      </div>
    );
  }

  const { patients, page, pageSize, total } = state;
  const totalPages = pageCount(total, pageSize);

  if (total === 0) {
    return (
      <div className="card flex flex-col items-center px-6 py-12 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-panel bg-ink/5 text-ink-20">
          <IconUsers size={22} />
        </span>
        <p className="mt-4 font-display text-[18px] font-bold">No patients yet</p>
        <p className="mt-1 max-w-sm text-[13.5px] text-ink-60">
          Nobody has been registered at this clinic so far.
        </p>
        {canRegister && (
          <Link href="/patients/register" className="btn-primary mt-5">
            <IconUserPlus size={16} />
            Register a patient
          </Link>
        )}
      </div>
    );
  }

  /**
   * Past the last page — decision (d). This happens for real: somebody
   * bookmarks the last page, a patient is deactivated, and that page is now
   * empty. An error would be wrong (nothing failed) and an empty table would be
   * a dead end, so say which page is last and link to it.
   */
  if (patients.length === 0) {
    return (
      <div className="card flex flex-col items-center px-6 py-12 text-center" role="status">
        <p className="font-display text-[18px] font-bold">There is no page {count(page)}</p>
        <p className="mt-1 max-w-sm text-[13.5px] text-ink-60">
          {count(total)} {total === 1 ? 'patient fits' : 'patients fit'} on{' '}
          {totalPages === 1 ? '1 page' : `${count(totalPages)} pages`}. The last page is{' '}
          {count(totalPages)}.
        </p>
        <Link href={allPatientsHref(totalPages)} className="btn-secondary mt-5">
          Go to page {count(totalPages)}
        </Link>
      </div>
    );
  }

  const first = (page - 1) * pageSize + 1;
  const last = first + patients.length - 1;

  return (
    <div className="space-y-3">
      <p className="field-hint" role="status">
        Showing {count(first)}–{count(last)} of {count(total)}
      </p>
      <PatientTable patients={patients} />
      <Pagination
        page={page}
        totalPages={totalPages}
        hrefFor={allPatientsHref}
        label="Patient list pages"
      />
    </div>
  );
}
