'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, type FinanceReport } from '@/lib/api';
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

const SOURCE_LABELS: Record<string, string> = {
  INTERNAL: 'Our own doctors',
  EXTERNAL_DOCTOR: 'Sent by an outside doctor',
  SELF: 'Walked in and asked',
};

/**
 * The finance desk's report — FR-FIN-03, as amended by FR-DIA-15.
 *
 * The API has served this since the finance desk was built; nothing rendered
 * it, so the only reporting screen was the day's collections. Every figure
 * below already existed server-side.
 *
 * THE TWO TABLES IN THE MIDDLE ARE NOT THE SAME TABLE TWICE. `By doctor` is
 * anchored on the practitioner, and a walk-in test patient never meets one —
 * their money lands under "not attributed" and the department that earned it
 * looks idle. `By department` is anchored on the charge, which is where the
 * work actually happened. A clinic selling tests needs both.
 */
export default function FinanceReportPage() {
  const [from, setFrom] = useState(clinicToday());
  const [to, setTo] = useState(clinicToday());
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    try {
      setReport(await api.financeReport(start, end));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the report.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(from, to);
  }, [from, to, load]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Billing</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">Finance report</h1>
          <p className="mt-1 text-[14px] text-ink-60">
            Billed, discounted and collected over a range — by doctor, by department, and by where
            the work came from.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="from" className="field-label">
              From
            </label>
            <input
              id="from"
              type="date"
              className="field-input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="to" className="field-label">
              To
            </label>
            <input
              id="to"
              type="date"
              className="field-input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-secondary !px-3"
            onClick={() => void load(from, to)}
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
            <Stat label="Collected" value={formatPaise(report.collections.collectedPaise)} />
            <Stat
              label="Refunded"
              value={
                report.collections.refundedPaise > 0
                  ? `− ${formatPaise(report.collections.refundedPaise)}`
                  : '—'
              }
              {...(report.collections.refundedPaise > 0 ? { tone: 'coral' as const } : {})}
            />
            <Stat label="Net" value={formatPaise(report.collections.netPaise)} tone="green" />
            <Stat
              label="Still owed"
              value={formatPaise(report.outstanding.totalPaise)}
              {...(report.outstanding.totalPaise > 0 ? { tone: 'amber' as const } : {})}
            />
          </div>

          <section className="card p-5">
            <p className="mono-label">By doctor</p>
            <Table
              head={['Doctor', 'Patients', 'Visits', 'Billed', 'Discount', 'Collected']}
              rows={report.byDoctor.map((d) => [
                d.name,
                String(d.patientsSeen),
                String(d.visits),
                formatPaise(d.netBilledPaise),
                d.discountPaise > 0 ? `− ${formatPaise(d.discountPaise)}` : '—',
                formatPaise(d.netCollectedPaise),
              ])}
              empty="Nothing billed in this range."
            />
          </section>

          {/* Guarded against a browser bundle newer than the API it is talking
              to — see the note on the type. The section is ABSENT rather than
              empty, because "this server does not send it" and "nothing was
              billed" are different facts and must not look alike. */}
          {report.byDepartment && (
            <section className="card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="mono-label">By department</p>
                <p className="text-[12.5px] text-ink-40">
                  Billed {formatPaise(report.byDepartment.totalBilledPaise)} · collected{' '}
                  {formatPaise(report.byDepartment.collectedPaise)}
                </p>
              </div>

              <Table
                head={['Department', 'Patients', 'Items', 'Billed', 'Discount']}
                rows={report.byDepartment.rows.map((d) => [
                  d.name,
                  String(d.patientsSeen),
                  String(d.items),
                  formatPaise(d.netBilledPaise),
                  d.discountPaise > 0 ? `− ${formatPaise(d.discountPaise)}` : '—',
                ])}
                empty="Nothing billed in this range."
              />

              {/*
              Said on the screen, not just in the code. A reader who sees
              department billing and no department collection will otherwise
              assume the number is missing rather than deliberately absent.
            */}
              <p className="field-hint mt-3">
                There is no collected figure per department, and that is deliberate. A patient pays
                one bill, not a share to each department — splitting it back out would mean
                inventing an allocation. The collected total above is for the whole clinic.
              </p>
            </section>
          )}

          {report.byReferralSource && (
            <section className="card p-5">
              <p className="mono-label">Where the diagnostic work came from</p>
              <Table
                head={['Source', 'Patients', 'Tests', 'Billed']}
                rows={report.byReferralSource.map((r) => [
                  SOURCE_LABELS[r.source] ?? r.source,
                  String(r.patients),
                  String(r.tests),
                  formatPaise(r.netBilledPaise),
                ])}
                empty="No tests ordered in this range."
              />

              {/* Who to thank, and eventually who to call. */}
              {report.byReferralSource
                .filter((r) => r.referrers.length > 0)
                .map((r) => (
                  <div key={r.source} className="mt-4">
                    <p className="field-label">Doctors who sent work</p>
                    <ul className="space-y-1.5">
                      {r.referrers.map((ref) => (
                        <li
                          key={ref.name}
                          className="flex items-center justify-between gap-3 rounded-panel border border-ink/10 bg-white px-3 py-2 text-[13px]"
                        >
                          <span>
                            {ref.name}
                            <span className="ml-2 text-ink-40">
                              {ref.tests} {ref.tests === 1 ? 'test' : 'tests'}
                            </span>
                          </span>
                          <span className="font-mono tabular-nums">
                            {formatPaise(ref.netBilledPaise)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </section>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="card p-5">
              <p className="mono-label">Discounts</p>
              <dl className="mt-3 space-y-1.5 text-[13.5px]">
                <Line
                  label={`Given (${report.discounts.givenCount})`}
                  value={formatPaise(report.discounts.givenPaise)}
                />
                {/* Applied and then taken back. NOT part of "given" — the
                    clinic gave that money away for a moment and got it back. */}
                <Line
                  label={`Taken back (${report.discounts.reversedCount})`}
                  value={formatPaise(report.discounts.reversedPaise)}
                />
              </dl>

              {report.discounts.byPromotion.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {report.discounts.byPromotion.map((p) => (
                    <li
                      key={p.code}
                      className="flex items-center justify-between gap-3 rounded-panel border border-ink/10 bg-white px-3 py-2 text-[13px]"
                    >
                      <span className="font-mono">{p.code}</span>
                      <span className="tabular-nums">
                        {p.count} · {formatPaise(p.discountPaise)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card p-5">
              <p className="mono-label">Owed, and money that went back</p>
              <dl className="mt-3 space-y-1.5 text-[13.5px]">
                <Line
                  label={`Unpaid (${report.outstanding.count})`}
                  value={formatPaise(report.outstanding.totalPaise)}
                />
                <Line
                  label={`Deferred (${report.outstanding.deferred.count})`}
                  value={formatPaise(report.outstanding.deferred.totalPaise)}
                />
                <Line
                  label="Refunded to patients"
                  value={formatPaise(report.refundsAndReversals.patientRefundedPaise)}
                />
                {/* A different thing from a refund: money that was never
                    really taken, corrected out of the books. */}
                <Line
                  label="Recorded in error"
                  value={formatPaise(report.refundsAndReversals.recordedInErrorPaise)}
                />
              </dl>
            </section>
          </div>
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
  tone?: 'green' | 'amber' | 'coral';
}) {
  const ring =
    tone === 'green'
      ? 'border-green/30 bg-green-soft/40'
      : tone === 'amber'
        ? 'border-amber/30 bg-amber-soft/40'
        : tone === 'coral'
          ? 'border-coral/30 bg-coral/8'
          : 'border-ink/10 bg-white';

  return (
    <div className={`rounded-card border p-4 ${ring}`}>
      <p className="mono-label">{label}</p>
      <p className="mt-1 font-display text-[22px] font-bold tabular-nums">{value}</p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-60">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

/** Wide content scrolls inside its own box rather than the page. */
function Table({ head, rows, empty }: { head: string[]; rows: string[][]; empty: string }) {
  if (rows.length === 0) return <p className="field-hint mt-2">{empty}</p>;

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                className={`mono-label border-b border-ink/10 pb-1.5 ${i === 0 ? 'text-left' : 'text-right'}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td
                  key={i}
                  className={`border-b border-ink/6 py-2 ${
                    i === 0 ? 'text-left' : 'text-right font-mono tabular-nums'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
