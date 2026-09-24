'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, type Invoice, type Promotion } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { formatPaise, parseRupeesToPaise } from '@/lib/format';
import { ReceiptButton } from './receipt-button';
import { PromotionPanel } from './promotion-panel';
import { IconAlert, IconCheck, IconX } from './icons';

const MODES = [
  { key: 'CASH', label: 'Cash' },
  { key: 'UPI', label: 'UPI' },
  { key: 'CARD', label: 'Card' },
  { key: 'BANK_TRANSFER', label: 'Bank transfer' },
  { key: 'OTHER', label: 'Other' },
];

/** Reasons a charge is written off. Codes, not free text — see the cancel dialog. */
const WAIVE_REASONS = [
  'Staff or staff family',
  'Camp or free clinic',
  'Courtesy — clinic error',
  'Charitable case',
];

/**
 * Whether the discount panel belongs in this dialog.
 *
 * The same rule the Finance Desk uses — the permission, and no money taken yet
 * (the server refuses a discount once any payment exists, refunded or not) —
 * plus a bill that is still a bill: a waived or cancelled one cannot take a
 * discount, and the server says so, so the panel is not offered there.
 */
export function showsPromotionPanel(mayDiscount: boolean, invoice: Invoice): boolean {
  return (
    mayDiscount &&
    invoice.paidPaise === 0 &&
    invoice.status !== 'WAIVED' &&
    invoice.status !== 'CANCELLED'
  );
}

const DEFER_REASONS = [
  'Emergency — no means to pay now',
  'Corporate or company account',
  'Patient will pay on collection of report',
];

/**
 * Take the money.
 *
 * The whole dialog works in paise. The only conversions are `formatPaise` on the
 * way out and `parseRupeesToPaise` on the way in, both from lib/format — a
 * division scattered through a component is how a rounding error reaches a
 * receipt.
 */
export function PaymentDialog({
  invoice: initial,
  onClose,
  onSettled,
}: {
  invoice: Invoice;
  onClose: () => void;
  /** Called with the updated invoice whenever anything changes. */
  onSettled: (invoice: Invoice) => void;
}) {
  const { can } = useAuth();
  const mayDiscount = can('promotion:apply');

  const [invoice, setInvoice] = useState(initial);
  const [mode, setMode] = useState('CASH');
  const [amount, setAmount] = useState(() => (initial.balancePaise / 100).toFixed(2));
  const [reference, setReference] = useState('');
  const [exception, setException] = useState<'waive' | 'defer' | null>(null);

  /**
   * Correcting money already recorded — FR-BIL-11.
   *
   * Two kinds, and the administrator must choose. They net to the same figure
   * and mean completely different things to whoever counts the drawer: money
   * that LEFT it, versus money that was never in it. The API refuses a
   * correction that does not say which.
   */
  const [correcting, setCorrecting] = useState<'PATIENT_REFUND' | 'RECORDED_IN_ERROR' | null>(null);
  const [correctionAmount, setCorrectionAmount] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * What the discount panel offers — loaded only for someone who can use it,
   * the same two calls the Finance Desk makes. A failure to load approvers is
   * shown by the panel itself: a discount needs one named, so without the list
   * it cannot be applied.
   */
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [approvers, setApprovers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [approversBlocked, setApproversBlocked] = useState(false);

  useEffect(() => {
    if (!mayDiscount) return;
    let cancelled = false;
    void (async () => {
      try {
        const { promotions } = await api.promotions(true);
        if (!cancelled) setPromotions(promotions);
      } catch {
        if (!cancelled) setPromotions([]);
      }
      try {
        const { approvers } = await api.approvers();
        if (!cancelled) setApprovers(approvers);
      } catch {
        if (!cancelled) setApproversBlocked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mayDiscount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const amountPaise = parseRupeesToPaise(amount);
  const canCollect = can('payment:collect');
  const mayWaive = can('invoice:waive');
  const mayDefer = can('invoice:defer');
  const mayCorrect = can('payment:refund');

  const apply = (updated: Invoice) => {
    setInvoice(updated);
    setAmount((updated.balancePaise / 100).toFixed(2));
    onSettled(updated);
  };

  async function collect() {
    if (amountPaise === null || amountPaise <= 0) {
      setError('Enter an amount.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      apply(
        await api.collectPayment(invoice.id, {
          mode,
          amountPaise,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        }),
      );
      setReference('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not record the payment.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitException() {
    if (!exception || reason.trim().length < 3) return;

    setBusy(true);
    setError(null);
    try {
      apply(
        exception === 'waive'
          ? await api.waiveInvoice(invoice.id, reason.trim())
          : await api.deferInvoice(invoice.id, reason.trim()),
      );
      setException(null);
      setReason('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Apply or take off a discount, then read the bill back.
   *
   * Read back rather than patched locally: the server spreads a discount across
   * the lines, and the dialog shows what it actually did. `apply` also resets
   * the amount to collect to the NEW balance — left at the old one, the desk
   * would be offered the undiscounted figure, which the server refuses as more
   * than is owed.
   */
  async function changeDiscount(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      apply(await api.invoice(invoice.id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function submitCorrection() {
    if (!correcting || correctionReason.trim().length < 3) return;

    const paise = Math.round(Number(correctionAmount) * 100);
    if (!Number.isFinite(paise) || paise <= 0) return;

    setBusy(true);
    setError(null);
    try {
      apply(
        await api.refundPayment(invoice.id, {
          mode,
          amountPaise: paise,
          kind: correcting,
          reason: correctionReason.trim(),
        }),
      );
      setCorrecting(null);
      setCorrectionAmount('');
      setCorrectionReason('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not record the correction.',
      );
    } finally {
      setBusy(false);
    }
  }

  const settled = invoice.settled;

  /**
   * `!m-0` on the backdrop is load-bearing.
   *
   * This dialog renders inside the page's own content, and pages wrap their
   * content in `space-y-*` — which gives every later child a top margin, this
   * one included. A margin moves a `position: fixed` box like any other box:
   * `inset-0` plus `margin-top: 1.5rem` left a 24px strip across the top of the
   * screen un-dimmed, with the role bar and the sidebar still clickable through
   * it. The `!` is needed because `space-y-6`'s selector outranks a plain `m-0`.
   */
  return (
    <div
      className="fixed inset-0 z-[60] !m-0 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      {/* The dialog box is the one thing here that scrolls — a long bill with
          the discount panel open outgrows a laptop screen. `scrollbar-quiet`
          is the sidebar's utility: the bar is invisible until the pointer is
          over the dialog or focus is inside it, and scrolling itself (wheel,
          touch, keyboard) is untouched because only the bar's colour changes. */}
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-dialog-title"
        className="scrollbar-quiet max-h-full w-full max-w-lg overflow-y-auto rounded-t-card-lg border border-ink/10 bg-card shadow-lg outline-none sm:rounded-card-lg"
      >
        <header className="flex items-start justify-between gap-3 border-b border-ink/8 bg-bg-soft px-5 py-4">
          <div>
            <p className="mono-label">Collect payment</p>
            <h2 id="payment-dialog-title" className="mt-1 font-display text-[19px] font-bold">
              {invoice.patient.name}
            </h2>
            <p className="text-[12.5px] text-ink-60">
              <span className="font-mono">{invoice.number}</span> ·{' '}
              <span className="font-mono">{invoice.patient.uhid}</span>
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

        <div className="space-y-5 p-5">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-panel border border-coral/30 bg-coral/8 p-3 text-[13px] text-coral-text"
            >
              <span className="mt-0.5 shrink-0">
                <IconAlert size={15} />
              </span>
              <span>{error}</span>
            </div>
          )}

          <BillSummary invoice={invoice} />

          {showsPromotionPanel(mayDiscount, invoice) && (
            <PromotionPanel
              layout="stacked"
              invoice={invoice}
              promotions={promotions}
              approvers={approvers}
              approversBlocked={approversBlocked}
              busy={busy}
              onApply={(input) =>
                void changeDiscount(
                  () => api.applyPromotion(invoice.id, input),
                  'Could not apply the discount.',
                )
              }
              onUndo={() =>
                void changeDiscount(
                  () => api.removePromotion(invoice.id, 'APPLIED_IN_ERROR'),
                  'Could not take the discount off.',
                )
              }
            />
          )}

          {settled ? (
            <div className="flex items-start gap-2 rounded-panel border border-green/30 bg-green-soft/40 p-3 text-[13px]">
              <span className="mt-0.5 shrink-0 text-green-text">
                <IconCheck size={14} />
              </span>
              <span>
                {invoice.status === 'WAIVED'
                  ? 'This charge was waived.'
                  : invoice.status === 'DEFERRED'
                    ? 'Payment deferred — the patient can be checked in, and this stays on the outstanding list.'
                    : 'Settled in full. The patient can be checked in.'}
                {invoice.reason && <span className="block text-ink-60">{invoice.reason}</span>}
              </span>
            </div>
          ) : (
            canCollect && (
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

                {/* Part payment is normal — ₹200 cash and the rest by UPI. Each
                    press records its own row, and the balance updates. */}
                <p className="field-hint mt-1.5">
                  Taking part of it is fine — record each tender separately and the balance updates.
                </p>

                <button
                  type="button"
                  className="btn-primary mt-3 w-full"
                  disabled={busy || amountPaise === null || amountPaise <= 0}
                  onClick={() => void collect()}
                >
                  {busy
                    ? 'Recording…'
                    : `Record ${amountPaise === null ? 'payment' : formatPaise(amountPaise)}`}
                </button>
              </section>
            )
          )}

          {/* Correcting what was already recorded. Administrator-only, and
              shown whether or not the invoice is settled — an entry made in
              error is most often noticed after the bill looks paid. */}
          {mayCorrect && invoice.paidPaise > invoice.refundedPaise && (
            <section className="border-t border-ink/8 pt-4">
              {correcting === null ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary !py-1.5 text-[12.5px]"
                    onClick={() => {
                      setCorrecting('PATIENT_REFUND');
                      setCorrectionAmount(
                        ((invoice.paidPaise - invoice.refundedPaise) / 100).toFixed(2),
                      );
                    }}
                  >
                    Refund the patient
                  </button>
                  <button
                    type="button"
                    className="btn-secondary !py-1.5 text-[12.5px]"
                    onClick={() => {
                      setCorrecting('RECORDED_IN_ERROR');
                      setCorrectionAmount(
                        ((invoice.paidPaise - invoice.refundedPaise) / 100).toFixed(2),
                      );
                    }}
                  >
                    Recorded in error
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="mono-label">
                    {correcting === 'PATIENT_REFUND'
                      ? 'Money going back to the patient'
                      : 'This entry was never real — no money moved'}
                  </p>

                  <div className="flex flex-wrap gap-2">
                    <input
                      className="field-input !py-2 max-w-[140px]"
                      inputMode="decimal"
                      value={correctionAmount}
                      onChange={(e) => setCorrectionAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                      aria-label="Amount"
                    />
                    <input
                      className="field-input !py-2 min-w-[220px] flex-1"
                      value={correctionReason}
                      onChange={(e) => setCorrectionReason(e.target.value)}
                      placeholder={
                        correcting === 'PATIENT_REFUND'
                          ? 'Procedure not performed'
                          : 'Entered against the wrong patient'
                      }
                      maxLength={300}
                      aria-label="Reason"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-primary !py-2"
                      disabled={busy || correctionReason.trim().length < 3}
                      onClick={() => void submitCorrection()}
                    >
                      {busy ? 'Recording…' : 'Record it'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setCorrecting(null)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>

                  <p className="field-hint">
                    This adds a correcting entry. Nothing already recorded is changed or removed.
                  </p>
                </div>
              )}
            </section>
          )}

          {!settled && (mayWaive || mayDefer) && (
            <section className="border-t border-ink/8 pt-4">
              {exception === null ? (
                <div className="flex flex-wrap gap-2">
                  {mayWaive && (
                    <button
                      type="button"
                      className="btn-secondary !py-1.5 text-[12.5px]"
                      onClick={() => setException('waive')}
                    >
                      Waive the charge
                    </button>
                  )}
                  {mayDefer && (
                    <button
                      type="button"
                      className="btn-secondary !py-1.5 text-[12.5px]"
                      onClick={() => setException('defer')}
                    >
                      Let them pay later
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  <p className="mono-label mb-2">
                    {exception === 'waive' ? 'Why is this being waived?' : 'Why defer payment?'}{' '}
                    <span className="text-coral">*</span>
                  </p>

                  <div className="flex flex-wrap gap-1.5">
                    {(exception === 'waive' ? WAIVE_REASONS : DEFER_REASONS).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setReason(r)}
                        aria-pressed={reason === r}
                        className={[
                          'rounded-pill border-[1.5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                          reason === r
                            ? 'border-clinical bg-clinical text-white'
                            : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25',
                        ].join(' ')}
                      >
                        {r}
                      </button>
                    ))}
                  </div>

                  <input
                    className="field-input mt-2"
                    placeholder="Or type a reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={300}
                  />

                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary !py-1.5 text-[12.5px]"
                      onClick={() => {
                        setException(null);
                        setReason('');
                      }}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      className={
                        exception === 'waive'
                          ? 'btn-danger !py-1.5 text-[12.5px]'
                          : 'btn-primary !py-1.5 text-[12.5px]'
                      }
                      disabled={busy || reason.trim().length < 3}
                      onClick={() => void submitException()}
                    >
                      {exception === 'waive' ? 'Waive this charge' : 'Defer payment'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {invoice.payments.length > 0 && (
            <section>
              <p className="mono-label mb-2">Recorded</p>
              {/* FR-BIL-13. This list used to show the mode and the amount and
                  nothing else — the reason was captured from the beginning and
                  displayed to nobody, so the person a patient asks "why was I
                  charged twice" had to go and find an administrator. */}
              <ul className="space-y-2">
                {invoice.payments.map((p) => {
                  const reversal = p.correctionKind === 'RECORDED_IN_ERROR';
                  const back = p.direction === 'REFUND';

                  return (
                    <li key={p.id} className="text-[12.5px]">
                      <div className="flex justify-between gap-3">
                        <span>
                          {reversal ? (
                            <span className="font-semibold text-amber-text">Recorded in error</span>
                          ) : back ? (
                            <span className="font-semibold text-coral-text">Refunded</span>
                          ) : null}
                          {back && ' · '}
                          {p.mode.replace('_', ' ').toLowerCase()}
                          {p.reference && <span className="text-ink-40"> · {p.reference}</span>}
                        </span>
                        <span className={`font-mono ${back ? 'text-coral-text' : ''}`}>
                          {back ? '−' : ''}
                          {formatPaise(p.amountPaise)}
                        </span>
                      </div>

                      <p className="text-[11.5px] text-ink-40">
                        {p.collectedBy.fullName ?? 'Unknown'} ·{' '}
                        {new Date(p.collectedAt).toLocaleString('en-IN', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </p>

                      {p.reason && <p className="text-[11.5px] text-ink-60">“{p.reason}”</p>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-ink/8 bg-bg-soft px-5 py-4">
          {/* FR-RCP-01: available again later, from the invoice. Renders nothing
              when no money has come in — a refund is not a receipt. */}
          <ReceiptButton invoice={invoice} className="btn-secondary" />
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            {settled ? 'Done' : 'Close'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * The bill, as the desk needs to read it before taking money.
 *
 * Laid out the way the Finance Desk lays out the same bill: each line at its
 * full price, then what was billed, any discount as a line of its own, any tax,
 * and the total. A discount used to be visible here only as line amounts that
 * were smaller than the fee — now it says what it is. With no discount and no
 * tax the billed figure IS the total, so those rows are left out and the bill
 * reads exactly as it always did.
 */
export function BillSummary({ invoice }: { invoice: Invoice }) {
  const breakdown = invoice.discountPaise > 0 || invoice.taxPaise > 0;

  return (
    <section className="rounded-panel border border-ink/10 bg-white p-3">
      <ul className="space-y-1">
        {invoice.lines.map((l) => (
          <li key={l.id} className="flex justify-between gap-3 text-[13px]">
            <span>
              {l.description}
              {l.quantity > 1 && <span className="text-ink-40"> × {l.quantity}</span>}
            </span>
            <span className="font-mono">{formatPaise(l.quantity * l.unitPricePaise)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-2 space-y-1 border-t border-ink/8 pt-2 text-[13px]">
        {breakdown && <Row label="Billed" value={formatPaise(invoice.subtotalPaise)} />}
        {invoice.discountPaise > 0 && (
          <Row label="Discount" value={`− ${formatPaise(invoice.discountPaise)}`} tone="green" />
        )}
        {invoice.taxPaise > 0 && <Row label="Tax" value={formatPaise(invoice.taxPaise)} />}
        <Row label="Total" value={formatPaise(invoice.totalPaise)} bold />
        {invoice.paidPaise > 0 && (
          <Row label="Paid" value={`− ${formatPaise(invoice.paidPaise)}`} />
        )}
        {invoice.refundedPaise > 0 && (
          <Row label="Refunded" value={`+ ${formatPaise(invoice.refundedPaise)}`} />
        )}
        <Row
          label="Balance"
          value={formatPaise(invoice.balancePaise)}
          bold
          tone={invoice.balancePaise > 0 ? 'coral' : 'green'}
        />
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  bold,
  tone,
}: {
  label: string;
  value: string;
  bold?: boolean;
  tone?: 'coral' | 'green';
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className={bold ? 'font-semibold' : 'text-ink-60'}>{label}</span>
      <span
        className={[
          'font-mono',
          bold ? 'font-bold' : '',
          tone === 'coral' ? 'text-coral-text' : tone === 'green' ? 'text-green-text' : '',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}
