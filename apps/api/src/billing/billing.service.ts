import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
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
        select: { id: true, invoiceId: true },
      });
      if (!line || line.invoiceId !== id) throw new NotFoundException('Line not found');

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

      await tx.payment.create({
        data: {
          tenantId,
          invoiceId: id,
          direction: 'IN',
          mode: input.mode as never,
          amountPaise: input.amountPaise,
          reference: input.reference ?? null,
          collectedByUserId,
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
    input: { mode: string; amountPaise: number; reason: string },
    meta: RequestMeta,
  ) {
    const collectedByUserId = meta.actorUserId;
    if (!collectedByUserId) throw new BadRequestException('A refund needs an author.');

    return this.prisma.forTenant(tenantId, async (tx) => {
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
          collectedByUserId,
        },
      });

      await this.restatus(tx, id, invoice.totalPaise);

      await this.audit.record(tx, tenantId, {
        action: 'payment.refund',
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
        }

        byMode.set(p.mode, modeRow);
        byCollector.set(p.collectedByUserId, userRow);
      }

      return {
        date: day,
        timezone: tz,
        collectedPaise,
        refundedPaise,
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
  private async loadEditable(tx: TenantClient, id: string) {
    const invoice = await tx.invoice.findUnique({
      where: { id },
      select: { id: true, status: true, patientId: true, totalPaise: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === 'CANCELLED' || invoice.status === 'WAIVED') {
      throw new ConflictException({
        code: 'NOT_EDITABLE',
        message: `This invoice is ${invoice.status.toLowerCase()}.`,
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
        lines: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { collectedAt: 'asc' } },
        appointment: {
          select: {
            id: true,
            startAt: true,
            status: true,
            practitioner: { select: { fullName: true, prefix: true } },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const paidPaise = sum(invoice.payments.filter((p) => p.direction === 'IN'));
    const refundedPaise = sum(invoice.payments.filter((p) => p.direction === 'REFUND'));

    return {
      ...invoice,
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
