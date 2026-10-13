'use client';

import { useState } from 'react';
import { EMERGENCY_SURCHARGE_CODE, type ChargeableService, type Invoice } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/format';

/**
 * Put the emergency surcharge on a bill, at an amount the desk can change.
 *
 * OFFERED, NEVER APPLIED BY ITSELF. The queue's EMERGENCY flag is set by
 * whoever holds `queue:prioritise` — a doctor or the front desk — and raising a
 * charge needs `invoice:write`. A flag that billed the patient on its own would
 * let the first permission spend the second, and clearing the flag could not
 * un-bill a patient whose money is already on the invoice. So the desk is shown
 * the charge and decides.
 *
 * THE AMOUNT IS EDITABLE, pre-filled with the clinic's price. An emergency is
 * not one price: eleven at night is not two in the afternoon, and a fracture is
 * not a dressing. A fixed figure would have been argued with at the desk and
 * then worked around — by adding a second charge, or by discounting this one,
 * both of which record something that did not happen. The server takes a price
 * per line (`unitPricePaise`), keeps the service's name and tax rate, and
 * recomputes the tax on what was actually charged, so an override is an
 * ordinary line and not a special case.
 *
 * The clinic's own figure is still shown whenever the desk has moved off it, so
 * an override is visible rather than silent.
 *
 * NOTHING HERE IF THE CLINIC HAS NOT PRICED ONE. The surcharge is an ordinary
 * catalogue service — `EMERGENCY_SURCHARGE_CODE`, set up in Settings → Prices —
 * so a clinic that does not charge for an emergency never creates it and never
 * sees this panel. That is the whole of the opt-out.
 *
 * It also disappears once the charge is on the bill, where it sits in the lines
 * with the same Remove button as every other charge. A second Add against a
 * line that is already there is how a patient gets billed twice by somebody who
 * scrolled past it.
 *
 * `serviceId` is what proves it is already there. Matching on the description
 * would be matching on a string the clinic can rename — and the line copies
 * that name at billing time precisely so renaming the service cannot rewrite
 * old bills.
 *
 * TWO PLACES, one component: the finance desk while it raises a walk-in bill,
 * and the payment dialog for a bill opened from the outstanding list. The
 * second is where an emergency actually lands, since the queue cannot be
 * flagged until the patient is checked in.
 */
export function EmergencySurcharge({
  invoice,
  services,
  busy,
  onAdd,
}: {
  invoice: Invoice;
  services: ChargeableService[];
  busy: boolean;
  onAdd: (input: { serviceId: string; unitPricePaise: number }) => void;
}) {
  /**
   * Null until the desk types, rather than seeded from the price.
   *
   * DECLARED BEFORE THE EARLY RETURNS, because the catalogue arrives after the
   * first render: a hook that only runs once `surcharge` exists is a hook count
   * that changes between renders, which React refuses outright.
   *
   * Null also means "follow the clinic", so a price edited in another tab is
   * picked up by a field nobody has touched, and there is no effect keeping two
   * copies of one number in step.
   */
  const [typed, setTyped] = useState<string | null>(null);

  const surcharge = services.find((s) => s.code === EMERGENCY_SURCHARGE_CODE);
  if (!surcharge) return null;

  if (invoice.lines.some((l) => l.serviceId === surcharge.id)) return null;

  const amount = typed ?? (surcharge.pricePaise / 100).toFixed(2);
  const paise = parseRupeesToPaise(amount);
  const valid = paise !== null && paise > 0;
  const overridden = valid && paise !== surcharge.pricePaise;

  return (
    <div
      className={[
        'rounded-panel border px-3.5 py-3',
        // A visit the queue has already called an emergency is a reminder, and
        // reads as one. On any other bill it is a plain option.
        invoice.emergencyVisit ? 'border-amber/40 bg-amber-soft/40' : 'border-ink/10 bg-bg-soft',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="mono-label">{surcharge.name}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-60">
            {invoice.emergencyVisit
              ? 'This visit is flagged as an emergency in the queue, and the surcharge is not on the bill yet.'
              : 'Charged only if the clinic is charging it for this visit.'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <label className="relative">
            <span className="sr-only">Amount in rupees</span>
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-ink-40">
              ₹
            </span>
            <input
              value={amount}
              onChange={(e) => setTyped(e.target.value)}
              inputMode="decimal"
              aria-label="Surcharge amount in rupees"
              className="field-input !w-[108px] !py-1.5 !pl-6 text-right font-mono text-[13px] tabular-nums"
            />
          </label>

          <button
            type="button"
            className={invoice.emergencyVisit ? 'btn-primary !py-1.5' : 'btn-secondary !py-1.5'}
            disabled={busy || !valid}
            onClick={() => valid && onAdd({ serviceId: surcharge.id, unitPricePaise: paise })}
          >
            Add
          </button>
        </div>
      </div>

      {/* The clinic's own figure, shown only once the desk has moved off it, so
          the override is deliberate and visible rather than silent. */}
      {overridden && (
        <p className="field-hint">The clinic’s price is {formatPaise(surcharge.pricePaise)}.</p>
      )}
      {!valid && amount.trim() !== '' && <p className="field-error">That is not an amount.</p>}
    </div>
  );
}

/**
 * Whether this bill may take the surcharge at all.
 *
 * The same three conditions that govern adding ANY charge, in one place so the
 * desk and the dialog cannot disagree:
 *
 *   the permission;
 *
 *   nothing paid — the server freezes an invoice once money is on it, and a
 *   button the API will refuse is worse than no button;
 *
 *   no discount applied — `promotion_application` froze its figure at apply
 *   time and is append-only, so adding a charge underneath it leaves the clinic
 *   reported as having given away more than it did.
 *
 * A waived or cancelled bill is not a bill anybody is adding to either.
 */
export function mayAddSurcharge(mayBill: boolean, invoice: Invoice): boolean {
  return (
    mayBill &&
    invoice.paidPaise === 0 &&
    !invoice.activePromotionApplicationId &&
    invoice.status !== 'WAIVED' &&
    invoice.status !== 'CANCELLED'
  );
}
