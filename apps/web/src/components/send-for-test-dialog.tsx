'use client';

import { useEffect, useState } from 'react';
import { api, ApiRequestError, type DayBoardRow, type DiagnosticTest } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { IconAlert, IconSearch } from '@/components/icons';

/**
 * Sending a patient for a test, from the day board.
 *
 * The doctor finishes with somebody and sends them for an X-ray without opening
 * the consultation again. Two things happen together, and they have to:
 *
 *   the ORDER is created, which raises the charge in the same transaction —
 *   see `diagnostics.service`: "an order with no charge walks straight through
 *   the pay-first gate"
 *
 *   the patient is SENT OUT of the room, so they leave the waiting list and
 *   appear under "At a department" rather than vanishing off the board
 *
 * **Only priced catalogue tests are offered here.** A free-text order raises no
 * charge at all — the clinic has no price for it — and on a screen whose whole
 * point is that the fee is collected first, an option that silently bills
 * nothing is the wrong thing to offer. Free text stays inside the consultation,
 * where choosing it is deliberate.
 *
 * **The patient is not sent out unless they were with the doctor.** Ordering a
 * test for somebody still in the waiting list should not pull them out of it —
 * they have not been seen yet.
 */
export function SendForTestDialog({
  row,
  onClose,
  onSent,
}: {
  row: DayBoardRow;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [tests, setTests] = useState<DiagnosticTest[] | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<DiagnosticTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setTests((await api.diagnosticCatalogue()).tests);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the tests.');
      }
    })();
  }, []);

  const needle = query.trim().toLowerCase();
  const shown = (tests ?? []).filter(
    (t) =>
      !needle ||
      t.name.toLowerCase().includes(needle) ||
      t.code.toLowerCase().includes(needle) ||
      t.department.name.toLowerCase().includes(needle),
  );

  async function send() {
    if (!chosen || !row.appointmentId) return;
    setBusy(true);
    setError(null);

    try {
      await api.raiseDiagnosticOrder({
        appointmentId: row.appointmentId,
        departmentId: chosen.department.id,
        serviceId: chosen.id,
        description: chosen.name,
        referralSource: 'INTERNAL',
      });

      // Out of the room only if they were in it. Ordered from the waiting list,
      // the patient keeps their place.
      if (row.bucket === 'WITH_DOCTOR') {
        await api.sendForTests(row.appointmentId, chosen.name);
      }

      onSent(
        `${row.patient.name} sent to ${chosen.department.name} for ${chosen.name}. ` +
          `${formatPaise(chosen.pricePaise)} has been added to their bill — the department ` +
          `cannot start until it is paid.`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not send them.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Send ${row.patient.name} for a test`}
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden">
        <div className="border-b border-ink/8 px-6 py-4">
          <p className="mono-label">Send for a test</p>
          <h2 className="mt-1 font-display text-[20px] font-bold">{row.patient.name}</h2>
          <p className="field-hint">
            <span className="font-mono">{row.patient.uhid}</span>
            {row.withWhom ? ` · ${row.withWhom}` : ''}
          </p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3 py-2 text-[12.5px] text-coral-text"
            >
              <span className="mt-0.5 shrink-0">
                <IconAlert size={13} />
              </span>
              <span>{error}</span>
            </div>
          )}

          <label className="relative block">
            <span className="sr-only">Find a test</span>
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-20">
              <IconSearch size={14} />
            </span>
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="X-ray, blood, department…"
              className="field-input !py-2 !pl-9"
            />
          </label>

          {tests === null ? (
            <p className="field-hint">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="field-hint">
              {tests.length === 0
                ? 'No tests are priced yet. Add them under Settings → Prices, with a department.'
                : `Nothing matches “${query.trim()}”.`}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {shown.map((t) => {
                const on = chosen?.id === t.id;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setChosen(t)}
                      className={[
                        'flex w-full flex-wrap items-center justify-between gap-2 rounded-panel border-[1.5px] px-3.5 py-2.5 text-left transition-colors',
                        on
                          ? 'border-clinical bg-clinical-tint'
                          : 'border-ink/10 bg-white hover:border-ink/25',
                      ].join(' ')}
                    >
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-semibold">{t.name}</span>
                        <span className="block text-[11.5px] text-ink-40">
                          {t.department.name} · <span className="font-mono">{t.code}</span>
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums">
                        {formatPaise(t.pricePaise)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/8 bg-bg-soft px-6 py-4">
          {/* Said before the press. The charge is raised with the order, and the
              department is blocked until it clears — so this button is the
              moment money starts being owed. */}
          <p className="text-[12px] text-ink-40">
            {chosen
              ? `${formatPaise(chosen.pricePaise)} will be added to their bill.`
              : 'Pick a test.'}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!chosen || busy}
              onClick={() => void send()}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
