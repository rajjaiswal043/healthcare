import type { DiagnosticBillingState } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * Where a test stands with the money, in one chip.
 *
 * Four of the five states are worth showing and one is not: a SETTLED test is
 * the normal case, and a worklist where every row carries a green "paid" badge
 * is a worklist where the two rows that matter stop standing out.
 *
 * NOT_BILLED and LEGACY are deliberately neutral rather than warning-coloured.
 * Neither is the patient failing to pay — one is a test the clinic never priced
 * and the other predates billing entirely — and neither blocks the result. A
 * red chip on those would have the room chasing a bill that does not exist.
 */
export function TestBillingBadge({ billing }: { billing: DiagnosticBillingState }) {
  switch (billing.status) {
    case 'UNPAID':
      return (
        <span className="badge-coral" title={`Invoice ${billing.invoiceNumber}`}>
          bill not cleared · {formatPaise(billing.balancePaise)}
        </span>
      );
    case 'VOID':
      return (
        <span className="badge-coral" title={`Invoice ${billing.invoiceNumber}`}>
          bill cancelled
        </span>
      );
    case 'NOT_BILLED':
      return <span className="badge-neutral">not billed</span>;
    case 'LEGACY':
      return null;
    case 'SETTLED':
      return null;
  }
}

/** True when the result must not be released. Mirrors `blockingReasonForOrder`. */
export function testIsBlocked(billing: DiagnosticBillingState): boolean {
  return billing.status === 'UNPAID' || billing.status === 'VOID';
}
