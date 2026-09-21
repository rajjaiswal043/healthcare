/**
 * The discount arithmetic, worked by hand.
 *
 * A pure test with no database, because the failures this guards against are
 * arithmetic ones and they are invisible through an API: an invoice whose parts
 * sum to a paisa less than its whole is still a valid invoice, still passes
 * every constraint, and still reconciles wrong at month-end.
 *
 * Every expected number below is computed on paper in the comment beside it. A
 * test whose expectation was produced by running the code proves only that the
 * code equals itself.
 */

import { describe, expect, it } from 'vitest';
import { discountValueFor, distribute, planDiscount } from '../promotion-maths.js';

/** ₹600.00 consultation, zero-rated, quantity one. */
const consultation = { id: 'l1', quantity: 1, unitPricePaise: 60000, taxPaise: 0 };

describe('what a promotion is worth', () => {
  it('takes a whole percentage off the subtotal', () => {
    // 50% of ₹600.00 = ₹300.00 = 30000 paise.
    expect(discountValueFor({ type: 'PERCENTAGE', value: 50, maxDiscountPaise: null }, 60000)).toBe(
      30000,
    );
  });

  it('rounds a percentage the way tax is rounded', () => {
    // 33% of ₹350.00: 35000 * 3300 / 10000 = 11550 exactly.
    expect(discountValueFor({ type: 'PERCENTAGE', value: 33, maxDiscountPaise: null }, 35000)).toBe(
      11550,
    );

    // 33% of ₹350.01: 35001 * 3300 / 10000 = 11550.33 -> 11550.
    expect(discountValueFor({ type: 'PERCENTAGE', value: 33, maxDiscountPaise: null }, 35001)).toBe(
      11550,
    );

    // 33% of ₹350.05: 35005 * 3300 / 10000 = 11551.65 -> 11552.
    expect(discountValueFor({ type: 'PERCENTAGE', value: 33, maxDiscountPaise: null }, 35005)).toBe(
      11552,
    );
  });

  it('gives the whole bill away at 100%', () => {
    // The case the feature exists for. Not an edge case — a real instruction.
    expect(
      discountValueFor({ type: 'PERCENTAGE', value: 100, maxDiscountPaise: null }, 60000),
    ).toBe(60000);
  });

  it('takes a flat amount as given', () => {
    expect(discountValueFor({ type: 'FLAT', value: 20000, maxDiscountPaise: null }, 60000)).toBe(
      20000,
    );
  });

  it('floors a flat discount larger than the bill at the bill', () => {
    // ₹500 off a ₹300 bill is ₹300 off, not ₹500. "The clinic does not owe
    // money because a promo was too big."
    expect(discountValueFor({ type: 'FLAT', value: 50000, maxDiscountPaise: null }, 30000)).toBe(
      30000,
    );
  });

  it('applies the cap before the floor', () => {
    // 50% of ₹8,000.00 would be ₹4,000.00, capped at ₹1,000.00.
    expect(
      discountValueFor({ type: 'PERCENTAGE', value: 50, maxDiscountPaise: 100000 }, 800000),
    ).toBe(100000);
  });

  it('leaves a discount below its cap alone', () => {
    // 50% of ₹600.00 is ₹300.00, well under a ₹1,000.00 cap.
    expect(
      discountValueFor({ type: 'PERCENTAGE', value: 50, maxDiscountPaise: 100000 }, 60000),
    ).toBe(30000);
  });

  it('is zero on an empty bill', () => {
    // No lines means no subtotal means nothing to discount — and, importantly,
    // no division by zero.
    expect(discountValueFor({ type: 'PERCENTAGE', value: 50, maxDiscountPaise: null }, 0)).toBe(0);
  });
});

describe('a custom amount', () => {
  const custom = { type: 'CUSTOM' as const, value: null, maxDiscountPaise: null };

  it('is worth exactly what the caller passed', () => {
    // Nothing is derived: ₹175.00 was typed, ₹175.00 comes back.
    expect(discountValueFor(custom, 60000, 17500)).toBe(17500);
  });

  it('is worth nothing when no amount came with it', () => {
    // The service refuses this case outright; the arithmetic still has to have
    // an answer, and 0 is the safe one — a discount of nothing, never of
    // everything.
    expect(discountValueFor(custom, 60000)).toBe(0);
  });

  it('ignores a stored value it does not have', () => {
    // A CUSTOM row cannot hold a value — the CHECK constraint refuses it — but
    // if one ever appeared, the typed amount is still what counts.
    expect(discountValueFor({ ...custom, value: 99999 }, 60000, 5000)).toBe(5000);
  });

  /**
   * The floor still applies, and is a backstop rather than the contract: the
   * service refuses an over-the-bill amount with a message naming both figures,
   * precisely so this clamp is never what the desk experiences.
   */
  it('is still floored at the bill', () => {
    expect(discountValueFor(custom, 40000, 50000)).toBe(40000);
  });

  it('takes the whole bill when that is the amount', () => {
    expect(discountValueFor(custom, 60000, 60000)).toBe(60000);
  });

  it('spreads across lines exactly like any other discount', () => {
    // Two lines, ₹600.00 and ₹200.00, and ₹200.00 typed.
    // Line 1: 20000 * 60000 / 80000 = 15000. Line 2 takes the remainder, 5000.
    const plan = planDiscount(
      custom,
      [
        { id: 'l1', quantity: 1, unitPricePaise: 60000, taxPaise: 0 },
        { id: 'l2', quantity: 1, unitPricePaise: 20000, taxPaise: 0 },
      ],
      20000,
    );

    expect(plan.totalDiscountPaise).toBe(20000);
    expect(plan.lines.map((l) => l.discountPaise)).toEqual([15000, 5000]);
    // The parts sum to the whole, which is the property this file exists for.
    expect(plan.lines.reduce((n, l) => n + l.discountPaise, 0)).toBe(20000);
  });
});

describe('spreading it across lines', () => {
  it('puts the whole discount on a single line', () => {
    const [line] = distribute([consultation], 30000);

    expect(line?.discountPaise).toBe(30000);
    // total = gross - discount + tax = 60000 - 30000 + 0
    expect(line?.totalPaise).toBe(30000);
  });

  it('splits proportionally by line value', () => {
    // ₹600 + ₹200 = ₹800 subtotal, ₹200 off.
    //   line 1: 20000 * 60000 / 80000 = 15000
    //   line 2: the remainder,          =  5000
    const lines = distribute(
      [consultation, { id: 'l2', quantity: 1, unitPricePaise: 20000, taxPaise: 0 }],
      20000,
    );

    expect(lines.map((l) => l.discountPaise)).toEqual([15000, 5000]);
  });

  it('sums to exactly the intended discount when thirds do not divide', () => {
    // Three ₹100.00 lines, ₹100.00 off. A third of 10000 is 3333.33.
    // Independent rounding gives 3333 + 3333 + 3333 = 9999 and loses a paisa.
    // Here the last line absorbs it: 3333 + 3333 + 3334.
    const lines = distribute(
      [
        { id: 'a', quantity: 1, unitPricePaise: 10000, taxPaise: 0 },
        { id: 'b', quantity: 1, unitPricePaise: 10000, taxPaise: 0 },
        { id: 'c', quantity: 1, unitPricePaise: 10000, taxPaise: 0 },
      ],
      10000,
    );

    expect(lines.map((l) => l.discountPaise)).toEqual([3333, 3333, 3334]);
    expect(lines.reduce((n, l) => n + l.discountPaise, 0)).toBe(10000);
  });

  it('never discounts a line below zero', () => {
    // A tiny line beside a large one. Its share must not exceed its own gross,
    // which is what invoice_line_discount_within_bounds requires.
    const lines = distribute(
      [
        { id: 'big', quantity: 1, unitPricePaise: 100000, taxPaise: 0 },
        { id: 'tiny', quantity: 1, unitPricePaise: 100, taxPaise: 0 },
      ],
      100100,
    );

    for (const line of lines) {
      expect(line.discountPaise).toBeGreaterThanOrEqual(0);
      expect(line.totalPaise).toBeGreaterThanOrEqual(0);
    }
    expect(lines.reduce((n, l) => n + l.discountPaise, 0)).toBe(100100);
  });

  it('respects quantity when working out a line share', () => {
    // Two of a ₹150.00 item is ₹300.00 of gross, not ₹150.00.
    const lines = distribute(
      [
        { id: 'pair', quantity: 2, unitPricePaise: 15000, taxPaise: 0 },
        { id: 'single', quantity: 1, unitPricePaise: 30000, taxPaise: 0 },
      ],
      30000,
    );

    // Equal gross on both sides, so an equal split.
    expect(lines.map((l) => l.discountPaise)).toEqual([15000, 15000]);
  });

  it('keeps tax out of the discount and back in the total', () => {
    // Gross ₹100.00, tax ₹18.00, discount ₹50.00.
    // total = 10000 - 5000 + 1800 = 6800
    const [line] = distribute(
      [{ id: 't', quantity: 1, unitPricePaise: 10000, taxPaise: 1800 }],
      5000,
    );

    expect(line?.discountPaise).toBe(5000);
    expect(line?.totalPaise).toBe(6800);
  });

  it('leaves lines untouched when the discount is zero', () => {
    const [line] = distribute([consultation], 0);

    expect(line?.discountPaise).toBe(0);
    expect(line?.totalPaise).toBe(60000);
  });
});

describe('the whole plan', () => {
  it('gives a 100% discount that zeroes every line', () => {
    const plan = planDiscount({ type: 'PERCENTAGE', value: 100, maxDiscountPaise: null }, [
      consultation,
      { id: 'l2', quantity: 1, unitPricePaise: 20000, taxPaise: 0 },
    ]);

    expect(plan.subtotalPaise).toBe(80000);
    expect(plan.totalDiscountPaise).toBe(80000);
    expect(plan.lines.every((l) => l.totalPaise === 0)).toBe(true);
  });

  it('reports the subtotal it worked from', () => {
    const plan = planDiscount({ type: 'FLAT', value: 5000, maxDiscountPaise: null }, [
      consultation,
    ]);

    expect(plan.subtotalPaise).toBe(60000);
    expect(plan.totalDiscountPaise).toBe(5000);
  });
});
