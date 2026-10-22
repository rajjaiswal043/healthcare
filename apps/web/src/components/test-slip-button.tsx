'use client';

import { useState } from 'react';
import type { DiagnosticOrder } from '@/lib/api';
import { TestRequisitionPrint } from './test-requisition-print';
import { IconPrinter } from './icons';

/**
 * Print the slip for one test order.
 *
 * NO FETCH, unlike the receipt button. A receipt has to be asked for because
 * the server logs every copy and stamps the second one DUPLICATE — a receipt is
 * a financial document and the clinic has to be able to say how many exist. A
 * requisition is a request for work, reprinted freely: the patient folds it into
 * a pocket and loses it, and making that a logged event would be bookkeeping
 * about bookkeeping. So the order in hand is enough.
 *
 * The sheet renders hidden and `window.print()` reveals it through the print
 * stylesheet — see `PrintPortal` for why this is not a popup.
 */
export function PrintTestSlipButton({
  order,
  className = 'btn-secondary',
  label = 'Print slip',
  iconSize = 16,
}: {
  order: DiagnosticOrder;
  className?: string;
  label?: string;
  iconSize?: number;
}) {
  const [ready, setReady] = useState(false);

  async function print() {
    setReady(true);
    // Let React paint the hidden sheet before the browser snapshots the page.
    await new Promise((resolve) => setTimeout(resolve, 60));
    window.print();
  }

  return (
    <>
      <button type="button" className={className} onClick={() => void print()}>
        <IconPrinter size={iconSize} />
        {ready ? 'Print again' : label}
      </button>

      {ready && <TestRequisitionPrint order={order} />}
    </>
  );
}
