import { BadRequestException, Injectable } from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import { clinicToday, localToInstant } from '../scheduling/clinic-time.js';

/**
 * Finance reporting — FR-FIN-03, as amended by FR-DIA-15.
 *
 * The finance desk owns the numbers, and the owner asks them — not the doctor —
 * where the day's money went.
 *
 * **FR-FIN-03 ORIGINALLY SAID "SPLIT BY DOCTOR", AND THAT IS NO LONGER ENOUGH.**
 * A walk-in test patient never meets a doctor: they pay for a film, have it
 * done and leave. A report anchored on the practitioner cannot see them at all,
 * so all of that revenue would land in one nameless bucket and the department
 * that earned it would look idle. Since 11 Sep 2026 the answer is by doctor AND
 * by department — and, because they are three different businesses, by where
 * the work came from as well. See `byDepartment` for why collection is NOT
 * split department-wise, which is the part that surprises people.
 *
 * THE RULE THAT SHAPES EVERY FIGURE HERE: gross billed, discount given and net
 * collected are THREE SEPARATE NUMBERS, never one. A ₹600 consultation given
 * away free and recorded as a ₹0 bill leaves the clinic unable to say how much
 * it gave away and unable to pay a doctor on what they billed. Recorded as ₹600
 * billed less ₹600 discount, both questions have answers — so nothing in this
 * file ever collapses the three.
 *
 * TWO ANCHORS, DELIBERATELY. `collections` and `refunds` are anchored on when
 * the MONEY MOVED (`payment.collected_at`), because that is what reconciles a
 * drawer. `byDoctor`, `discounts` and `outstanding` are anchored on when the
 * BILL WAS RAISED (`invoice.issued_at`), because that is what a doctor's
 * activity and a clinic's exposure are made of. A payment taken on Tuesday
 * against Monday's bill therefore appears in Tuesday's collections and Monday's
 * by-doctor row. That is correct, and it is the sort of thing somebody notices
 * later and files as a bug, so it is written down here.
 *
 * Everything is integer paise. Every figure is derived from the rows that
 * already exist — there is no reporting table to fall out of step with them.
 */

export interface DateRange {
  /** Clinic-local `YYYY-MM-DD`, inclusive. */
  from: string;
  /** Clinic-local `YYYY-MM-DD`, inclusive. */
  to: string;
}

@Injectable()
export class FinanceReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(tenantId: string, query: { from?: string; to?: string }) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const tz = tenant.timezone;

      const from = query.from ?? clinicToday(tz);
      const to = query.to ?? from;

      if (to < from) {
        throw new BadRequestException('The end of the range is before its start.');
      }

      // Half-open, in clinic-local time: [from 00:00, to+1 day 00:00). The
      // clinic's day is what a clinic reports on, not the server's.
      const start = localToInstant(from, '00:00', tz);
      const end = new Date(localToInstant(to, '00:00', tz).getTime() + 24 * 60 * 60 * 1000);

      const [
        collections,
        byDoctor,
        byDepartment,
        byReferralSource,
        discounts,
        outstanding,
        refunds,
      ] = await Promise.all([
        this.collections(tx, start, end),
        this.byDoctor(tx, start, end),
        this.byDepartment(tx, start, end),
        this.byReferralSource(tx, start, end),
        this.discounts(tx, start, end),
        this.outstanding(tx, start, end),
        this.refunds(tx, start, end),
      ]);

      return {
        from,
        to,
        timezone: tz,
        collections,
        byDoctor,
        /**
         * FR-DIA-15, and it changes FR-FIN-03 with it: that requirement says
         * collections split by doctor, which cannot see a walk-in test patient
         * at all — they never meet a doctor. By doctor AND by department.
         */
        byDepartment,
        byReferralSource,
        discounts,
        outstanding,
        refundsAndReversals: refunds,
      };
    });
  }

  /**
   * What the clinic actually took, split by how it arrived.
   *
   * The day-collection report generalised from one day to a range. Cash, UPI and
   * card are what a clinic counts at close; the other modes are carried too
   * rather than folded into "other", because a mode that exists in the enum and
   * not in the report is money nobody can find.
   */
  private async collections(tx: TenantClient, start: Date, end: Date) {
    const payments = await tx.payment.findMany({
      where: { collectedAt: { gte: start, lt: end } },
      select: { direction: true, mode: true, amountPaise: true },
    });

    const byMode = new Map<string, { collectedPaise: number; refundedPaise: number }>();
    let collectedPaise = 0;
    let refundedPaise = 0;

    for (const p of payments) {
      const row = byMode.get(p.mode) ?? { collectedPaise: 0, refundedPaise: 0 };

      if (p.direction === 'IN') {
        collectedPaise += p.amountPaise;
        row.collectedPaise += p.amountPaise;
      } else {
        refundedPaise += p.amountPaise;
        row.refundedPaise += p.amountPaise;
      }

      byMode.set(p.mode, row);
    }

    return {
      collectedPaise,
      refundedPaise,
      netPaise: collectedPaise - refundedPaise,
      transactionCount: payments.length,
      byMode: [...byMode.entries()]
        .map(([mode, v]) => ({ mode, ...v, netPaise: v.collectedPaise - v.refundedPaise }))
        .sort((a, b) => a.mode.localeCompare(b.mode)),
    };
  }

  /**
   * Per doctor: how many patients, billed how much, discounted how much, and how
   * much of it came in.
   *
   * Attribution runs invoice line → invoice → appointment → practitioner. An
   * invoice with no appointment cannot be attributed to anybody and is collected
   * under a null practitioner rather than dropped — money that belongs to no
   * doctor still belongs to the clinic.
   *
   * THE ₹0 VISIT IS THE CASE TO GET RIGHT. A fully discounted consultation has
   * no payment row at all, so anything counting patients from payments would
   * lose it — the patient who was seen for free would be the one patient the
   * report cannot see. Counting from INVOICES rather than payments is what makes
   * that impossible, and it is why gross and discount are read off the lines.
   */
  private async byDoctor(tx: TenantClient, start: Date, end: Date) {
    const invoices = await tx.invoice.findMany({
      where: { issuedAt: { gte: start, lt: end }, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        patientId: true,
        lines: { select: { quantity: true, unitPricePaise: true, discountPaise: true } },
        payments: { select: { direction: true, amountPaise: true } },
        appointment: {
          select: {
            practitionerId: true,
            practitioner: { select: { fullName: true, prefix: true } },
          },
        },
      },
    });

    interface Row {
      practitionerId: string | null;
      name: string;
      patients: Set<string>;
      visits: number;
      grossPaise: number;
      discountPaise: number;
      netCollectedPaise: number;
    }

    const byId = new Map<string, Row>();

    for (const invoice of invoices) {
      const practitionerId = invoice.appointment?.practitionerId ?? null;
      const key = practitionerId ?? '__unattributed__';

      const doctor = invoice.appointment?.practitioner;
      const name = doctor
        ? `${doctor.prefix ? `${doctor.prefix} ` : ''}${doctor.fullName}`
        : 'Not attributed to a doctor';

      const row = byId.get(key) ?? {
        practitionerId,
        name,
        patients: new Set<string>(),
        visits: 0,
        grossPaise: 0,
        discountPaise: 0,
        netCollectedPaise: 0,
      };

      row.patients.add(invoice.patientId);
      row.visits += 1;

      // Gross is what was charged before anything came off it. Read from the
      // lines rather than `invoice.subtotal_paise` so the three figures all come
      // from one place and cannot disagree with each other.
      for (const line of invoice.lines) {
        row.grossPaise += line.quantity * line.unitPricePaise;
        row.discountPaise += line.discountPaise;
      }

      // A reversed discount already put its lines back to zero, so nothing here
      // has to know about reversals — the lines are the current truth.
      for (const payment of invoice.payments) {
        row.netCollectedPaise +=
          payment.direction === 'IN' ? payment.amountPaise : -payment.amountPaise;
      }

      byId.set(key, row);
    }

    return [...byId.values()]
      .map((r) => ({
        practitionerId: r.practitionerId,
        name: r.name,
        patientsSeen: r.patients.size,
        visits: r.visits,
        grossPaise: r.grossPaise,
        discountPaise: r.discountPaise,
        /** Gross less discount — what the clinic asked for after the discount. */
        netBilledPaise: r.grossPaise - r.discountPaise,
        netCollectedPaise: r.netCollectedPaise,
      }))
      .sort((a, b) => b.grossPaise - a.grossPaise);
  }

  /**
   * What each department billed, and what the clinic collected (FR-DIA-15).
   *
   * **TWO NUMBERS, AND THEY DO NOT RECONCILE. That is the honest answer.**
   *
   * Billing happens on a LINE — an X-ray belongs to radiology, a consultation
   * to the doctor who gave it — so "what did radiology bill" has an exact
   * answer and it is here, per department.
   *
   * Payment happens on an INVOICE. A patient handing over ₹800 for a bill
   * carrying a consultation and a blood test has not paid ₹500 to one
   * department and ₹300 to another; they have paid one bill. Splitting that
   * back out means inventing an allocation rule, and every rule available is
   * wrong in a way somebody will eventually have to defend:
   *
   *   - in proportion to line value invents a fact nobody agreed to, and a
   *     part payment then reports money to a department that has seen none;
   *   - counting only fully-paid invoices drops today's half-paid money
   *     entirely, which is most of it at a busy desk.
   *
   * So collection is reported where it actually happened — at invoice level,
   * for the clinic — and `totalBilledPaise` sits beside it so the gap between
   * asked-for and received is visible rather than smoothed away. A reader who
   * wants "radiology's revenue" gets radiology's BILLING, correctly labelled.
   * Decision 10, 11 Sep 2026.
   *
   * A line with no service, or a service with no department, buckets as
   * unassigned rather than being dropped: a free-text charge is still money,
   * and a gap in the price list is an administrator's problem to see.
   */
  private async byDepartment(tx: TenantClient, start: Date, end: Date) {
    const invoices = await tx.invoice.findMany({
      where: { issuedAt: { gte: start, lt: end }, status: { not: 'CANCELLED' } },
      select: {
        patientId: true,
        lines: {
          select: {
            quantity: true,
            unitPricePaise: true,
            discountPaise: true,
            // The join FR-DIA-15 needs, and the reason this is its own query
            // rather than a widening of `byDoctor`.
            service: {
              select: { departmentId: true, department: { select: { name: true } } },
            },
          },
        },
        payments: { select: { direction: true, amountPaise: true } },
      },
    });

    interface Row {
      departmentId: string | null;
      name: string;
      patients: Set<string>;
      items: number;
      grossPaise: number;
      discountPaise: number;
    }

    const byId = new Map<string, Row>();
    let collectedPaise = 0;

    for (const invoice of invoices) {
      for (const payment of invoice.payments) {
        collectedPaise += payment.direction === 'IN' ? payment.amountPaise : -payment.amountPaise;
      }

      for (const line of invoice.lines) {
        const departmentId = line.service?.departmentId ?? null;
        const key = departmentId ?? '__unassigned__';

        const row = byId.get(key) ?? {
          departmentId,
          name: line.service?.department?.name ?? 'Not assigned to a department',
          patients: new Set<string>(),
          items: 0,
          grossPaise: 0,
          discountPaise: 0,
        };

        row.patients.add(invoice.patientId);
        row.items += 1;
        row.grossPaise += line.quantity * line.unitPricePaise;
        row.discountPaise += line.discountPaise;

        byId.set(key, row);
      }
    }

    const rows = [...byId.values()]
      .map((r) => ({
        departmentId: r.departmentId,
        name: r.name,
        /**
         * Throughput, which FR-DIA-15 asks for separately because it is not the
         * same question as revenue: a department can be busy and cheap.
         */
        patientsSeen: r.patients.size,
        items: r.items,
        grossPaise: r.grossPaise,
        discountPaise: r.discountPaise,
        netBilledPaise: r.grossPaise - r.discountPaise,
      }))
      .sort((a, b) => b.netBilledPaise - a.netBilledPaise);

    return {
      rows,
      totalBilledPaise: rows.reduce((n, r) => n + r.netBilledPaise, 0),
      /**
       * At invoice level, for the clinic. See the note above on why it is not
       * split by department.
       *
       * Counted against THESE invoices — the ones issued in the range, whose
       * billing the rows above describe — so the two figures answer the same
       * question about the same work. That is deliberately NOT the same basis
       * as `collections`, which counts money that ARRIVED in the range on any
       * invoice, including yesterday's. Both are right; they are different
       * questions, and a reader comparing billed against collected wants this
       * one.
       */
      collectedPaise,
    };
  }

  /**
   * Where the diagnostic work came from (FR-DIA-15).
   *
   * Three different businesses wearing one uniform: tests our own doctors
   * generated, tests sent in by doctors elsewhere, and people who walked in and
   * asked. The owner's question — which outside doctors send the most work —
   * only has an answer because `referral_source` is STORED rather than inferred
   * from a null consultation.
   *
   * Counted on when the test was ORDERED, not when its bill was issued. The
   * question is how much work each source generated in the period, and a test
   * ordered on the last day of the month does not belong to the next one
   * because the money landed late.
   *
   * Value comes off the order's own invoice line, so a declined test — whose
   * line is gone — contributes a test and no money, which is exactly true.
   */
  private async byReferralSource(tx: TenantClient, start: Date, end: Date) {
    const orders = await tx.diagnosticOrder.findMany({
      where: { createdAt: { gte: start, lt: end }, status: { not: 'CANCELLED' } },
      select: {
        patientId: true,
        referralSource: true,
        referrerName: true,
        invoiceLine: {
          select: { quantity: true, unitPricePaise: true, discountPaise: true },
        },
      },
    });

    interface Row {
      patients: Set<string>;
      tests: number;
      netBilledPaise: number;
      referrers: Map<string, { tests: number; netBilledPaise: number }>;
    }

    const blank = (): Row => ({
      patients: new Set<string>(),
      tests: 0,
      netBilledPaise: 0,
      referrers: new Map(),
    });

    const bySource = new Map<string, Row>([
      ['INTERNAL', blank()],
      ['EXTERNAL_DOCTOR', blank()],
      ['SELF', blank()],
    ]);

    for (const order of orders) {
      const row = bySource.get(order.referralSource) ?? blank();
      const line = order.invoiceLine;
      const value = line ? line.quantity * line.unitPricePaise - line.discountPaise : 0;

      row.patients.add(order.patientId);
      row.tests += 1;
      row.netBilledPaise += value;

      if (order.referralSource === 'EXTERNAL_DOCTOR' && order.referrerName) {
        const entry = row.referrers.get(order.referrerName) ?? { tests: 0, netBilledPaise: 0 };
        entry.tests += 1;
        entry.netBilledPaise += value;
        row.referrers.set(order.referrerName, entry);
      }

      bySource.set(order.referralSource, row);
    }

    return [...bySource.entries()].map(([source, r]) => ({
      source,
      patients: r.patients.size,
      tests: r.tests,
      netBilledPaise: r.netBilledPaise,
      /**
       * Who sent it, for the external bucket only. Free text, so two spellings
       * of one doctor are two rows — the cost of not maintaining a list, and
       * the signal that tells the clinic when a list is worth maintaining.
       */
      referrers: [...r.referrers.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.tests - a.tests),
    }));
  }

  /**
   * Every discount actually given, and separately every one that was taken back.
   *
   * HOW GIVEN AND REVERSED ARE TOLD APART. A row in `promotion_application` is
   * an APPLICATION when `reversal_kind IS NULL`, and a compensating REVERSAL
   * when it is set, in which case `reverses_application_id` names the
   * application it undoes. So an application counts as GIVEN when nothing points
   * at it (`reversedBy: { none: {} }`) and as REVERSED when something does
   * (`reversedBy: { some: {} }`). The reversal rows themselves are never counted
   * directly — they would double the money, once as the discount and once as its
   * undoing.
   *
   * A reversed discount was never really given, so it is out of the totals. It
   * is still listed, on its own line: a discount applied and withdrawn is
   * something an owner should be able to see, and silently dropping it would
   * make the report disagree with the audit trail.
   */
  private async discounts(tx: TenantClient, start: Date, end: Date) {
    const select = {
      id: true,
      discountPaise: true,
      appliedAt: true,
      invoice: { select: { number: true, patient: { select: { name: true, uhid: true } } } },
      promotion: { select: { code: true, name: true, type: true, value: true } },
      appliedBy: { select: { id: true, fullName: true } },
      authorisedBy: { select: { id: true, fullName: true } },
    } as const;

    const [given, reversed] = await Promise.all([
      tx.promotionApplication.findMany({
        where: {
          appliedAt: { gte: start, lt: end },
          reversalKind: null,
          reversedBy: { none: {} },
        },
        select,
        orderBy: { appliedAt: 'asc' },
      }),
      tx.promotionApplication.findMany({
        where: {
          appliedAt: { gte: start, lt: end },
          reversalKind: null,
          reversedBy: { some: {} },
        },
        select: {
          ...select,
          reversedBy: {
            select: {
              reversalKind: true,
              appliedAt: true,
              appliedBy: { select: { fullName: true } },
            },
          },
        },
        orderBy: { appliedAt: 'asc' },
      }),
    ]);

    const shape = (row: (typeof given)[number]) => ({
      applicationId: row.id,
      promotionCode: row.promotion.code,
      promotionName: row.promotion.name,
      promotionType: row.promotion.type,
      promotionValue: row.promotion.value,
      discountPaise: row.discountPaise,
      appliedAt: row.appliedAt,
      appliedBy: row.appliedBy.fullName,
      authorisedBy: row.authorisedBy.fullName,
      invoiceNumber: row.invoice.number,
      patient: row.invoice.patient,
    });

    const byPromotion = new Map<string, { count: number; discountPaise: number }>();
    for (const row of given) {
      const entry = byPromotion.get(row.promotion.code) ?? { count: 0, discountPaise: 0 };
      entry.count += 1;
      entry.discountPaise += row.discountPaise;
      byPromotion.set(row.promotion.code, entry);
    }

    return {
      givenCount: given.length,
      givenPaise: given.reduce((n, r) => n + r.discountPaise, 0),
      /** Applied and then taken back. NOT part of `givenPaise`. */
      reversedCount: reversed.length,
      reversedPaise: reversed.reduce((n, r) => n + r.discountPaise, 0),
      given: given.map(shape),
      reversed: reversed.map((row) => ({
        ...shape(row),
        reversal: row.reversedBy[0]
          ? {
              kind: row.reversedBy[0].reversalKind,
              at: row.reversedBy[0].appliedAt,
              by: row.reversedBy[0].appliedBy.fullName,
            }
          : null,
      })),
      byPromotion: [...byPromotion.entries()]
        .map(([code, v]) => ({ code, ...v }))
        .sort((a, b) => b.discountPaise - a.discountPaise),
    };
  }

  /**
   * What the clinic is still owed from bills raised in the range.
   *
   * The balance is DERIVED from payment rows every time, never read from a
   * stored field. `invoice.status` says PAID or UNPAID, but status is a
   * summary and a summary can be stale; the payments are what happened.
   *
   * Deferred invoices are listed apart because they are a different
   * conversation: an unpaid bill is somebody who has not paid yet, a deferred
   * one is somebody an administrator decided may pay later.
   */
  private async outstanding(tx: TenantClient, start: Date, end: Date) {
    const invoices = await tx.invoice.findMany({
      where: {
        issuedAt: { gte: start, lt: end },
        status: { notIn: ['CANCELLED', 'WAIVED'] },
      },
      select: {
        id: true,
        number: true,
        status: true,
        totalPaise: true,
        issuedAt: true,
        patient: { select: { name: true, uhid: true, mobile: true } },
        payments: { select: { direction: true, amountPaise: true } },
      },
      orderBy: { issuedAt: 'asc' },
    });

    const unpaid: Array<Record<string, unknown>> = [];
    const deferred: Array<Record<string, unknown>> = [];

    let unpaidPaise = 0;
    let deferredPaise = 0;

    for (const invoice of invoices) {
      const paid = invoice.payments.reduce(
        (n, p) => n + (p.direction === 'IN' ? p.amountPaise : -p.amountPaise),
        0,
      );
      const balancePaise = invoice.totalPaise - paid;

      // Zero and below is settled. Below zero would mean an overpayment, which
      // is not something to chase.
      if (balancePaise <= 0) continue;

      const row = {
        invoiceId: invoice.id,
        number: invoice.number,
        status: invoice.status,
        issuedAt: invoice.issuedAt,
        totalPaise: invoice.totalPaise,
        paidPaise: paid,
        balancePaise,
        patient: invoice.patient,
      };

      if (invoice.status === 'DEFERRED') {
        deferred.push(row);
        deferredPaise += balancePaise;
      } else {
        unpaid.push(row);
        unpaidPaise += balancePaise;
      }
    }

    return {
      count: unpaid.length,
      totalPaise: unpaidPaise,
      invoices: unpaid,
      deferred: { count: deferred.length, totalPaise: deferredPaise, invoices: deferred },
    };
  }

  /**
   * Money that went back, split by whether it went back to anybody.
   *
   * FR-BIL-11's distinction, over a range. Both reduce the net figure
   * identically and an owner counting the drawer needs to know which: a
   * PATIENT_REFUND left the drawer, a RECORDED_IN_ERROR entry was never real.
   * Treating them as one number makes a clinic look like it refunds far more
   * than it does.
   */
  private async refunds(tx: TenantClient, start: Date, end: Date) {
    const rows = await tx.payment.findMany({
      where: { direction: 'REFUND', collectedAt: { gte: start, lt: end } },
      select: {
        amountPaise: true,
        mode: true,
        correctionKind: true,
        reason: true,
        collectedAt: true,
        collectedByUserId: true,
        invoice: { select: { number: true, patient: { select: { name: true, uhid: true } } } },
      },
      orderBy: { collectedAt: 'asc' },
    });

    const staff = await tx.user.findMany({ select: { id: true, fullName: true } });
    const nameOf = new Map(staff.map((s) => [s.id, s.fullName]));

    let patientRefundedPaise = 0;
    let recordedInErrorPaise = 0;

    for (const row of rows) {
      // Null only on refunds predating the distinction, which the migration
      // labelled PATIENT_REFUND. Counted the same way here rather than as
      // neither, so the two halves always sum to the whole.
      if (row.correctionKind === 'RECORDED_IN_ERROR') recordedInErrorPaise += row.amountPaise;
      else patientRefundedPaise += row.amountPaise;
    }

    return {
      patientRefundedPaise,
      recordedInErrorPaise,
      totalPaise: patientRefundedPaise + recordedInErrorPaise,
      entries: rows.map((r) => ({
        amountPaise: r.amountPaise,
        mode: r.mode,
        correctionKind: r.correctionKind ?? 'PATIENT_REFUND',
        reason: r.reason,
        collectedAt: r.collectedAt,
        collectedBy: nameOf.get(r.collectedByUserId) ?? 'Unknown',
        invoiceNumber: r.invoice.number,
        patient: r.invoice.patient,
      })),
    };
  }
}
