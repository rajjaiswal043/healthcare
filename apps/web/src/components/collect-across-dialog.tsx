'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, type CollectedAcrossBills, type Invoice } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { formatPaise, parseRupeesToPaise } from '@/lib/format';
import { ReceiptButton } from './receipt-button';
import { IconAlert, IconCheck, IconX } from './icons';

/** The same tenders, in the same order, as the single-bill dialog. */
const MODES = [
  { key: 'CASH', label: 'Cash' },
  { key: 'UPI', label: 'UPI' },
  { key: 'CARD', label: 'Card' },
  { key: 'BANK_TRANSFER', label: 'Bank transfer' },
  { key: 'OTHER', label: 'Other' },
];

/**
 * ONE HANDOVER OF MONEY, SEVERAL BILLS.
 *
 * Reported from the clinic on 29 Oct 2026: a patient seeing three doctors had
 * three bills, and the desk ran the Collect dialog three times while they stood
 * there. The board could only ever open the oldest, which is why its button
 * read "1 of 3".
 *
 * SEPARATE FROM `PaymentDialog` on purpose, not a second skin of it. That one
 * is built around a single invoice and also carries discounts, waivers and
 * deferrals — all of which are per-bill decisions that mean nothing spread
 * across three. Threading an optional list through it would have made every one
 * of those panels ask "which bill?" in four screens that are working correctly
 * today. So this does the one thing the desk asked for, in the same shell and
 * with the same inputs, and per-bill work stays on the finance desk and the
 * patient record where the bill is the subject.
 *
 * The money fills the OLDEST bill first — Narveer's call, 29 Oct 2026 — so a
 * part payment finishes bills instead of leaving all of them open. The server
 * does the allocating; this only says how much was handed over.
 */
export function CollectAcrossDialog({
  patient,
  invoiceIds,
  duePaise,
  onClose,
  onCollected,
}: {
  patient: { id: string; name: string; uhid: string };
  /** The bills to settle, oldest first, as the board listed them. */
  invoiceIds: string[];
  /** What they come to together — the figure in the row's Due column. */
  duePaise: number;
  onClose: () => void;
  /** Called once money has actually moved, so the board can reload. */
  onCollected: () => void;
}) {
  const { can } = useAuth();

  const [bills, setBills] = useState<Invoice[] | null>(null);
  const [mode, setMode] = useState('CASH');
  const [amount, setAmount] = useState(() => (duePaise / 100).toFixed(2));
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CollectedAcrossBills | null>(null);
  /** Re-read after collecting, so each row can offer its own receipt. */
  const [settled, setSettled] = useState<Invoice[]>([]);

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  /*
   * The bills themselves, for the breakdown.
   *
   * The board already sent the total, so this is not what the amount is based
   * on — it is so the desk can see WHICH bills the money is about before taking
   * it. A patient disputing one of three is the case that matters.
   */
  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const loaded = await Promise.all(invoiceIds.map((id) => api.invoice(id)));
        if (alive) setBills(loaded);
      } catch {
        // Not fatal: the total came from the board and the server re-reads every
        // balance under lock anyway. Collecting stays available without it.
        if (alive) setBills([]);
      }
    })();

    return () => {
      alive = false;
    };
  }, [invoiceIds]);

  const amountPaise = parseRupeesToPaise(amount);
  const canCollect = can('payment:collect');

  async function collect() {
    if (amountPaise === null || amountPaise <= 0) {
      setError('Enter how much is being paid.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await api.collectAcrossBills(patient.id, {
        mode,
        amountPaise,
        invoiceIds,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });

      setDone(result);

      /*
       * Re-read only the bills that took money, so `ReceiptButton` has the
       * payment it needs. One receipt per bill is the rule here — three bills
       * means three slips — so there is one button per row rather than one for
       * the handover.
       */
      try {
        setSettled(await Promise.all(result.allocated.map((a) => api.invoice(a.invoiceId))));
      } catch {
        // The money is recorded either way; only the print shortcut is missing.
        setSettled([]);
      }

      onCollected();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not record that payment.',
      );
    } finally {
      setBusy(false);
    }
  }

  const billCount = bills?.length ?? invoiceIds.length;

  return (
    <div
      /* `!m-0` as in PaymentDialog — the page's `space-y-*` otherwise gives this
         fixed backdrop a top margin and leaves a live strip across the screen. */
      className="fixed inset-0 z-[60] !m-0 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collect-across-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose();
        }}
        className="scrollbar-quiet max-h-full w-full max-w-lg overflow-y-auto rounded-t-card-lg border border-ink/10 bg-card shadow-lg outline-none sm:rounded-card-lg"
      >
        <header className="flex items-start justify-between gap-3 border-b border-ink/8 bg-bg-soft px-5 py-4">
          <div>
            <p className="mono-label">
              {done ? 'Payment recorded' : `Collect ${billCount} bills together`}
            </p>
            <h2 id="collect-across-title" className="mt-1 font-display text-[19px] font-bold">
              {patient.name}
            </h2>
            <p className="text-[12.5px] text-ink-60">
              <span className="font-mono">{patient.uhid}</span>
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost !px-1.5 !py-1.5"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <IconX size={17} />
          </button>
        </header>

        <div className="space-y-5 px-5 py-4">
          {error && (
            <p className="flex items-start gap-2 rounded-tiny bg-danger/8 px-3 py-2 text-[12.5px] text-danger">
              <IconAlert size={14} />
              {error}
            </p>
          )}

          {done ? (
            /* WHAT ACTUALLY HAPPENED, bill by bill. The desk handed over one
               amount; this says where each part of it went, because that is
               what the patient will ask about. */
            <section>
              <p className="flex items-center gap-2 text-[13px] font-semibold text-clinical">
                <IconCheck size={15} />
                {formatPaise(done.collectedPaise)} taken
                {done.billsSettled > 0 &&
                  ` · ${done.billsSettled} ${done.billsSettled === 1 ? 'bill' : 'bills'} settled`}
              </p>

              <ul className="mt-3 space-y-1.5">
                {done.allocated.map((a) => {
                  const invoice = settled.find((i) => i.id === a.invoiceId) ?? null;

                  return (
                    <li
                      key={a.invoiceId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-tiny border border-ink/8 bg-bg-soft px-3 py-2"
                    >
                      <span className="text-[12.5px]">
                        <span className="font-mono">{a.invoiceNumber}</span>
                        <span className="ml-2 font-mono tabular-nums font-semibold">
                          {formatPaise(a.amountPaise)}
                        </span>
                        {a.balancePaise > 0 && (
                          <span className="ml-2 text-ink-60">
                            {formatPaise(a.balancePaise)} still due
                          </span>
                        )}
                      </span>

                      {invoice && (
                        <ReceiptButton
                          invoice={invoice}
                          className="btn-secondary !px-2.5 !py-1 !text-[12px]"
                        />
                      )}
                    </li>
                  );
                })}
              </ul>

              {done.outstandingAfterPaise > 0 && (
                <p className="field-hint mt-2">
                  {formatPaise(done.outstandingAfterPaise)} is still outstanding. The oldest bill
                  was filled first.
                </p>
              )}

              <button type="button" className="btn-primary mt-4 w-full" onClick={onClose}>
                Done
              </button>
            </section>
          ) : (
            <>
              {/* WHICH BILLS, before any money is taken. */}
              <section>
                <p className="mono-label mb-2">Bills owing</p>

                {bills === null ? (
                  <p className="field-hint">Loading the bills…</p>
                ) : bills.length === 0 ? (
                  <p className="field-hint">
                    Could not list the bills. The total above is the one the board showed, and the
                    server checks every balance again before taking anything.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {bills.map((b) => (
                      <li
                        key={b.id}
                        className="flex items-center justify-between gap-2 rounded-tiny border border-ink/8 bg-bg-soft px-3 py-2 text-[12.5px]"
                      >
                        <span className="font-mono">{b.number}</span>
                        <span className="font-mono tabular-nums">
                          {formatPaise(b.balancePaise)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="mt-2 flex items-center justify-between border-t border-ink/8 pt-2 text-[13px] font-semibold">
                  <span>Total due</span>
                  <span className="font-mono tabular-nums">{formatPaise(duePaise)}</span>
                </p>
              </section>

              {canCollect && (
                <section>
                  <p className="mono-label mb-2">Payment</p>

                  <div className="flex flex-wrap gap-1.5">
                    {MODES.map((m) => (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => setMode(m.key)}
                        aria-pressed={mode === m.key}
                        className={[
                          'rounded-pill border-[1.5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                          mode === m.key
                            ? 'border-clinical bg-clinical text-white'
                            : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25 hover:text-ink',
                        ].join(' ')}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="field-label">Amount ₹</span>
                      <input
                        className="field-input mt-1 font-mono"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                    </label>

                    <label className="block">
                      <span className="field-label">Reference</span>
                      <input
                        className="field-input mt-1"
                        placeholder={mode === 'UPI' ? 'UPI transaction id' : 'Optional'}
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        maxLength={120}
                      />
                    </label>
                  </div>

                  {/* Part payment is ordinary. Saying WHERE it goes matters here
                      in a way it does not on a single bill: the desk is about
                      to settle two of three and should know that before the
                      patient does. */}
                  <p className="field-hint mt-1.5">
                    Taking part of it is fine — it fills the oldest bill first, then the next.
                  </p>

                  <button
                    type="button"
                    className="btn-primary mt-3 w-full"
                    disabled={busy || amountPaise === null || amountPaise <= 0}
                    onClick={() => void collect()}
                  >
                    {busy ? 'Recording…' : `Take ${formatPaise(amountPaise ?? 0)}`}
                  </button>
                </section>
              )}

              {!canCollect && (
                <p className="field-hint">
                  You can see what is owed, but taking payment needs the collect permission.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
