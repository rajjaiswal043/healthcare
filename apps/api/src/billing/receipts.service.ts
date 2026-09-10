import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';

export interface RequestMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
}

/**
 * Receipts — FR-RCP-01, -02, -03.
 *
 * A RECEIPT IS FOR A PAYMENT, NOT FOR A BILL. Everything in this file follows
 * from that one sentence. A ₹1,100 bill paid ₹500 now and ₹600 on the way out is
 * one invoice and two receipts, each showing what was paid at that moment and
 * what remained afterwards. A receipt that restates the whole bill every time is
 * one a patient can use to claim they paid twice.
 *
 * The money block is read from the `receipt` row, not recomputed from the
 * invoice. It was frozen when the money moved — see the note on the model for
 * the refund path that made recomputation unsafe.
 *
 * The line items ARE read live from `invoice_line`, and that is correct: those
 * rows copied the service name and unit price at billing time and never point at
 * the current price. A receipt reprinted in 2029 shows the ₹500 that was
 * actually charged, not the ₹800 the X-ray costs by then (FR-PRC-03).
 */
@Injectable()
export class ReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything the printed sheet needs, for one payment. */
  async forPayment(tenantId: string, paymentId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const receipt = await tx.receipt.findUnique({
        where: { paymentId },
        select: {
          id: true,
          number: true,
          issuedAt: true,
          totalChargedPaise: true,
          discountPaise: true,
          taxPaise: true,
          payablePaise: true,
          paidNowPaise: true,
          balancePaise: true,
          invoiceId: true,
          payment: {
            select: { mode: true, reference: true, collectedByUserId: true, collectedAt: true },
          },
        },
      });

      if (!receipt) {
        // Either the payment is not ours, or it is a REFUND — nothing was
        // received, so there is no receipt and inventing one would put a
        // document in a patient's hand saying they paid when they were paid.
        throw new NotFoundException('No receipt for that payment.');
      }

      return this.render(tx, tenantId, receipt);
    });
  }

  /**
   * Record that this receipt went on paper, and say which print it was.
   *
   * The log is what makes DUPLICATE possible: without it there is no way to know
   * a second copy is a second copy, and two identical unmarked receipts for one
   * payment is how cash goes missing in a clinic. The person that exposes is the
   * finance desk, who cannot prove which copy was the original.
   *
   * Returns the printable payload as well, so the screen makes one call rather
   * than two and cannot render a sheet it forgot to log.
   */
  async recordPrint(tenantId: string, paymentId: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const receipt = await tx.receipt.findUnique({
        where: { paymentId },
        select: {
          id: true,
          number: true,
          issuedAt: true,
          totalChargedPaise: true,
          discountPaise: true,
          taxPaise: true,
          payablePaise: true,
          paidNowPaise: true,
          balancePaise: true,
          invoiceId: true,
          payment: {
            select: { mode: true, reference: true, collectedByUserId: true, collectedAt: true },
          },
        },
      });
      if (!receipt) throw new NotFoundException('No receipt for that payment.');

      await tx.receiptPrint.create({
        data: { tenantId, receiptId: receipt.id, printedByUserId: meta.actorUserId! },
      });

      // Counted after the insert, so the first print sees 1. A near-simultaneous
      // second print could read the same count; the log still holds both rows,
      // which is the part that matters for answering "how does a second copy
      // exist".
      const printCount = await tx.receiptPrint.count({ where: { receiptId: receipt.id } });

      const printedBy = meta.actorUserId
        ? await tx.user.findUnique({
            where: { id: meta.actorUserId },
            select: { fullName: true },
          })
        : null;

      const payload = await this.render(tx, tenantId, receipt);

      return {
        ...payload,
        print: {
          printCount,
          /** The first sheet is the receipt. Everything after it says so. */
          isDuplicate: printCount > 1,
          printedAt: new Date(),
          printedBy: printedBy?.fullName ?? 'Unknown',
        },
      };
    });
  }

  /** The print history, for whoever asks how a second copy exists. */
  async prints(tenantId: string, paymentId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const receipt = await tx.receipt.findUnique({
        where: { paymentId },
        select: { id: true, number: true },
      });
      if (!receipt) throw new NotFoundException('No receipt for that payment.');

      const prints = await tx.receiptPrint.findMany({
        where: { receiptId: receipt.id },
        orderBy: { printedAt: 'asc' },
        select: { printedAt: true, printedBy: { select: { fullName: true } } },
      });

      return {
        number: receipt.number,
        prints: prints.map((p, i) => ({
          printedAt: p.printedAt,
          printedBy: p.printedBy.fullName,
          isDuplicate: i > 0,
        })),
      };
    });
  }

  // --- internals ------------------------------------------------------------

  private async render(
    tx: TenantClient,
    tenantId: string,
    receipt: {
      id: string;
      number: string;
      issuedAt: Date;
      totalChargedPaise: number;
      discountPaise: number;
      taxPaise: number;
      payablePaise: number;
      paidNowPaise: number;
      balancePaise: number;
      invoiceId: string;
      payment: {
        mode: string;
        reference: string | null;
        collectedByUserId: string;
        collectedAt: Date;
      };
    },
  ) {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: receipt.invoiceId },
      select: {
        number: true,
        patient: {
          select: {
            uhid: true,
            name: true,
            mobile: true,
            gender: true,
            ageYears: true,
            birthDate: true,
          },
        },
        lines: {
          orderBy: { createdAt: 'asc' },
          select: {
            description: true,
            quantity: true,
            unitPricePaise: true,
            discountPaise: true,
            taxPaise: true,
            totalPaise: true,
          },
        },
        appointment: {
          select: {
            locationId: true,
            practitioner: { select: { fullName: true, prefix: true } },
          },
        },
        /**
         * The visit this bill came out of, which for a test bill is the ONLY
         * link it has: `appointment` above is the unique "this IS the
         * consultation bill" column, and a test invoice cannot hold it. Without
         * this, every test receipt printed a blank doctor and fell back to the
         * clinic's first location — wrong for anyone with two branches.
         */
        visitAppointment: {
          select: {
            locationId: true,
            practitioner: { select: { fullName: true, prefix: true } },
          },
        },
        /**
         * The promotion to NAME beside the discount.
         *
         * `activePromotion`, not the history: a reversed discount is not on this
         * bill any more, and the frozen `receipt.discountPaise` is what decides
         * whether a discount line prints at all. Safe to read live because a
         * discount cannot be applied or reversed once any payment exists, so
         * whatever is active now is what was active when this receipt was cut.
         */
        activePromotion: {
          select: { promotion: { select: { code: true, name: true } } },
        },
      },
    });

    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, contactMobile: true, logoUpdatedAt: true },
    });

    /**
     * The clinic's address for the letterhead.
     *
     * `tenant` has no address column — the only one in the schema lives on
     * `location`. Reached through the visit, which is where it actually
     * happened, and through `visitAppointment` so a test bill resolves it too.
     * A bill with no visit at all — a walk-in test — still has no location to
     * point at and falls back to the clinic's FIRST location rather than
     * printing a blank line: a receipt with no address is not much use to a
     * patient claiming from an employer, and most clinics have exactly one.
     */
    const visit = invoice.appointment ?? invoice.visitAppointment;

    const location = await tx.location.findFirst({
      where: visit?.locationId ? { id: visit.locationId } : {},
      orderBy: { createdAt: 'asc' },
      select: { name: true, addressLine: true, city: true },
    });

    const collectedBy = await tx.user.findUnique({
      where: { id: receipt.payment.collectedByUserId },
      select: { fullName: true },
    });

    const doctor = visit?.practitioner ?? null;

    return {
      receiptNumber: receipt.number,
      issuedAt: receipt.issuedAt,
      invoiceNumber: invoice.number,

      clinic: {
        name: tenant.name,
        phone: tenant.contactMobile,
        addressLine: location?.addressLine ?? null,
        city: location?.city ?? null,
        logoUpdatedAt: tenant.logoUpdatedAt,
      },

      patient: invoice.patient,

      /**
       * Null for a walk-in test, where there genuinely is no doctor, and left
       * null on purpose — the requirement is explicit that the receipt should
       * not pretend otherwise. A test ordered inside a consultation DOES have
       * one, and now names them: it is reached through `visitAppointment`.
       */
      doctor: doctor ? { fullName: doctor.fullName, prefix: doctor.prefix } : null,

      lines: invoice.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        // Rate × quantity, before this line's share of any discount. The
        // discount appears once, in the money block, named.
        amountPaise: l.quantity * l.unitPricePaise,
      })),

      /** In this order, never collapsed. */
      money: {
        totalChargedPaise: receipt.totalChargedPaise,
        discountPaise: receipt.discountPaise,
        discountLabel: invoice.activePromotion?.promotion.code ?? null,
        taxPaise: receipt.taxPaise,
        payablePaise: receipt.payablePaise,
        paidNowPaise: receipt.paidNowPaise,
        mode: receipt.payment.mode,
        reference: receipt.payment.reference,
        balancePaise: receipt.balancePaise,
      },

      /**
       * Whether to print a tax line at all.
       *
       * Decided from the stored figure rather than by the screen, so the sheet
       * and the record cannot disagree. No clinic on this platform is
       * GST-registered today, so this is false everywhere and the receipt stays
       * clean — but a clinic that starts charging tax gets the line without
       * anything being rebuilt.
       */
      showTax: receipt.taxPaise > 0,

      receivedBy: collectedBy?.fullName ?? 'Unknown',
    };
  }
}
