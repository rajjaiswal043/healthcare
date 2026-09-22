/**
 * The payment dialog's two decisions that can be checked without a browser:
 * whether the discount panel is offered, and how the bill reads.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Invoice } from '@/lib/api';
import { BillSummary, showsPromotionPanel } from './payment-dialog';

const line = (over: Record<string, unknown> = {}) => ({
  id: 'l-1',
  description: 'Consultation',
  quantity: 1,
  unitPricePaise: 60000,
  discountPaise: 0,
  taxPaise: 0,
  totalPaise: 60000,
  diagnosticOrder: null,
  ...over,
});

const invoice = (over: Partial<Invoice> = {}) =>
  ({
    id: 'inv-1',
    status: 'UNPAID',
    subtotalPaise: 60000,
    discountPaise: 0,
    taxPaise: 0,
    totalPaise: 60000,
    paidPaise: 0,
    refundedPaise: 0,
    balancePaise: 60000,
    activePromotionApplicationId: null,
    lines: [line()],
    ...over,
  }) as Invoice;

describe('when the discount panel is offered', () => {
  it('is offered to someone who can apply discounts, on a bill with nothing paid', () => {
    expect(showsPromotionPanel(true, invoice())).toBe(true);
  });

  it('is not offered without the permission', () => {
    expect(showsPromotionPanel(false, invoice())).toBe(false);
  });

  it('is not offered once any money has been taken', () => {
    expect(showsPromotionPanel(true, invoice({ paidPaise: 10000, balancePaise: 50000 }))).toBe(
      false,
    );
  });

  it('is not offered on a waived or cancelled bill', () => {
    expect(showsPromotionPanel(true, invoice({ status: 'WAIVED' }))).toBe(false);
    expect(showsPromotionPanel(true, invoice({ status: 'CANCELLED' }))).toBe(false);
  });

  it('is offered on a deferred bill, which the server still discounts', () => {
    expect(showsPromotionPanel(true, invoice({ status: 'DEFERRED' }))).toBe(true);
  });

  it('stays offered once a discount is on, so it can be taken off again', () => {
    expect(
      showsPromotionPanel(
        true,
        invoice({ activePromotionApplicationId: 'a-1', discountPaise: 30000 }),
      ),
    ).toBe(true);
  });
});

describe('the bill summary', () => {
  it('shows a discount as its own row, against the full fee', () => {
    const html = renderToStaticMarkup(
      <BillSummary
        invoice={invoice({
          discountPaise: 30000,
          totalPaise: 30000,
          balancePaise: 30000,
          activePromotionApplicationId: 'a-1',
          lines: [line({ discountPaise: 30000, totalPaise: 30000 })],
        })}
      />,
    );
    expect(html).toContain('Billed');
    expect(html).toMatch(/Discount<\/span><span[^>]*>− ₹300\.00/);
    // The line reads the fee, not the discounted figure — the discount is
    // subtracted once, in its own row.
    expect(html.match(/₹600\.00/g)).toHaveLength(2);
    expect(html).toMatch(/Total<\/span><span[^>]*>₹300\.00/);
  });

  it('reads as it always did when there is no discount and no tax', () => {
    const html = renderToStaticMarkup(<BillSummary invoice={invoice()} />);
    expect(html).not.toContain('Discount');
    expect(html).not.toContain('Billed');
    expect(html).not.toContain('Tax');
    expect(html).toMatch(/Total<\/span><span[^>]*>₹600\.00/);
  });

  it('shows tax on its own row', () => {
    const html = renderToStaticMarkup(
      <BillSummary
        invoice={invoice({
          taxPaise: 10800,
          totalPaise: 70800,
          balancePaise: 70800,
          lines: [line({ taxPaise: 10800, totalPaise: 70800 })],
        })}
      />,
    );
    expect(html).toMatch(/Tax<\/span><span[^>]*>₹108\.00/);
    expect(html).toMatch(/Total<\/span><span[^>]*>₹708\.00/);
  });
});

/**
 * The dialog's scrollbar. Checked in the source: the dialog cannot be rendered
 * here (it reads the session), but which element scrolls, and with which
 * style, is a fact about its code.
 */
describe('the dialog scrollbar', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');

  it('fades the scrollbar of the one element that scrolls', () => {
    const scrolling = read('./payment-dialog.tsx').match(/className="[^"]*overflow-y-auto[^"]*"/g);
    expect(scrolling).toHaveLength(1);
    expect(scrolling![0]).toContain('scrollbar-quiet');
  });

  it('reuses the sidebar utility, which colours the bar and never stops scrolling', () => {
    const css = read('../app/globals.css');
    expect(css.match(/\.scrollbar-quiet \{/g)).toHaveLength(1);
    const rules = css.slice(
      css.indexOf('.scrollbar-quiet {'),
      css.indexOf('@keyframes auth-drift'),
    );
    expect(rules).not.toMatch(/overflow|display:\s*none|pointer-events/);
  });
});
