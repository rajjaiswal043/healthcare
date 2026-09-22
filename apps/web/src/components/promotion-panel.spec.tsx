/**
 * The discount panel — one component, two layouts, and the promise that the
 * Finance Desk still gets the one it had.
 *
 * Rendered to a string, so these check what the panel SHOWS for a given state.
 * Applying and undoing are covered end to end on the API side.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Invoice, Promotion } from '@/lib/api';
import { PromotionPanel } from './promotion-panel';

const invoice = (over: Partial<Invoice> = {}) =>
  ({
    id: 'inv-1',
    subtotalPaise: 60000,
    discountPaise: 0,
    totalPaise: 60000,
    paidPaise: 0,
    activePromotionApplicationId: null,
    ...over,
  }) as Invoice;

const promotion: Promotion = {
  id: 'p-1',
  code: 'CAMP50',
  name: 'Eye camp',
  description: null,
  type: 'PERCENTAGE',
  value: 50,
  maxDiscountPaise: null,
  validFrom: '2026-09-01',
  validTo: null,
  isActive: true,
  timesApplied: 0,
  editable: true,
};

const render = (props: Partial<Parameters<typeof PromotionPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <PromotionPanel
      invoice={invoice()}
      promotions={[promotion]}
      approvers={[{ id: 'u-1', fullName: 'Dr Admin' }]}
      approversBlocked={false}
      busy={false}
      onApply={() => undefined}
      onUndo={() => undefined}
      {...props}
    />,
  );

/** The Finance Desk's row, exactly as it was before the panel was shared. */
const FINANCE_ROW =
  'grid grid-cols-1 items-start gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto]';

describe('the discount panel', () => {
  it('lays out as the Finance Desk row when no layout is given', () => {
    const html = render();
    expect(html).toContain(`class="${FINANCE_ROW}"`);
    expect(html).toContain('class="field-hint block md:min-h-[2lh]"');
    expect(html).toContain('class="field-label invisible hidden md:block"');
  });

  it('stacks into two columns for a narrow container, with no four-track row', () => {
    const html = render({ layout: 'stacked' });
    expect(html).toContain('class="grid grid-cols-1 items-start gap-2 sm:grid-cols-2"');
    expect(html).toContain('class="field-hint block sm:min-h-[2lh]"');
    expect(html).not.toContain('10rem');
  });

  it('offers the same fields in either layout', () => {
    for (const layout of ['grid', 'stacked'] as const) {
      const html = render({ layout });
      for (const label of ['Promotion', 'Authorised by', 'Amount off', 'Apply']) {
        expect(html).toContain(label);
      }
      expect(html).toContain('CAMP50');
      expect(html).toContain('Dr Admin');
    }
  });

  it('shows the discount on the bill, with a way to take it off, once one is applied', () => {
    const html = render({
      layout: 'stacked',
      invoice: invoice({ activePromotionApplicationId: 'a-1', discountPaise: 30000 }),
    });
    expect(html).toContain('discount');
    expect(html).toContain('Take it off');
    expect(html).not.toContain('Authorised by');
  });

  it('says why nothing can be applied when the staff list could not be loaded', () => {
    const html = render({ layout: 'stacked', approversBlocked: true });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Authorised by');
  });

  it('says so when no discount is valid today', () => {
    expect(render({ promotions: [] })).toContain('No discounts are set up');
  });
});

/**
 * Read from the source, like the patient-table spec: the page cannot be
 * rendered here (it fetches and routes), but which panel it uses, and with
 * which layout, is a fact about its code.
 */
describe('where the panel is used', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');

  it('the Finance Desk uses the shared panel, in its own grid layout', () => {
    const finance = read('../app/(app)/finance/page.tsx');
    expect(finance).toMatch(/from '@\/components\/promotion-panel'/);
    expect(finance).not.toMatch(/function PromotionPanel/);
    expect(finance).toMatch(/<PromotionPanel(?![^>]*layout=)/);
  });

  it('the payment dialog uses the shared panel, stacked', () => {
    const dialog = read('./payment-dialog.tsx');
    expect(dialog).toMatch(/<PromotionPanel\s+layout="stacked"/);
  });
});
