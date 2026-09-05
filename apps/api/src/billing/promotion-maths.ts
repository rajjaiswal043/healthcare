/**
 * Turning a promotion into line discounts.
 *
 * Pure arithmetic, in its own file and with its own test, because this is where
 * a discount feature quietly goes wrong. Every function here takes integer paise
 * and returns integer paise. There is no float in this file and there should
 * never be one.
 *
 * THE TENSION THIS RESOLVES
 *
 * A promotion is invoice-level: the clinic says "50% off this bill". The
 * database is line-level: `invoice_line.discount_paise` carries the discount,
 * `invoice.discount_paise` is the denormalised sum of it, and two CHECK
 * constraints hold the pieces together —
 *
 *   invoice_line_discount_within_bounds   discount <= quantity * unit_price
 *   invoice_line_total_is_consistent      total = gross - discount + tax
 *
 * So an invoice-level number has to be distributed across lines such that no
 * line is discounted below zero and the parts still sum to the whole. Rounding
 * each line independently does not do that: three lines at a third of ₹100 round
 * to 3333 + 3333 + 3333 and lose a paisa, and the invoice then disagrees with
 * itself by an amount too small to notice and too persistent to explain.
 *
 * The last line absorbs the remainder. That is not elegance, it is the only way
 * the sum is exact.
 */

/** One crore in paise, matching MAX_PAISE in the billing DTOs. */
const MAX_PAISE = 100_000_000;

export interface DiscountableLine {
  id: string;
  quantity: number;
  unitPricePaise: number;
  taxPaise: number;
}

export interface LineDiscount {
  id: string;
  /** What this line is discounted by. */
  discountPaise: number;
  /** The line total the CHECK constraint requires alongside it. */
  totalPaise: number;
}

export interface DiscountPlan {
  /** What the promotion actually takes off, after cap and flooring. */
  totalDiscountPaise: number;
  /** Sum of `quantity * unitPricePaise` across the lines. */
  subtotalPaise: number;
  lines: LineDiscount[];
}

/** Gross value of a line, before discount and before tax. */
function grossOf(line: DiscountableLine): number {
  return line.quantity * line.unitPricePaise;
}

/**
 * What a promotion is worth against a given subtotal.
 *
 * PERCENTAGE goes through basis points rather than a float percentage, matching
 * how tax is already computed in `BillingService.addLine`:
 * `Math.round((gross * rate) / 10000)`. A stored value of 50 means 5000 basis
 * points. The two paths agreeing matters more than either being clever — a
 * discount and a tax that round differently produce invoices that are correct
 * individually and inconsistent together.
 */
export function discountValueFor(
  promotion: { type: 'PERCENTAGE' | 'FLAT'; value: number; maxDiscountPaise: number | null },
  subtotalPaise: number,
): number {
  if (subtotalPaise <= 0) return 0;

  const raw =
    promotion.type === 'PERCENTAGE'
      ? Math.round((subtotalPaise * (promotion.value * 100)) / 10000)
      : promotion.value;

  // The cap, so "50% off" cannot become ₹4,000 (FR-PRO-01).
  const capped =
    promotion.maxDiscountPaise === null ? raw : Math.min(raw, promotion.maxDiscountPaise);

  /**
   * Floored at the bill.
   *
   * "A flat discount larger than the bill reduces it to zero and never below —
   * the clinic does not owe money because a promo was too big." A negative
   * total would also be refused by `invoice_amounts_non_negative`, but arriving
   * at the constraint means the arithmetic was already wrong.
   */
  return Math.max(0, Math.min(capped, subtotalPaise));
}

/**
 * Spread an invoice-level discount across the lines it applies to.
 *
 * Proportional to each line's gross, with the last line taking whatever rounding
 * left over, so the parts sum to exactly `totalDiscountPaise`. Every line is
 * clamped to its own gross on the way, which is the CHECK constraint expressed
 * in code rather than discovered by it.
 */
export function distribute(lines: DiscountableLine[], totalDiscountPaise: number): LineDiscount[] {
  const subtotal = lines.reduce((n, l) => n + grossOf(l), 0);

  if (lines.length === 0 || subtotal <= 0 || totalDiscountPaise <= 0) {
    return lines.map((l) => ({
      id: l.id,
      discountPaise: 0,
      totalPaise: grossOf(l) + l.taxPaise,
    }));
  }

  const allocations = new Array<number>(lines.length).fill(0);
  let allocated = 0;

  // Every line but the last gets its proportional share, rounded the same way
  // tax is.
  for (let i = 0; i < lines.length - 1; i++) {
    const gross = grossOf(lines[i]!);
    const share = Math.min(Math.round((totalDiscountPaise * gross) / subtotal), gross);
    allocations[i] = share;
    allocated += share;
  }

  // The last line absorbs the remainder — this is what makes the sum exact.
  const lastIndex = lines.length - 1;
  const lastGross = grossOf(lines[lastIndex]!);
  allocations[lastIndex] = Math.min(Math.max(totalDiscountPaise - allocated, 0), lastGross);
  allocated = allocations.reduce((n, a) => n + a, 0);

  /**
   * Place anything still unallocated on a line with room.
   *
   * Reachable only when the last line's own gross could not absorb the
   * remainder — a heavily skewed invoice where rounding pushed too much to the
   * end. Rare, and silently wrong if left: the invoice would be discounted by
   * less than the promotion promised, and nothing would say so.
   */
  let shortfall = totalDiscountPaise - allocated;
  for (let i = 0; shortfall > 0 && i < lines.length; i++) {
    const headroom = grossOf(lines[i]!) - allocations[i]!;
    if (headroom <= 0) continue;

    const take = Math.min(headroom, shortfall);
    allocations[i]! += take;
    shortfall -= take;
  }

  return lines.map((line, i) => {
    const discountPaise = allocations[i]!;
    return {
      id: line.id,
      discountPaise,
      /**
       * Tax is deliberately NOT recomputed.
       *
       * The stored `tax_paise` was worked out from the pre-discount gross when
       * the line was added, and this keeps it. Whether an Indian clinic's GST
       * should fall on the discounted value is a real question with a real
       * answer, and it is a billing-policy decision nobody has taken — making it
       * here, silently, inside a discount feature, is the wrong place for it.
       * Every seeded consultation service is currently zero-rated, so this
       * changes no number in practice today.
       */
      totalPaise: grossOf(line) - discountPaise + line.taxPaise,
    };
  });
}

/** The whole calculation: what to take off, and how it lands on each line. */
export function planDiscount(
  promotion: { type: 'PERCENTAGE' | 'FLAT'; value: number; maxDiscountPaise: number | null },
  lines: DiscountableLine[],
): DiscountPlan {
  const subtotalPaise = lines.reduce((n, l) => n + grossOf(l), 0);
  const totalDiscountPaise = discountValueFor(promotion, subtotalPaise);

  return {
    totalDiscountPaise,
    subtotalPaise,
    lines: distribute(lines, totalDiscountPaise),
  };
}

export { MAX_PAISE };
