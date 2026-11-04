/**
 * The emergency surcharge panel: when it appears, and what it offers.
 *
 * Rendered to static markup rather than driven — the three decisions worth
 * pinning down are all made before any interaction: whether the panel exists at
 * all, whether it is a reminder or a plain option, and what amount it starts
 * with.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChargeableService, Invoice } from '@/lib/api';
import { EmergencySurcharge, mayAddSurcharge } from './emergency-surcharge';

const SURCHARGE: ChargeableService = {
  id: 'svc-emerg',
  code: 'CONS-EMERG',
  name: 'Emergency / after-hours surcharge',
  category: 'CONSULTATION',
  pricePaise: 30000,
  taxRateBasisPoints: 0,
};

const line = (over: Record<string, unknown> = {}) => ({
  id: 'l-1',
  serviceId: null,
  description: 'Consultation',
  quantity: 1,
  unitPricePaise: 50000,
  discountPaise: 0,
  taxPaise: 0,
  totalPaise: 50000,
  diagnosticOrder: null,
  ...over,
});

const invoice = (over: Partial<Invoice> = {}) =>
  ({
    id: 'inv-1',
    status: 'UNPAID',
    subtotalPaise: 50000,
    discountPaise: 0,
    taxPaise: 0,
    totalPaise: 50000,
    paidPaise: 0,
    refundedPaise: 0,
    balancePaise: 50000,
    activePromotionApplicationId: null,
    emergencyVisit: false,
    lines: [line()],
    ...over,
  }) as Invoice;

const render = (inv: Invoice, services: ChargeableService[] = [SURCHARGE]) =>
  renderToStaticMarkup(
    <EmergencySurcharge invoice={inv} services={services} busy={false} onAdd={() => {}} />,
  );

describe('whether the panel is there at all', () => {
  it('is nothing at all when the clinic has not priced a surcharge', () => {
    // The whole of the opt-out: a clinic that does not charge for an emergency
    // never creates the service, and never sees this.
    expect(render(invoice(), [])).toBe('');
  });

  it('is nothing once the charge is already on the bill', () => {
    // Offering it twice is how a patient gets billed twice by somebody who
    // scrolled past the line.
    expect(render(invoice({ lines: [line(), line({ id: 'l-2', serviceId: SURCHARGE.id })] }))).toBe(
      '',
    );
  });

  it('is offered on a bill that does not have it yet', () => {
    expect(render(invoice())).toContain('Emergency / after-hours surcharge');
  });

  /**
   * Matched on the service, not the words. The description is a copy the clinic
   * can rename — the line keeps the name AS CHARGED precisely so renaming a
   * service cannot rewrite old bills — so a line that merely reads like the
   * surcharge is not the surcharge.
   */
  it('still offers it beside a line that only looks like one', () => {
    const lookalike = line({ id: 'l-2', description: 'Emergency / after-hours surcharge' });

    expect(render(invoice({ lines: [line(), lookalike] }))).toContain('Add');
  });
});

describe('what it offers', () => {
  it('starts at the clinic’s price', () => {
    expect(render(invoice())).toContain('value="300.00"');
  });

  it('says why it is there when the queue has flagged the visit', () => {
    const html = render(invoice({ emergencyVisit: true }));

    expect(html).toContain('flagged as an emergency in the queue');
  });

  it('is a plain option on a visit nobody has flagged', () => {
    const html = render(invoice());

    expect(html).not.toContain('flagged as an emergency in the queue');
    expect(html).toContain('Charged only if the clinic is charging it');
  });
});

describe('when a bill may take it', () => {
  it('needs the permission', () => {
    expect(mayAddSurcharge(false, invoice())).toBe(false);
    expect(mayAddSurcharge(true, invoice())).toBe(true);
  });

  it('is refused once any money is on the bill', () => {
    // The server freezes an invoice that has been paid against, and a button
    // the API will refuse is worse than no button.
    expect(mayAddSurcharge(true, invoice({ paidPaise: 20000 }))).toBe(false);
  });

  it('is refused under an applied discount', () => {
    // `promotion_application` froze its figure and is append-only, so a charge
    // added underneath leaves the clinic reported as having given away more
    // than it did.
    expect(mayAddSurcharge(true, invoice({ activePromotionApplicationId: 'a-1' }))).toBe(false);
  });

  it('is refused on a bill that is no longer a bill', () => {
    expect(mayAddSurcharge(true, invoice({ status: 'WAIVED' }))).toBe(false);
    expect(mayAddSurcharge(true, invoice({ status: 'CANCELLED' }))).toBe(false);
  });
});
