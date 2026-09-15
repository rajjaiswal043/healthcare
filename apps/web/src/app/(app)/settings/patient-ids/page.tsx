'use client';

import { useEffect, useState } from 'react';
import { api, ApiRequestError, type PatientIdFormat } from '@/lib/api';
import { formatUhid } from '@/lib/uhid-format';
import { IconAlert } from '@/components/icons';

/**
 * Settings → Patient IDs (FR-UID-02).
 *
 * Answers one question an administrator otherwise has to ask us: what do our
 * patient numbers look like? Prefix, width, an example, how many have been
 * issued, and what the next one will be.
 *
 * Read-only, and it says so rather than just lacking a button. Changing the
 * format is the platform's job (decision D3): it looks like a harmless setting,
 * it has permanent consequences, and there is no undo — so a clinic that wants
 * it changed should have to say so out loud to somebody.
 */
export default function PatientIdsPage() {
  const [format, setFormat] = useState<PatientIdFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setFormat(await api.patientIdFormat());
      } catch (err) {
        setError(
          err instanceof ApiRequestError
            ? err.error.message
            : 'Could not load the patient ID format.',
        );
      }
    })();
  }, []);

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-2 font-display text-[30px] font-bold">Patient IDs</h1>
        <p className="mt-1 max-w-[62ch] text-[14px] text-ink-60">
          The number every patient is given at registration, as it appears on their card, bills,
          prescriptions and reports.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3.5 py-2.5 text-[13px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={14} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {!format && !error && <p className="text-[14px] text-ink-60">Loading…</p>}

      {format && (
        <>
          <section className="card p-6">
            <p className="mono-label">The next patient registered will be</p>
            <p className="mt-1 font-mono text-[32px] font-semibold tracking-wide">{format.next}</p>

            <dl className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <Detail label="Prefix" value={format.prefix} mono />
              <Detail label="Number width" value={`${format.width} digits`} />
              <Detail label="First ID in this format" value={format.example} mono />
              <Detail label="Issued so far" value={format.issued.toLocaleString('en-IN')} />
            </dl>

            {/* The width is a minimum, which is the part people get wrong in
                their heads — the same sentence the platform sees when it sets it. */}
            <p className="mt-5 text-[12.5px] text-ink-40">
              Longer numbers are written in full — patient{' '}
              {(10 ** format.width).toLocaleString('en-IN')} will be{' '}
              <span className="font-mono">
                {formatUhid(format.prefix, format.width, 10 ** format.width)}
              </span>
              .
            </p>
          </section>

          {/* Why it is read-only, said where the missing control would be. */}
          <section className="rounded-panel border border-ink/10 bg-bg-soft px-5 py-4 text-[13.5px]">
            <p className="font-semibold">Need a different format?</p>
            <p className="mt-1 text-ink-60">
              Ask platform support — it cannot be changed from here. Patients already registered
              keep their existing IDs; a change applies to new registrations only, and numbering
              carries on rather than starting again.
            </p>
          </section>

          {format.lastChanged && (
            <section className="card p-6">
              <p className="mono-label">Last changed</p>
              <p className="mt-1 text-[14px]">
                {new Date(format.lastChanged.at).toLocaleString('en-IN', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}{' '}
                by {format.lastChanged.by}
              </p>
              {format.lastChanged.reason && (
                <p className="mt-2 whitespace-pre-wrap text-[13px] text-ink-60">
                  {format.lastChanged.reason}
                </p>
              )}
              {/* The reason a clinic opens this section: cards in two formats. */}
              <p className="mt-3 text-[12.5px] text-ink-40">
                Patients registered before this change keep the IDs they were given, so older cards
                may show the earlier format.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="field-label !mb-0.5">{label}</dt>
      <dd className={`m-0 text-[15px] ${mono ? 'font-mono font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}
