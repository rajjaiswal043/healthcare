import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { lockInvoice } from './invoice-lock.js';
import { clinicToday, localToInstant } from '../scheduling/clinic-time.js';

export interface RequestMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
  actorLabel?: string;
}

/** Statuses in which no further money is expected before the patient is seen. */
const SETTLED = ['PAID', 'WAIVED', 'DEFERRED'] as const;

/**
 * Where a diagnostic test stands with the money.
 *
 * Two of these five are stored facts and three are derived, and keeping that
 * straight is the point of the type. `LEGACY` and `NOT_BILLED` come from the
 * order row; the rest come from the invoice behind its line, read fresh every
 * time, because a bill paid two minutes ago must not leave a test blocked.
 */
export type DiagnosticBillingState =
  /** Raised before tests were billable. Never blocked — see the migration. */
  | { status: 'LEGACY' }
  /** No charge was raised: a free-text test the clinic does not price. */
  | { status: 'NOT_BILLED' }
  | { status: 'UNPAID'; invoiceNumber: string; balancePaise: number }
  | { status: 'SETTLED'; invoiceNumber: string }
  | { status: 'VOID'; invoiceNumber: string };

/** What `diagnosticBillingState` needs loaded. Shared so the rule has one home. */
export interface DiagnosticBillingInput {
  legacyUnbilled: boolean;
  invoiceLine: {
    invoice: {
      number: string;
      status: string;
      totalPaise: number;
      payments: Array<{ direction: string; amountPaise: number }>;
    };
  } | null;
}

/**
 * The pay-first rule for one test, as a pure function.
 *
 * Pure and exported because it is asked in two very different ways: once per
 * order when a technician tries to release a result, and once per row when a
 * worklist of forty renders. A second copy of this arithmetic for the bulk case
 * is how a worklist ends up showing "paid" for something the gate then refuses.
 */
export function diagnosticBillingState(order: DiagnosticBillingInput): DiagnosticBillingState {
  if (order.legacyUnbilled) return { status: 'LEGACY' };

  const line = order.invoiceLine;
  if (!line) return { status: 'NOT_BILLED' };

  const invoice = line.invoice;
  if (invoice.status === 'CANCELLED') {
    return { status: 'VOID', invoiceNumber: invoice.number };
  }

  // PAID, WAIVED and DEFERRED all mean "no more money is expected before the
  // patient is served" — the same list the check-in gate uses, deliberately, so
  // a clinic that defers a bill does not find it deferred at the desk and
  // blocked in the X-ray room.
  if ((SETTLED as readonly string[]).includes(invoice.status)) {
    return { status: 'SETTLED', invoiceNumber: invoice.number };
  }

  const paid = sum(invoice.payments.filter((p) => p.direction === 'IN'));
  const refunded = sum(invoice.payments.filter((p) => p.direction === 'REFUND'));
  const balancePaise = invoice.totalPaise - (paid - refunded);

  if (balancePaise <= 0) return { status: 'SETTLED', invoiceNumber: invoice.number };
  return { status: 'UNPAID', invoiceNumber: invoice.number, balancePaise };
}

/** The nested shape `diagnosticBillingState` reads. Reused by the worklist. */
export const DIAGNOSTIC_BILLING_SELECT = {
  legacyUnbilled: true,
  invoiceLine: {
    select: {
      invoice: {
        select: {
          number: true,
          status: true,
          totalPaise: true,
          payments: { select: { direction: true, amountPaise: true } },
        },
      },
    },
  },
} as const;

/**
 * OPD billing.
 *
 * The rule that shapes this module: **payment is collected before the
 * consultation**, and the gate sits at check-in — see
 * docs/04-billing-plan.md section 1 for why the receptionist rather than the
 * doctor is the right person to discover an unpaid visit.
 *
 * Everything here works in integer paise. There is no float in this file, and
 * there should never be one.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Raise the invoice for an appointment, or return the one already raised.
   *
   * Called from booking and walk-in registration, inside their transaction, so a
   * visit and its bill come into existence together.
   *
   * **If the clinic has priced nothing, no invoice is created and the check-in
   * gate stays open.** That is deliberate: billing is opt-in per tenant, so a
   * clinic that has not configured a service catalogue keeps working exactly as
   * it did before this module existed rather than finding its front desk unable
   * to admit anyone. The queue board shows such visits as "not billed" so the
   * gap is visible rather than silent.
   */
  async ensureInvoiceForAppointment(
    tx: TenantClient,
    tenantId: string,
    appointmentId: string,
    meta: RequestMeta,
  ): Promise<{ id: string } | null> {
    const existing = await tx.invoice.findUnique({
      where: { appointmentId },
      select: { id: true },
    });
    if (existing) return existing;

    const appointment = await tx.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        patientId: true,
        visitType: true,
        practitioner: {
          select: { consultationFeePaise: true, followUpFeePaise: true, fullName: true },
        },
      },
    });
    if (!appointment) throw new NotFoundException('Appointment not found');

    const isFollowUp = appointment.visitType === 'FOLLOW_UP';
    const code = isFollowUp ? 'CONS-FOLLOWUP' : 'CONS-NEW';

    const service = await tx.service.findFirst({
      where: { code, isActive: true },
      select: { id: true, name: true, pricePaise: true, taxRateBasisPoints: true },
    });

    // The doctor's own fee wins over the catalogue: consultants in one clinic
    // routinely charge differently, and a single clinic-wide fee is the first
    // thing that would need working around.
    const override = isFollowUp
      ? appointment.practitioner.followUpFeePaise
      : appointment.practitioner.consultationFeePaise;

    const pricePaise = override ?? service?.pricePaise ?? null;
    if (pricePaise === null) return null;

    const taxRate = service?.taxRateBasisPoints ?? 0;
    const taxPaise = Math.round((pricePaise * taxRate) / 10000);
    const totalPaise = pricePaise + taxPaise;

    const number = await this.nextNumber(tx, tenantId);

    const invoice = await tx.invoice.create({
      data: {
        tenantId,
        number,
        patientId: appointment.patientId,
        appointmentId,
        // Both columns, always. `appointmentId` says "this IS the consultation
        // bill" and is unique; `visitAppointmentId` says "this money came out
        // of that visit" and is what reporting reads, so it has to be set on
        // every invoice or the uniform link is only true of historical rows.
        visitAppointmentId: appointmentId,
        status: totalPaise === 0 ? 'PAID' : 'UNPAID',
        subtotalPaise: pricePaise,
        taxPaise,
        totalPaise,
        issuedByUserId: meta.actorUserId ?? null,
        lines: {
          create: {
            tenantId,
            ...(service ? { serviceId: service.id } : {}),
            description: service?.name ?? (isFollowUp ? 'Follow-up consultation' : 'Consultation'),
            quantity: 1,
            unitPricePaise: pricePaise,
            taxRateBasisPoints: taxRate,
            taxPaise,
            totalPaise,
          },
        },
      },
      select: { id: true },
    });

    await this.audit.record(tx, tenantId, {
      action: 'invoice.raise',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      patientId: appointment.patientId,
      changedFields: ['totalPaise'],
      ...meta,
    });

    return invoice;
  }

  /**
   * The open test bill for a visit, or a fresh one.
   *
   * **A test is billed separately from the consultation.** The consultation fee
   * is settled at the desk before the patient goes in; the doctor then orders a
   * scan from inside the room. By that point the consultation invoice has money
   * against it and `loadEditable` — correctly — will not let anything be added
   * to it. Putting tests on their own bill is what makes the doctor's order
   * possible at all, and it is the same path a walk-in test takes, where there
   * is no consultation and no appointment to hang a bill on.
   *
   * **One open test bill per visit, not one per test.** A doctor ordering three
   * tests should produce one bill the patient pays once, not three. So an
   * existing UNPAID test bill for the visit is reused and the new test becomes
   * another line on it.
   *
   * **Unless that bill can no longer take a line**, in which case a new one is
   * opened rather than an error raised. Two things close a bill to new lines: a
   * payment against it, and a promotion applied to it. Both are ordinary
   * finance-desk activity happening in a different room from the doctor, and
   * the doctor — who cannot see either and could not fix either — must not be
   * the one who finds out. See `loadEditable` for why those two states are
   * closed in the first place.
   *
   * Takes `visitAppointmentId` as null for a walk-in test, which is the whole
   * reason this is separate from `ensureInvoiceForAppointment`.
   */
  async ensureInvoiceForDiagnosticOrder(
    tx: TenantClient,
    tenantId: string,
    input: { patientId: string; visitAppointmentId: string | null },
    meta: RequestMeta,
  ): Promise<{ id: string }> {
    if (input.visitAppointmentId) {
      const open = await tx.invoice.findFirst({
        where: {
          visitAppointmentId: input.visitAppointmentId,
          // A test bill, never the consultation bill: that one is settled at the
          // desk and is not ours to append to.
          appointmentId: null,
          status: 'UNPAID',
        },
        orderBy: { issuedAt: 'desc' },
        select: { id: true },
      });

      if (open) {
        /**
         * Locked, then read again. The lookup above could see this bill a
         * moment before a discount or a payment on it commits; deciding from
         * that copy put a new test onto a bill that had just been discounted.
         * After the lock the bill is read as it now is — and a discounted or
         * paid bill sends the test to a new one below. See lockInvoice.
         */
        await lockInvoice(tx, open.id);
        const current = await tx.invoice.findUnique({
          where: { id: open.id },
          select: { id: true, status: true, totalPaise: true, activePromotionApplicationId: true },
        });
        if (current?.status === 'UNPAID' && (await this.acceptsMoreLines(tx, current))) {
          return { id: current.id };
        }
      }
    }

    const number = await this.nextNumber(tx, tenantId);

    // Opens at zero and is retotalled the moment its first line lands, in this
    // same transaction. `reason` is deliberately not set — the column explains
    // a waiver or a deferral, and a normal bill filling it would put noise in
    // front of the finance desk on every outstanding list.
    const invoice = await tx.invoice.create({
      data: {
        tenantId,
        number,
        patientId: input.patientId,
        visitAppointmentId: input.visitAppointmentId,
        status: 'UNPAID',
        subtotalPaise: 0,
        taxPaise: 0,
        totalPaise: 0,
        issuedByUserId: meta.actorUserId ?? null,
      },
      select: { id: true },
    });

    await this.audit.record(tx, tenantId, {
      action: 'invoice.raise',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      patientId: input.patientId,
      changedFields: ['totalPaise'],
      ...meta,
    });

    return invoice;
  }

  /**
   * Bill one test, on the visit's open test invoice or a new one.
   *
   * The single call the diagnostics module makes: it knows a test was ordered
   * and what it was, and nothing about invoices. Runs inside the caller's
   * transaction so the order and its charge are one atomic fact — an order with
   * no charge would sail through the pay-first gate, and a charge with no order
   * is money for work nobody was asked to do.
   *
   * Price and description are snapshotted onto the line, as everywhere else in
   * this file: the bill must read the same in ten years after the catalogue has
   * been repriced.
   */
  async chargeDiagnosticTest(
    tx: TenantClient,
    tenantId: string,
    input: {
      patientId: string;
      visitAppointmentId: string | null;
      serviceId: string;
      description: string;
    },
    meta: RequestMeta,
  ): Promise<{ invoiceId: string; lineId: string }> {
    const service = await tx.service.findUnique({
      where: { id: input.serviceId },
      select: { id: true, name: true, pricePaise: true, taxRateBasisPoints: true },
    });
    if (!service) throw new NotFoundException('Service not found');

    const invoice = await this.ensureInvoiceForDiagnosticOrder(
      tx,
      tenantId,
      { patientId: input.patientId, visitAppointmentId: input.visitAppointmentId },
      meta,
    );

    const line = await this.addDiagnosticLine(
      tx,
      tenantId,
      invoice.id,
      { patientId: input.patientId, serviceId: service.id, description: input.description },
      meta,
    );

    return { invoiceId: invoice.id, lineId: line.id };
  }

  /**
   * One test as a line on an invoice that is already open.
   *
   * Split out of `chargeDiagnosticTest` for the walk-in batch, which opens ONE
   * invoice and then adds several tests to it — calling the whole of
   * `chargeDiagnosticTest` per test would ask for a fresh invoice each time and
   * hand the patient a bill per film.
   *
   * Deliberately does not go through `loadEditable`: the caller has already
   * established that this invoice will take a line, and re-checking per test in
   * a batch would make the third test's refusal depend on the first two.
   */
  async addDiagnosticLine(
    tx: TenantClient,
    tenantId: string,
    invoiceId: string,
    input: { patientId: string; serviceId: string; description: string },
    meta: RequestMeta,
  ): Promise<{ id: string }> {
    const service = await tx.service.findUnique({
      where: { id: input.serviceId },
      select: { id: true, pricePaise: true, taxRateBasisPoints: true },
    });
    if (!service) throw new NotFoundException('Service not found');

    const taxPaise = Math.round((service.pricePaise * service.taxRateBasisPoints) / 10000);

    const line = await tx.invoiceLine.create({
      data: {
        tenantId,
        invoiceId,
        serviceId: service.id,
        description: input.description,
        quantity: 1,
        unitPricePaise: service.pricePaise,
        taxRateBasisPoints: service.taxRateBasisPoints,
        taxPaise,
        totalPaise: service.pricePaise + taxPaise,
      },
      select: { id: true },
    });

    await this.retotal(tx, invoiceId);

    await this.audit.record(tx, tenantId, {
      action: 'invoice.add_line',
      resourceType: 'Invoice',
      resourceId: invoiceId,
      patientId: input.patientId,
      changedFields: ['lines', 'totalPaise'],
      ...meta,
    });

    return line;
  }

  /**
   * Can another line go on this invoice?
   *
   * The same two conditions `loadEditable` refuses on, asked rather than
   * enforced. They are separate functions because the answers differ: a finance
   * user editing a bill needs to be told why they cannot, while the doctor's
   * order simply moves to a bill that will take it.
   */
  private async acceptsMoreLines(
    tx: TenantClient,
    invoice: { id: string; totalPaise: number; activePromotionApplicationId: string | null },
  ): Promise<boolean> {
    if (invoice.activePromotionApplicationId) return false;
    const { paidPaise, refundedPaise } = await this.totals(tx, invoice.id, invoice.totalPaise);
    return paidPaise - refundedPaise <= 0;
  }

  /**
   * Take a declined test's charge off the bill.
   *
   * **Deleted, not discounted to zero.** The first version of this wrote the
   * line's own value into `discountPaise` so the invoice would still show that
   * the test had been ordered. That was wrong in three ways at once, all of
   * them from reusing a column that already meant something else: the printed
   * bill showed the patient a charge they never incurred beside a discount they
   * never received; every guard that read `invoice.discountPaise` to detect a
   * promotion started firing on declines, which is why only one test could be
   * removed; and the revenue report, which sums line discounts, began counting
   * cancelled tests as money given away.
   *
   * The record is not lost by removing the line. `diagnostic_order` keeps the
   * DECLINED status and `audit_event` keeps who did it and when — which is
   * where that belongs. An invoice is a bill: it should say what is owed.
   *
   * `loadEditable` still guards it, so a bill with money on it refuses — that
   * is a refund, not a decline — and a promotion has to come off first.
   */
  async removeDiagnosticLine(
    tx: TenantClient,
    tenantId: string,
    lineId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const line = await tx.invoiceLine.findUnique({
      where: { id: lineId },
      select: { id: true, invoiceId: true },
    });
    if (!line) throw new NotFoundException('No charge to remove.');

    const invoice = await this.loadEditable(tx, line.invoiceId);

    await tx.invoiceLine.delete({ where: { id: line.id } });
    await this.retotal(tx, line.invoiceId);

    /**
     * A bill with nothing left on it is cancelled, not left at zero.
     *
     * Otherwise every declined single-test visit leaves a ₹0 invoice sitting on
     * the desk's outstanding list forever, and a list full of nothing is a list
     * nobody reads. CANCELLED carries a reason and an authoriser because the
     * table's CHECK requires both — the person who removed the last charge is
     * the honest answer to who authorised it.
     */
    const remaining = await tx.invoiceLine.count({ where: { invoiceId: line.invoiceId } });
    if (remaining === 0) {
      await tx.invoice.update({
        where: { id: line.invoiceId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          reason: 'Every charge on this bill was removed.',
          authorisedByUserId: meta.actorUserId ?? null,
        },
      });
    }

    await this.audit.record(tx, tenantId, {
      action: 'invoice.remove_line',
      resourceType: 'Invoice',
      resourceId: line.invoiceId,
      patientId: invoice.patientId,
      changedFields: remaining === 0 ? ['lines', 'totalPaise', 'status'] : ['lines', 'totalPaise'],
      ...meta,
    });
  }

  /**
   * May this test be performed and its result released?
   *
   * The diagnostics counterpart to `blockingReason`, and deliberately keyed on
   * the ORDER rather than the appointment. A walk-in test has no appointment,
   * and both flows have to answer to the same rule — an order that could be
   * released by taking a different route through the code is not a gate.
   *
   * Returns null when the test may proceed, or a reason when it may not. Only
   * two states block: an outstanding balance, and a voided bill. `LEGACY` and
   * `NOT_BILLED` pass, because neither is the patient failing to pay — one
   * predates billing entirely and the other is a test this clinic never priced.
   * Blocking those would freeze a worklist over a gap in the price list, which
   * is a problem for an administrator, not for the patient in the corridor.
   */
  async blockingReasonForOrder(tx: TenantClient, orderId: string): Promise<string | null> {
    const order = await tx.diagnosticOrder.findUnique({
      where: { id: orderId },
      select: DIAGNOSTIC_BILLING_SELECT,
    });
    if (!order) throw new NotFoundException('No such order.');

    const state = diagnosticBillingState(order);

    if (state.status === 'VOID') {
      return `Invoice ${state.invoiceNumber} was cancelled. Raise the charge again before releasing this result.`;
    }
    if (state.status === 'UNPAID') {
      return `${formatPaise(state.balancePaise)} outstanding on invoice ${state.invoiceNumber}. The bill has to be cleared before the result goes out.`;
    }
    return null;
  }

  /**
   * May this appointment join the queue?
   *
   * The whole point of the module, in one function. Returns null when the visit
   * may proceed, or a reason when it may not.
   */
  async blockingReason(tx: TenantClient, appointmentId: string): Promise<string | null> {
    const invoice = await tx.invoice.findUnique({
      where: { appointmentId },
      select: { id: true, status: true, totalPaise: true, number: true },
    });

    // No invoice at all — this clinic has not priced anything. See the note on
    // ensureInvoiceForAppointment.
    if (!invoice) return null;

    if (invoice.status === 'CANCELLED') {
      return `Invoice ${invoice.number} was cancelled. Raise a new one before checking in.`;
    }

    if ((SETTLED as readonly string[]).includes(invoice.status)) return null;

    const { balancePaise } = await this.totals(tx, invoice.id, invoice.totalPaise);
    if (balancePaise <= 0) return null;

    // "before issuing a token" until 12 Aug 2026, when tokens moved to booking.
    // The gate did not move; the sentence had to, because by check-in the
    // patient is already holding their token.
    return `${formatPaise(balancePaise)} outstanding on invoice ${invoice.number}. Collect payment before adding them to the queue.`;
  }

  async getForAppointment(tenantId: string, appointmentId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { appointmentId },
        select: { id: true },
      });
      if (!invoice) throw new NotFoundException('No invoice for this appointment');
      return this.view(tx, invoice.id);
    });
  }

  async get(tenantId: string, id: string) {
    return this.prisma.forTenant(tenantId, (tx) => this.view(tx, id));
  }

  /** Add a chargeable item to an unpaid invoice. */
  async addLine(
    tenantId: string,
    id: string,
    input: { serviceId?: string; description?: string; quantity?: number; unitPricePaise?: number },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const invoice = await this.loadEditable(tx, id);

      let description = input.description;
      let unitPricePaise = input.unitPricePaise;
      let taxRate = 0;
      let serviceId: string | undefined;

      if (input.serviceId) {
        const service = await tx.service.findUnique({
          where: { id: input.serviceId },
          select: { id: true, name: true, pricePaise: true, taxRateBasisPoints: true },
        });
        if (!service) throw new NotFoundException('Service not found');

        serviceId = service.id;
        description ??= service.name;
        unitPricePaise ??= service.pricePaise;
        taxRate = service.taxRateBasisPoints;
      }

      if (!description || unitPricePaise === undefined) {
        throw new BadRequestException('Give a service, or a description and a price.');
      }
      if (unitPricePaise < 0) throw new BadRequestException('A price cannot be negative.');

      const quantity = input.quantity ?? 1;
      const gross = quantity * unitPricePaise;
      const taxPaise = Math.round((gross * taxRate) / 10000);

      await tx.invoiceLine.create({
        data: {
          tenantId,
          invoiceId: id,
          ...(serviceId ? { serviceId } : {}),
          description,
          quantity,
          unitPricePaise,
          taxRateBasisPoints: taxRate,
          taxPaise,
          totalPaise: gross + taxPaise,
        },
      });

      await this.retotal(tx, id);

      await this.audit.record(tx, tenantId, {
        action: 'invoice.add_line',
        resourceType: 'Invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changedFields: ['lines', 'totalPaise'],
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  async removeLine(tenantId: string, id: string, lineId: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const invoice = await this.loadEditable(tx, id);

      const line = await tx.invoiceLine.findUnique({
        where: { id: lineId },
        select: {
          id: true,
          invoiceId: true,
          description: true,
          diagnosticOrder: { select: { id: true } },
        },
      });
      if (!line || line.invoiceId !== id) throw new NotFoundException('Line not found');

      /**
       * A test's charge is not removed, it is declined.
       *
       * The foreign key from `diagnostic_order.invoice_line_id` is RESTRICT, so
       * the delete below would fail anyway — but as a raw constraint violation,
       * which reaches the desk as a 500 and tells nobody anything. This says
       * what to do instead, and why: deleting the line would leave an order
       * pointing at a charge that no longer exists, and the pay-first gate
       * would read that as "never billed" and wave the test straight through.
       */
      if (line.diagnosticOrder) {
        throw new ConflictException({
          code: 'LINE_IS_A_TEST',
          message:
            `“${line.description}” is a test that was ordered. Decline the test instead — ` +
            'that takes the charge to zero and stops the department from running it.',
        });
      }

      await tx.invoiceLine.delete({ where: { id: lineId } });
      await this.retotal(tx, id);

      await this.audit.record(tx, tenantId, {
        action: 'invoice.remove_line',
        resourceType: 'Invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changedFields: ['lines', 'totalPaise'],
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /**
   * Take money.
   *
   * Appends a row rather than updating a total. Part cash, part UPI is an
   * ordinary Indian OPD transaction, and the day-end drawer is counted by mode —
   * a single `paidAmount` column would lose exactly the information the
   * reconciliation needs.
   */
  async collect(
    tenantId: string,
    id: string,
    input: { mode: string; amountPaise: number; reference?: string },
    meta: RequestMeta,
  ) {
    const collectedByUserId = meta.actorUserId;
    if (!collectedByUserId) throw new BadRequestException('A payment needs a collector.');

    return this.prisma.forTenant(tenantId, async (tx) => {
      // The balance below must be the one after any discount being applied or
      // taken off right now, not the one before it. See lockInvoice.
      await lockInvoice(tx, id);

      const invoice = await tx.invoice.findUnique({
        where: { id },
        select: { id: true, status: true, totalPaise: true, patientId: true, number: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');

      if (invoice.status === 'CANCELLED') {
        throw new ConflictException({
          code: 'INVOICE_CANCELLED',
          message: 'This invoice was cancelled.',
        });
      }
      if (invoice.status === 'WAIVED') {
        throw new ConflictException({
          code: 'INVOICE_WAIVED',
          message: 'This charge was waived. Reverse the waiver before collecting.',
        });
      }
      if (input.amountPaise <= 0) {
        throw new BadRequestException('A payment must be more than zero.');
      }

      const { balancePaise } = await this.totals(tx, id, invoice.totalPaise);

      // Overpayment is refused rather than absorbed. A clinic that takes ₹500
      // against a ₹300 bill owes ₹200, and a system that silently swallows it
      // has created a debt nobody recorded.
      if (input.amountPaise > balancePaise) {
        throw new ConflictException({
          code: 'OVERPAYMENT',
          message: `Only ${formatPaise(balancePaise)} is outstanding. Collect that or less.`,
          balancePaise,
        });
      }

      const payment = await tx.payment.create({
        data: {
          tenantId,
          invoiceId: id,
          direction: 'IN',
          mode: input.mode as never,
          amountPaise: input.amountPaise,
          reference: input.reference ?? null,
          collectedByUserId,
        },
        select: { id: true, collectedAt: true },
      });

      /**
       * The receipt, written in the same transaction as the payment.
       *
       * FR-RCP-01: every time the desk takes money, there is a receipt to hand
       * over. Created HERE rather than at print time so its figures are the ones
       * that were true when the money moved — a payment without a receipt is not
       * a state this database can hold.
       *
       * The money block is FROZEN rather than derived. Deriving it looked safe,
       * since the total cannot move while money sits on the invoice — but
       * `loadEditable` tests paid MINUS refunded, so a fully refunded invoice
       * becomes editable again and its total can change afterwards. A reprint
       * would then show a balance that was never true on the day.
       */
      const full = await tx.invoice.findUniqueOrThrow({
        where: { id },
        select: { subtotalPaise: true, discountPaise: true, taxPaise: true, totalPaise: true },
      });

      await tx.receipt.create({
        data: {
          tenantId,
          paymentId: payment.id,
          invoiceId: id,
          number: await this.nextReceiptNumber(tx, tenantId),
          totalChargedPaise: full.subtotalPaise,
          discountPaise: full.discountPaise,
          taxPaise: full.taxPaise,
          payablePaise: full.totalPaise,
          paidNowPaise: input.amountPaise,
          // What was still outstanding immediately after this payment. The
          // balance read above is the one BEFORE it.
          balancePaise: balancePaise - input.amountPaise,
          issuedAt: payment.collectedAt,
        },
      });

      await this.restatus(tx, id, invoice.totalPaise);

      await this.audit.record(tx, tenantId, {
        action: 'payment.collect',
        resourceType: 'Invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changedFields: ['payments', 'status'],
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /** Give money back. Never more than came in. */
  async refund(
    tenantId: string,
    id: string,
    input: { mode: string; amountPaise: number; reason: string; kind: string },
    meta: RequestMeta,
  ) {
    const collectedByUserId = meta.actorUserId;
    if (!collectedByUserId) throw new BadRequestException('A refund needs an author.');

    return this.prisma.forTenant(tenantId, async (tx) => {
      // Two refunds at once must both see each other: the ceiling below is
      // what came in minus what has ALREADY gone out. See lockInvoice.
      await lockInvoice(tx, id);

      const invoice = await tx.invoice.findUnique({
        where: { id },
        select: { id: true, totalPaise: true, patientId: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');

      const { paidPaise, refundedPaise } = await this.totals(tx, id, invoice.totalPaise);
      const refundable = paidPaise - refundedPaise;

      // The one rule that matters here: money cannot leave that never arrived.
      if (input.amountPaise > refundable) {
        throw new ConflictException({
          code: 'REFUND_EXCEEDS_PAYMENTS',
          message: `Only ${formatPaise(refundable)} can be refunded — that is what was actually collected.`,
          refundablePaise: refundable,
        });
      }

      await tx.payment.create({
        data: {
          tenantId,
          invoiceId: id,
          direction: 'REFUND',
          mode: input.mode as never,
          amountPaise: input.amountPaise,
          reason: input.reason,
          correctionKind: input.kind as never,
          collectedByUserId,
        },
      });

      await this.restatus(tx, id, invoice.totalPaise);

      await this.audit.record(tx, tenantId, {
        action: input.kind === 'RECORDED_IN_ERROR' ? 'payment.reverse' : 'payment.refund',
        resourceType: 'Invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changedFields: ['payments', 'status'],
        reason: input.reason,
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /** Write the charge off, defer it, or void the invoice. All need a reason. */
  async setException(
    tenantId: string,
    id: string,
    status: 'WAIVED' | 'DEFERRED' | 'CANCELLED',
    reason: string,
    meta: RequestMeta,
  ) {
    const authorisedByUserId = meta.actorUserId;
    if (!authorisedByUserId) throw new BadRequestException('An exception needs an authoriser.');

    return this.prisma.forTenant(tenantId, async (tx) => {
      // A payment in flight lands first, so "has money been taken?" below is
      // answered with it counted, and its status update can no longer write
      // over this one. See lockInvoice.
      await lockInvoice(tx, id);

      const invoice = await tx.invoice.findUnique({
        where: { id },
        select: { id: true, status: true, totalPaise: true, patientId: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');

      if (invoice.status === 'CANCELLED') {
        throw new ConflictException({
          code: 'INVOICE_CANCELLED',
          message: 'This invoice is already cancelled.',
        });
      }

      const { paidPaise, refundedPaise } = await this.totals(tx, id, invoice.totalPaise);

      // Waiving or cancelling a bill that has money against it would leave the
      // clinic holding cash with nothing to attribute it to. Refund first.
      if (status !== 'DEFERRED' && paidPaise - refundedPaise > 0) {
        throw new ConflictException({
          code: 'HAS_PAYMENTS',
          message: `${formatPaise(paidPaise - refundedPaise)} has been collected against this invoice. Refund it first.`,
        });
      }

      await tx.invoice.update({
        where: { id },
        data: {
          status,
          reason,
          authorisedByUserId,
          ...(status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
        },
      });

      await this.audit.record(tx, tenantId, {
        action: `invoice.${status.toLowerCase()}`,
        resourceType: 'Invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changedFields: ['status', 'reason'],
        reason,
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /**
   * What the clinic took today, by mode and by collector.
   *
   * One query over the payment rows rather than an assembly in application code:
   * this number gets compared against a physical cash drawer, and a total built
   * by summing several round trips is a total that can disagree with itself.
   */
  async dayCollection(tenantId: string, date?: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const tz = tenant.timezone;
      const day = date ?? clinicToday(tz);

      const from = localToInstant(day, '00:00', tz);
      const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

      const payments = await tx.payment.findMany({
        where: { collectedAt: { gte: from, lt: to } },
        select: {
          direction: true,
          correctionKind: true,
          mode: true,
          amountPaise: true,
          collectedByUserId: true,
          collectedAt: true,
          invoice: { select: { number: true, patient: { select: { name: true, uhid: true } } } },
        },
        orderBy: { collectedAt: 'asc' },
      });

      const collectors = await tx.user.findMany({ select: { id: true, fullName: true } });
      const nameOf = new Map(collectors.map((c) => [c.id, c.fullName]));

      const byMode = new Map<string, { collectedPaise: number; refundedPaise: number }>();
      const byCollector = new Map<string, { collectedPaise: number; refundedPaise: number }>();

      let collectedPaise = 0;
      let refundedPaise = 0;

      /**
       * The two halves of `refundedPaise`, kept apart — FR-BIL-11.
       *
       * Both reduce the day's net figure identically, and an owner counting the
       * drawer needs to know which: money that LEFT it, versus an entry that was
       * never real. `refundedPaise` stays as the sum of both so nothing reading
       * this report today changes meaning.
       */
      let patientRefundedPaise = 0;
      let reversedInErrorPaise = 0;

      for (const p of payments) {
        const modeRow = byMode.get(p.mode) ?? { collectedPaise: 0, refundedPaise: 0 };
        const userRow = byCollector.get(p.collectedByUserId) ?? {
          collectedPaise: 0,
          refundedPaise: 0,
        };

        if (p.direction === 'IN') {
          collectedPaise += p.amountPaise;
          modeRow.collectedPaise += p.amountPaise;
          userRow.collectedPaise += p.amountPaise;
        } else {
          refundedPaise += p.amountPaise;
          modeRow.refundedPaise += p.amountPaise;
          userRow.refundedPaise += p.amountPaise;

          if (p.correctionKind === 'RECORDED_IN_ERROR') {
            reversedInErrorPaise += p.amountPaise;
          } else {
            // Null only on refunds that predate the distinction, and those were
            // labelled PATIENT_REFUND by the migration. Treated as such here too
            // rather than counted as neither.
            patientRefundedPaise += p.amountPaise;
          }
        }

        byMode.set(p.mode, modeRow);
        byCollector.set(p.collectedByUserId, userRow);
      }

      return {
        date: day,
        timezone: tz,
        collectedPaise,
        refundedPaise,
        /** Money that physically went back to a patient. */
        patientRefundedPaise,
        /** Entries that were never real — no money moved either way. */
        reversedInErrorPaise,
        netPaise: collectedPaise - refundedPaise,
        transactionCount: payments.length,
        byMode: [...byMode.entries()].map(([mode, v]) => ({
          mode,
          ...v,
          netPaise: v.collectedPaise - v.refundedPaise,
        })),
        byCollector: [...byCollector.entries()].map(([userId, v]) => ({
          userId,
          name: nameOf.get(userId) ?? 'Unknown',
          ...v,
          netPaise: v.collectedPaise - v.refundedPaise,
        })),
        transactions: payments.map((p) => ({
          direction: p.direction,
          correctionKind: p.correctionKind,
          mode: p.mode,
          amountPaise: p.amountPaise,
          collectedAt: p.collectedAt,
          collectedBy: nameOf.get(p.collectedByUserId) ?? 'Unknown',
          invoiceNumber: p.invoice.number,
          patient: p.invoice.patient,
        })),
      };
    });
  }

  /** Everything outstanding, for the front desk to chase. */
  async outstanding(tenantId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: { status: { in: ['UNPAID', 'PARTIALLY_PAID', 'DEFERRED'] } },
        orderBy: { issuedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          number: true,
          status: true,
          totalPaise: true,
          issuedAt: true,
          reason: true,
          patient: { select: { id: true, name: true, uhid: true, mobile: true } },
          payments: { select: { direction: true, amountPaise: true } },
        },
      });

      return {
        invoices: invoices.map((i) => {
          const paid = sum(i.payments.filter((p) => p.direction === 'IN'));
          const refunded = sum(i.payments.filter((p) => p.direction === 'REFUND'));
          return {
            id: i.id,
            number: i.number,
            status: i.status,
            totalPaise: i.totalPaise,
            balancePaise: i.totalPaise - (paid - refunded),
            issuedAt: i.issuedAt,
            reason: i.reason,
            patient: i.patient,
          };
        }),
      };
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * The next receipt number. Its own sequence, not the invoice's.
   *
   * One invoice can produce several receipts, so they cannot share a number
   * without a suffix — and a receipt with a suffix invites somebody to invent
   * one. Same atomic function pattern as invoice numbering, against its own
   * counter table.
   */
  private async nextReceiptNumber(tx: TenantClient, tenantId: string): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ next_receipt_number: string }>>`
      SELECT next_receipt_number(${tenantId}::uuid)
    `;
    const number = rows[0]?.next_receipt_number;
    if (!number) {
      throw new Error('Receipt numbering returned nothing — is the receipts migration applied?');
    }
    return number;
  }

  private async nextNumber(tx: TenantClient, tenantId: string): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ next_invoice_number: string }>>`
      SELECT next_invoice_number(${tenantId}::uuid)
    `;
    const number = rows[0]?.next_invoice_number;
    if (!number) {
      throw new Error('Invoice numbering returned nothing — is the billing migration applied?');
    }
    return number;
  }

  /** An invoice may only be edited before money has changed hands. */
  /**
   * May this invoice's LINES still be changed?
   *
   * The one gate `addLine` and `removeLine` share, so every rule about editing a
   * bill lives here rather than being remembered twice.
   */
  private async loadEditable(tx: TenantClient, id: string) {
    /**
     * Locked first, like a discount and a payment, and for the ORDER as much as
     * the check. Every path that changes a bill's lines comes through here
     * before touching a line, so all of them take the invoice before its lines
     * — the order applying and removing a discount use. Without it, removing a
     * charge locked the line first and the invoice second while a discount did
     * the reverse, and the two deadlocked. It also means the promotion and
     * payment checks below cannot be passed by a discount or a payment that
     * commits a moment later.
     */
    await lockInvoice(tx, id);

    const invoice = await tx.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        patientId: true,
        totalPaise: true,
        activePromotion: { select: { promotion: { select: { code: true } } } },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === 'CANCELLED' || invoice.status === 'WAIVED') {
      throw new ConflictException({
        code: 'NOT_EDITABLE',
        message: `This invoice is ${invoice.status.toLowerCase()}.`,
      });
    }

    /**
     * NOT WHILE A DISCOUNT IS ON THE BILL.
     *
     * A promotion's discount is DISTRIBUTED across the lines, so adding or
     * removing one leaves the invoice arithmetically correct — `retotal` sums
     * whatever line discounts remain — while making the RECORD wrong.
     * `promotion_application.discount_paise` was frozen at apply time and that
     * table is append-only, so it keeps claiming the original amount. The
     * finance report reads that row, and the clinic ends up reported as giving
     * away more (or less) than it did.
     *
     * Refusing here rather than trying to re-spread the discount is deliberate:
     * re-spreading would mean rewriting an append-only row, and the correct
     * shape for that already exists — take the discount off, which writes a
     * compensating reversal, change the charges, apply it again, which writes a
     * fresh and honest row.
     *
     * The finance desk already hides its buttons in this state. This is the
     * layer underneath, for a direct API call or a second tab — the same
     * reasoning as putting tenant isolation in the database rather than in a
     * `WHERE` clause somebody has to remember.
     */
    if (invoice.activePromotion) {
      throw new ConflictException({
        code: 'PROMOTION_APPLIED',
        message:
          `${invoice.activePromotion.promotion.code} is on this bill. Take the discount off ` +
          'before changing the charges, then apply it again.',
      });
    }

    const { paidPaise, refundedPaise } = await this.totals(tx, id, invoice.totalPaise);
    if (paidPaise - refundedPaise > 0) {
      throw new ConflictException({
        code: 'ALREADY_PAID',
        message: 'Money has been collected against this invoice. Refund it before changing it.',
      });
    }

    return invoice;
  }

  private async totals(tx: TenantClient, invoiceId: string, totalPaise: number) {
    const payments = await tx.payment.findMany({
      where: { invoiceId },
      select: { direction: true, amountPaise: true },
    });

    const paidPaise = sum(payments.filter((p) => p.direction === 'IN'));
    const refundedPaise = sum(payments.filter((p) => p.direction === 'REFUND'));

    return {
      paidPaise,
      refundedPaise,
      balancePaise: totalPaise - (paidPaise - refundedPaise),
    };
  }

  /** Recompute the invoice header from its lines. */
  private async retotal(tx: TenantClient, id: string): Promise<void> {
    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId: id },
      select: { quantity: true, unitPricePaise: true, discountPaise: true, taxPaise: true },
    });

    const subtotalPaise = lines.reduce((n, l) => n + l.quantity * l.unitPricePaise, 0);
    const discountPaise = lines.reduce((n, l) => n + l.discountPaise, 0);
    const taxPaise = lines.reduce((n, l) => n + l.taxPaise, 0);

    await tx.invoice.update({
      where: { id },
      data: {
        subtotalPaise,
        discountPaise,
        taxPaise,
        totalPaise: subtotalPaise - discountPaise + taxPaise,
      },
    });
  }

  /**
   * Set the status from the payment rows.
   *
   * Status is derived, never independently tracked — an invoice that says PAID
   * while its payments say otherwise is the kind of disagreement nobody notices
   * until the month-end.
   */
  private async restatus(tx: TenantClient, id: string, totalPaise: number): Promise<void> {
    const { paidPaise, refundedPaise } = await this.totals(tx, id, totalPaise);
    const net = paidPaise - refundedPaise;

    const status =
      net >= totalPaise && totalPaise > 0 ? 'PAID' : net > 0 ? 'PARTIALLY_PAID' : 'UNPAID';

    await tx.invoice.update({ where: { id }, data: { status } });
  }

  private async view(tx: TenantClient, id: string) {
    const invoice = await tx.invoice.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, uhid: true, name: true, mobile: true } },
        lines: {
          orderBy: { createdAt: 'asc' },
          /**
           * Which lines are tests, so the desk can offer Decline on those and
           * only those. Deleting one is refused — see `removeLine` — and a
           * button that only produces an error is worse than no button.
           */
          include: { diagnosticOrder: { select: { id: true, status: true } } },
        },
        payments: { orderBy: { collectedAt: 'asc' } },
        appointment: {
          select: {
            id: true,
            startAt: true,
            status: true,
            externalTestNote: true,
            practitioner: { select: { fullName: true, prefix: true } },
          },
        },
        /**
         * A test bill has no `appointment` of its own — that column is unique
         * and belongs to the consultation invoice. Without this the desk would
         * see no doctor and no external-test note on exactly the bills where
         * both matter most.
         */
        visitAppointment: {
          select: {
            id: true,
            startAt: true,
            status: true,
            externalTestNote: true,
            practitioner: { select: { fullName: true, prefix: true } },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const paidPaise = sum(invoice.payments.filter((p) => p.direction === 'IN'));
    const refundedPaise = sum(invoice.payments.filter((p) => p.direction === 'REFUND'));

    /**
     * FR-BIL-13 — who did this, in words.
     *
     * A second query rather than a relation: `payment.collected_by_user_id` has
     * no foreign key, so Prisma cannot join it without a schema change, and
     * adding one to a table this old risks failing on any row whose author has
     * since been removed. One extra query when an invoice is opened is the
     * cheaper trade.
     *
     * The reason text needs no work at all — `include` was already returning it
     * and nothing displayed it, which is the whole of what FR-BIL-13 was asking
     * for on the server side.
     */
    const authorIds = [...new Set(invoice.payments.map((p) => p.collectedByUserId))];
    const authors = authorIds.length
      ? await tx.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const nameOf = new Map(authors.map((a) => [a.id, a.fullName]));

    /**
     * Tests taken off this visit's bills, so the desk can put one back.
     *
     * A declined test has no line any more — that is the point of the removal —
     * so it cannot appear in `lines`, and without this the only way back from a
     * mis-click would be a telephone call to the doctor. Keyed on the visit
     * rather than on this invoice, because the charge may have been on an
     * earlier bill for the same visit that has since been cancelled.
     *
     * Served here, on `invoice:read`, rather than through the diagnostics API:
     * the finance role holds no diagnostic permission at all, and widening that
     * to buy one list would hand the desk the whole clinical worklist.
     */
    const removedTests = invoice.visitAppointmentId
      ? await tx.diagnosticOrder.findMany({
          where: {
            appointmentId: invoice.visitAppointmentId,
            status: 'DECLINED',
            invoiceLineId: null,
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            description: true,
            service: { select: { name: true, pricePaise: true } },
          },
        })
      : [];

    return {
      ...invoice,
      removedTests,
      payments: invoice.payments.map((p) => ({
        ...p,
        collectedBy: { id: p.collectedByUserId, fullName: nameOf.get(p.collectedByUserId) ?? null },
      })),
      paidPaise,
      refundedPaise,
      balancePaise: invoice.totalPaise - (paidPaise - refundedPaise),
      /** True when the visit may proceed to the queue. */
      settled:
        (SETTLED as readonly string[]).includes(invoice.status) ||
        invoice.totalPaise - (paidPaise - refundedPaise) <= 0,
    };
  }
}

function sum(rows: Array<{ amountPaise: number }>): number {
  return rows.reduce((n, r) => n + r.amountPaise, 0);
}

/**
 * Paise → "₹350.00", for messages the front desk reads.
 *
 * The one place integers become a display string. Every other line of this
 * module works in paise.
 */
export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}
