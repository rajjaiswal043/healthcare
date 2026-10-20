import Link from 'next/link';
import type { PatientSummary } from '@/lib/api';
import { formatAge, genderInitial } from '@/lib/format';

/**
 * A list of patients, one row each — the table behind "Find a patient" and
 * "All patients" alike.
 *
 * One component on purpose. The two screens ask different questions (who
 * matches what I typed, who is registered here at all) and must give the same
 * answer to the one that matters: what a patient row IS, and where clicking it
 * goes. Two copies of this table would have drifted the first time a column was
 * added to one of them, and "the all-patients list shows ABHA differently
 * from search" is exactly the kind of difference nobody notices until a receptionist
 * does.
 *
 * Selecting a patient is a plain link to `/patients/[id]`, from either screen —
 * the same page, the same data, fetched by id. Nothing about how the row was
 * found travels with it, which is what makes the detail view identical
 * regardless of the list it was opened from.
 */
export function PatientTable({ patients }: { patients: PatientSummary[] }) {
  return (
    <div className="card overflow-hidden">
      {/*
        PHONE FIRST, THEN THE TABLE.

        Six columns in a sideways scroll is a poor way to find a person on a
        390px screen, and finding a person is the entire job of this component.
        Below `md` each patient is a card, and the WHOLE card is the link — a
        name is a small target for a thumb, and the row already means "open
        this patient".

        The table's markup is unchanged and simply hidden, so a desk renders
        exactly what it rendered before. Both halves read the same `patients`
        array, which is what keeps the promise this file is named for.
      */}
      <ul className="divide-y divide-ink/6 md:hidden">
        {patients.map((p) => (
          <li key={p.id}>
            <Link
              href={`/patients/${p.id}`}
              className="flex items-start justify-between gap-3 px-4 py-3.5 transition-colors active:bg-clinical-tint"
            >
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-semibold text-ink">{p.name}</span>
                <span className="mt-0.5 block text-[12.5px] text-ink-40">
                  <span className="font-mono">{p.uhid}</span>
                  {' · '}
                  {formatAge(p)} {genderInitial(p.gender)}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-ink-60">
                  <span className="font-mono">{p.mobile}</span>
                  {p.city ? ` · ${p.city}` : ''}
                </span>
              </span>

              <span className="shrink-0">
                {p.abhaNumber ? (
                  <span className="badge-clinical">linked</span>
                ) : (
                  <span className="badge-neutral">not linked</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-b border-ink/8 bg-bg-soft text-left">
              <Th>UHID</Th>
              <Th>Name</Th>
              <Th>Age / Sex</Th>
              <Th>Mobile</Th>
              <Th>City</Th>
              <Th>ABHA</Th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => (
              <tr
                key={p.id}
                className="border-b border-ink/6 transition-colors last:border-0 hover:bg-clinical-tint/60"
              >
                <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-60">
                  {p.uhid}
                </td>
                <td className="px-4 py-3">
                  {/* The name is the link. A separate "view" column would add a
                      click target for the thing the whole row already means. */}
                  <Link
                    href={`/patients/${p.id}`}
                    className="font-semibold text-ink underline-offset-2 hover:text-clinical-text hover:underline"
                  >
                    {p.name}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-ink-60">
                  {formatAge(p)} · {genderInitial(p.gender)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-60">
                  {p.mobile}
                </td>
                <td className="px-4 py-3 text-ink-60">{p.city ?? '—'}</td>
                <td className="px-4 py-3">
                  {p.abhaNumber ? (
                    <span className="badge-clinical">linked</span>
                  ) : (
                    <span className="badge-neutral">not linked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="mono-label px-4 py-2.5">
      {children}
    </th>
  );
}

/** The loading state for a patient table — shared for the same reason the table is. */
export function PatientTableSkeleton() {
  return (
    <div className="card overflow-hidden p-4">
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-4">
            <div className="skeleton h-4 w-20" />
            <div className="skeleton h-4 flex-1" />
            <div className="skeleton h-4 w-16" />
            <div className="skeleton h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
