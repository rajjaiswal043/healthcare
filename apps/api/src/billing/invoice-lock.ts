import type { TenantClient } from '@healthcloud/db';

/**
 * Hold one invoice still until this transaction ends.
 *
 * Taken FIRST — before anything about the bill is read — by every action whose
 * decision depends on the bill's current state: applying a discount, taking one
 * off, and taking money. Each of them reads ("is a discount on it?", "has money
 * been taken?", "what is the balance?") and then writes on the strength of what
 * it read. Without the lock two of them could read the same state, both decide
 * it allowed them, and both write: two discounts, one of them an orphan that the
 * discount report counts, or a payment of the full fee on a bill that was
 * discounted a moment earlier.
 *
 * With it the second waits for the first to commit, and at READ COMMITTED every
 * statement after the wait sees what the first wrote — so the checks that follow
 * the lock are the re-check, not a stale copy.
 *
 * **Lock order.** Invoice first, then whatever the action writes: its lines,
 * `promotion_application`, `payment`, and last the receipt or invoice number
 * counter (a single-row table per clinic, always the final lock taken and never
 * followed by an invoice lock). Nothing that holds an appointment or
 * practitioner lock goes on to lock an existing invoice, so no cycle exists.
 *
 * A missing id locks nothing; the caller's own lookup then answers 404, as
 * before.
 */
export async function lockInvoice(tx: TenantClient, invoiceId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
}
