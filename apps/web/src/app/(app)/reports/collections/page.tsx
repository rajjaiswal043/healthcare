'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, type DayCollection } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { IconAlert, IconRefresh } from '@/components/icons';

/** Clinic-local YYYY-MM-DD. The report is a clinic day, not a UTC one. */
function clinicToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const MODE_LABELS: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
};

/**
 * What the clinic took today.
 *
 * This page gets read against a physical cash drawer at closing time, which is
 * the reason the cash figure is called out on its own: everything else has a
 * bank record behind it, and cash is the only number somebody has to count.
 */
export default function CollectionsPage() {
  const [date, setDate] = useState(clinicToday());
  const [report, setReport] = useState<DayCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (day: string) => {
    setLoading(true);
    try {
      setReport(await api.dayCollection(day));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not load the collections.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const cash = report?.byMode.find((m) => m.mode === 'CASH');

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Billing</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">Collections</h1>
          <p className="mt-1 text-[14px] text-ink-60">
            What came in, by mode and by who took it. Count the drawer against the cash line.
          </p>
        </div>

        <div className="flex items-end gap-2">
          <div>
            <label htmlFor="date" className="field-label">
              Day
            </label>
            <input
              id="date"
              type="date"
              className="field-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-secondary !px-3"
            onClick={() => void load(date)}
            aria-label="Refresh"
            title="Refresh"
          >
            <IconRefresh size={16} />
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-coral/30 bg-coral/8 p-3 text-[13.5px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={15} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {loading && !report && <p className="text-[14px] text-ink-60">Loading…</p>}

      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Collected" value={formatPaise(report.collectedPaise)} />
            <Stat
              label="Refunded"
              value={report.refundedPaise > 0 ? `− ${formatPaise(report.refundedPaise)}` : '—'}
              // Spread rather than a ternary to undefined: exactOptionalPropertyTypes
              // treats "absent" and "explicitly undefined" as different things.
              {...(report.refundedPaise > 0 ? { tone: 'coral' as const } : {})}
            />
            <Stat label="Net" value={formatPaise(report.netPaise)} tone="green" />
            <Stat
              label="Cash to count"
              value={formatPaise(cash?.netPaise ?? 0)}
              /* The only figure with no bank record behind it. */
              tone="amber"
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="card p-5">
              <p className="mono-label">By mode</p>
              {report.byMode.length === 0 ? (
                <p className="field-hint mt-2">Nothing collected.</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {report.byMode.map((m) => (
                    <li
                      key={m.mode}
                      className="flex items-center justify-between gap-3 rounded-panel border border-ink/10 bg-white px-3 py-2 text-[13px]"
                    >
                      <span>{MODE_LABELS[m.mode] ?? m.mode}</span>
                      <span className="text-right">
                        <span className="block font-mono font-semibold">
                          {formatPaise(m.netPaise)}
                        </span>
                        {m.refundedPaise > 0 && (
                          <span className="block font-mono text-[11px] text-ink-40">
                            {formatPaise(m.collectedPaise)} in, {formatPaise(m.refundedPaise)} back
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card p-5">
              <p className="mono-label">By collector</p>
              {report.byCollector.length === 0 ? (
                <p className="field-hint mt-2">Nobody collected anything.</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {report.byCollector.map((c) => (
                    <li
                      key={c.userId}
                      className="flex items-center justify-between gap-3 rounded-panel border border-ink/10 bg-white px-3 py-2 text-[13px]"
                    >
                      <span>{c.name}</span>
                      <span className="font-mono font-semibold">{formatPaise(c.netPaise)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="card overflow-hidden">
            <div className="flex items-baseline justify-between gap-3 border-b border-ink/8 bg-bg-soft px-5 py-3">
              <p className="mono-label">Transactions</p>
              <p className="text-[11.5px] text-ink-40">{report.transactionCount} recorded</p>
            </div>

            {report.transactions.length === 0 ? (
              <p className="field-hint px-5 py-6">No money moved on this day.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-ink/8 text-left">
                      <Th>Time</Th>
                      <Th>Patient</Th>
                      <Th>Invoice</Th>
                      <Th>Mode</Th>
                      <Th>Taken by</Th>
                      <Th>Amount</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.transactions.map((t, i) => (
                      <tr
                        key={`${t.invoiceNumber}-${i}`}
                        className="border-b border-ink/6 last:border-0"
                      >
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[12px] text-ink-60">
                          {new Date(t.collectedAt).toLocaleTimeString('en-IN', {
                            timeStyle: 'short',
                          })}
                        </td>
                        <td className="px-4 py-2.5">
                          {t.patient.name}
                          <span className="block font-mono text-[11px] text-ink-40">
                            {t.patient.uhid}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[12px] text-ink-60">
                          {t.invoiceNumber}
                        </td>
                        <td className="px-4 py-2.5 text-ink-60">{MODE_LABELS[t.mode] ?? t.mode}</td>
                        <td className="px-4 py-2.5 text-ink-60">{t.collectedBy}</td>
                        <td
                          className={`whitespace-nowrap px-4 py-2.5 text-right font-mono font-semibold ${
                            t.direction === 'REFUND' ? 'text-coral-text' : ''
                          }`}
                        >
                          {t.direction === 'REFUND' ? '−' : ''}
                          {formatPaise(t.amountPaise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'coral' | 'green' | 'amber';
}) {
  return (
    <div className="card-flat px-4 py-3">
      <p className="mono-label">{label}</p>
      <p
        className={[
          'mt-1 font-display text-[22px] font-bold',
          tone === 'coral' ? 'text-coral-text' : '',
          tone === 'green' ? 'text-green-text' : '',
          tone === 'amber' ? 'text-amber-text' : '',
        ].join(' ')}
      >
        {value}
      </p>
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
