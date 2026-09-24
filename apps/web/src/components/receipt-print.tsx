'use client';

import type { ReceiptPayload } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { ClinicLogo } from './clinic-logo';
import { PrintPortal } from './print-portal';
import { useAuth } from './auth-provider';

/**
 * The printed receipt — FR-RCP-02.
 *
 * Hidden on screen and revealed by the print stylesheet, exactly like the
 * prescription. Not a popup: popups are blocked by default in most browsers,
 * lose the session cookie in some, and would mean maintaining a second copy of
 * this markup.
 *
 * Rendered through `PrintPortal`, so the sheet is a child of `<body>` rather
 * than of whatever screen opened it. Without that it printed on top of the queue
 * board, because it sat inside the page's `<main>` and inside a `fixed` dialog.
 *
 * A5 from an ordinary printer (decision, 6 Sep 2026). A thermal roll is a
 * different layout — single column, fixed narrow width — and is a CSS-only
 * addition later rather than something to guess at now.
 *
 * THE ORDER OF THE MONEY BLOCK IS THE REQUIREMENT, not the styling: total
 * charged, discount with the promotion named, payable, paid now and how, then
 * the balance. Never collapsed into one figure. A clinic that prints ₹0 rather
 * than ₹600 less ₹600 cannot say what it gave away, and the patient cannot see
 * what they were given.
 */
export function ReceiptPrint({ receipt }: { receipt: ReceiptPayload }) {
  const { session } = useAuth();
  const clinic = session?.tenant ?? null;

  const { money, print } = receipt;
  const issued = new Date(receipt.issuedAt);

  return (
    <PrintPortal>
      <div className="text-ink">
        {/* Every sheet after the first says so on its face. Two identical
          unmarked receipts for one payment is how cash goes missing. */}
        {print?.isDuplicate && (
          <p className="mb-3 text-center font-mono text-[13px] font-bold uppercase tracking-[0.35em]">
            — Duplicate —
          </p>
        )}

        <header className="flex items-start justify-between border-b-2 border-ink pb-3">
          <div className="flex items-start gap-3">
            <ClinicLogo clinic={clinic} size={52} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-display text-[15px] font-bold uppercase leading-tight tracking-wide">
                {receipt.clinic.name}
              </p>
              {(receipt.clinic.addressLine || receipt.clinic.city) && (
                <p className="text-[11px] leading-snug">
                  {[receipt.clinic.addressLine, receipt.clinic.city].filter(Boolean).join(', ')}
                </p>
              )}
              {receipt.clinic.phone && (
                <p className="font-mono text-[11px]">{receipt.clinic.phone}</p>
              )}
            </div>
          </div>

          <div className="text-right">
            <p className="font-mono text-[10px] uppercase tracking-wider">Receipt</p>
            <p className="font-mono text-[15px] font-bold">{receipt.receiptNumber}</p>
            <p className="text-[11px]">
              {issued.toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
              {', '}
              {issued.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        </header>

        {/* Who it is for. */}
        <section className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-ink/40 py-3 text-[12px]">
          <Field label="Patient" value={receipt.patient.name} />
          <Field label="Patient ID" value={receipt.patient.uhid} mono />
          <Field
            label="Age / Sex"
            value={`${receipt.patient.ageYears ?? '—'} / ${receipt.patient.gender.charAt(0)}`}
          />
          <Field label="Mobile" value={receipt.patient.mobile} mono />
          {/* A walk-in test has no doctor, and the sheet does not pretend one. */}
          {receipt.doctor && (
            <Field
              label="Doctor"
              value={`${receipt.doctor.prefix ? `${receipt.doctor.prefix} ` : ''}${receipt.doctor.fullName}`}
            />
          )}
          <Field label="Bill" value={receipt.invoiceNumber} mono />
        </section>

        {/* What they are paying for. Rate × quantity = amount. */}
        <table className="w-full border-b border-ink/40 py-2 text-[12px]">
          <tbody>
            {receipt.lines.map((line, i) => (
              <tr key={i}>
                <td className="py-1.5 pr-2 align-top">
                  {line.description}
                  <span className="text-[11px]">
                    {' · '}
                    {formatPaise(line.unitPricePaise)} × {line.quantity}
                  </span>
                </td>
                <td className="py-1.5 text-right align-top font-mono tabular-nums">
                  {formatPaise(line.amountPaise)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* The money, in this order and never collapsed. */}
        <section className="ml-auto mt-3 w-[62%] space-y-1 text-[12.5px]">
          <Money label="Total charged" value={formatPaise(money.totalChargedPaise)} />

          {money.discountPaise > 0 && (
            <Money
              label={`Discount${money.discountLabel ? ` · ${money.discountLabel}` : ''}`}
              value={`− ${formatPaise(money.discountPaise)}`}
            />
          )}

          {/* Only when something actually carries tax. No clinic here is
            GST-registered, so this stays absent and the sheet stays clean. */}
          {receipt.showTax && <Money label="Tax" value={formatPaise(money.taxPaise)} />}

          <Money label="Payable" value={formatPaise(money.payablePaise)} bold />
          <Money label={`Paid now · ${money.mode}`} value={formatPaise(money.paidNowPaise)} bold />
          {money.reference && (
            <p className="text-right font-mono text-[10.5px]">Ref {money.reference}</p>
          )}
          <Money label="Balance" value={formatPaise(money.balancePaise)} />
        </section>

        <footer className="mt-8 flex items-end justify-between border-t border-ink/40 pt-3 text-[11px]">
          <div>
            <p>Received by {receipt.receivedBy}</p>
            {print?.isDuplicate && (
              <p className="mt-0.5">
                Reprinted{' '}
                {new Date(print.printedAt).toLocaleString('en-IN', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                by {print.printedBy}
              </p>
            )}
          </div>
          {/* The clinic stamps here. Left deliberately empty. */}
          <div className="w-[38%] border-t border-ink/40 pt-1 text-center">Clinic stamp</div>
        </footer>
      </div>
    </PrintPortal>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <p>
      <span className="text-[10px] uppercase tracking-wider">{label} </span>
      <span className={mono ? 'font-mono' : ''}>{value}</span>
    </p>
  );
}

function Money({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? 'font-bold' : ''}`}>
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}
