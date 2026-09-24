'use client';

import { useState } from 'react';
import { api, ApiRequestError, type Invoice, type ReceiptPayload } from '@/lib/api';
import { ReceiptPrint } from './receipt-print';
import { IconReceipt } from './icons';

/**
 * Print a receipt for the most recent money taken on this bill.
 *
 * ONE BUTTON, TWO PLACES: the finance desk immediately after payment, and the
 * payment dialog for a reprint later. Both go through the same path, because a
 * reprint is not a different document — it is the same receipt with DUPLICATE on
 * its face, and the difference is decided by the server's print log rather than
 * by which screen asked.
 *
 * The sheet renders hidden and `window.print()` reveals it through the print
 * stylesheet. No popup: the prescription's comment explains why, and the same
 * reasons apply here.
 */
export function ReceiptButton({
  invoice,
  className = 'btn-secondary',
}: {
  invoice: Invoice;
  className?: string;
}) {
  const [receipt, setReceipt] = useState<ReceiptPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The last money that came IN.
   *
   * A refund is not a receipt — nothing was received, and printing one would put
   * a document in a patient's hand saying they paid when in fact they were paid.
   */
  const lastPayment = [...invoice.payments].reverse().find((p) => p.direction === 'IN') ?? null;

  if (!lastPayment) return null;

  async function print() {
    if (!lastPayment) return;
    setBusy(true);
    setError(null);

    try {
      // Recording the print and getting the sheet are one call, so a sheet
      // cannot be rendered without the log knowing about it.
      const payload = await api.printReceipt(lastPayment.id);
      setReceipt(payload);

      // Let React paint the hidden sheet before the browser snapshots the page.
      await new Promise((resolve) => setTimeout(resolve, 60));
      window.print();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not print the receipt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={() => void print()}>
        <IconReceipt size={16} />
        {busy ? 'Preparing…' : receipt ? 'Print again' : 'Print receipt'}
      </button>

      {error && <p className="field-error">{error}</p>}

      {receipt && (
        <>
          <ReceiptPrint receipt={receipt} />
          {receipt.print?.isDuplicate && (
            <p className="field-hint no-print">
              That was copy {receipt.print.printCount}. It printed marked DUPLICATE.
            </p>
          )}
        </>
      )}
    </>
  );
}
