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
import { clinicToday } from '../scheduling/clinic-time.js';
import { planDiscount } from './promotion-maths.js';
import { formatPaise } from './billing.service.js';

export interface RequestMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
}

/** A calendar date with no time, the way the `date` columns store it. */
function toDateOnly(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

/**
 * Promotions — defining them, and applying one to a bill.
 *
 * Two audiences with two permissions, and the split is the control. The
 * administrator DEFINES what a discount may be (`promotion:manage`); the finance
 * desk APPLIES one that already exists (`promotion:apply`). Nobody holds both
 * except the administrator, who holds everything. That is the whole point: today
 * a discount is a verbal instruction and a hand-written note, and the failure
 * mode being designed against is the person taking the money inventing the
 * discount they are about to give.
 *
 * Money is integer paise throughout. The arithmetic lives in
 * `promotion-maths.ts` so it can be read and tested without a database.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async timezone(tx: TenantClient, tenantId: string): Promise<string> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return tenant.timezone;
  }

  async create(
    tenantId: string,
    input: {
      code: string;
      name: string;
      description?: string;
      type: 'PERCENTAGE' | 'FLAT' | 'CUSTOM';
      /** Absent for CUSTOM, whose amount is not known until there is a bill. */
      value?: number;
      maxDiscountPaise?: number;
      validFrom: string;
      validTo?: string;
    },
    meta: RequestMeta,
  ) {
    const code = input.code.trim().toUpperCase();

    if (input.validTo && toDateOnly(input.validTo) < toDateOnly(input.validFrom)) {
      throw new ConflictException({
        code: 'DATES_OUT_OF_ORDER',
        message: 'A promotion cannot end before it begins.',
      });
    }

    return this.prisma.forTenant(tenantId, async (tx) => {
      const clash = await tx.promotion.findFirst({ where: { code }, select: { id: true } });
      if (clash) {
        // A clean 409 rather than the unique index's raw error. Codes are per
        // tenant, so this says nothing about any other clinic.
        throw new ConflictException({
          code: 'CODE_IN_USE',
          message: `This clinic already has a promotion called ${code}.`,
        });
      }

      const promotion = await tx.promotion.create({
        data: {
          tenantId,
          code,
          name: input.name.trim(),
          ...(input.description ? { description: input.description.trim() } : {}),
          type: input.type,
          // `null`, not `undefined`: CUSTOM stores no value, and the CHECK
          // constraint requires the column to be actually null rather than
          // defaulted. Same for the cap, which CUSTOM may not carry at all.
          value: input.value ?? null,
          maxDiscountPaise: input.maxDiscountPaise ?? null,
          validFrom: toDateOnly(input.validFrom),
          validTo: input.validTo ? toDateOnly(input.validTo) : null,
          createdByUserId: meta.actorUserId!,
        },
      });

      await this.audit.record(tx, tenantId, {
        action: 'promotion.create',
        resourceType: 'Promotion',
        resourceId: promotion.id,
        changedFields: ['code', 'type', 'value'],
        ...meta,
      });

      return this.view(tx, promotion.id);
    });
  }

  /**
   * Edit a promotion that has never been used.
   *
   * FR-PRO-01: "A promotion that has ever been used cannot be deleted or edited,
   * only switched off. An invoice from March has to keep explaining itself in
   * September." Editing a used promotion would not change the discount already
   * taken — `promotion_application.discount_paise` is stored — but it would
   * change what the record SAYS that discount was, which is worse: a report
   * that reads back a different reason than the one given.
   */
  async update(
    tenantId: string,
    id: string,
    input: {
      name?: string;
      description?: string;
      value?: number;
      maxDiscountPaise?: number;
      validFrom?: string;
      validTo?: string;
    },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const promotion = await this.load(tx, id);

      const used = await tx.promotionApplication.count({ where: { promotionId: id } });
      if (used > 0) {
        throw new ConflictException({
          code: 'PROMOTION_IN_USE',
          message:
            `${promotion.code} has been applied to ${used} bill${used === 1 ? '' : 's'} and ` +
            'can no longer be edited. Switch it off and create a new one.',
        });
      }

      /**
       * A CUSTOM promotion has no value and no cap, and editing cannot give it
       * either — `type` is not editable, so the row would still be CUSTOM and
       * the CHECK constraint would refuse the write. Caught here so the answer
       * is a sentence rather than a 500 with a constraint name in it.
       */
      if (
        promotion.type === 'CUSTOM' &&
        (input.value !== undefined || input.maxDiscountPaise !== undefined)
      ) {
        throw new ConflictException({
          code: 'CUSTOM_HAS_NO_VALUE',
          message:
            `${promotion.code} is a custom promotion — its amount is typed when it is applied, ` +
            'so it has no value and no maximum to edit.',
        });
      }

      const validFrom = input.validFrom ? toDateOnly(input.validFrom) : promotion.validFrom;
      const validTo = input.validTo === undefined ? promotion.validTo : toDateOnly(input.validTo);

      if (validTo && validTo < validFrom) {
        throw new ConflictException({
          code: 'DATES_OUT_OF_ORDER',
          message: 'A promotion cannot end before it begins.',
        });
      }

      // A percentage stays 1–100 whichever way it is edited. The CHECK holds
      // this too; the message is what makes it fixable.
      if (input.value !== undefined && promotion.type === 'PERCENTAGE' && input.value > 100) {
        throw new ConflictException({
          code: 'VALUE_OUT_OF_RANGE',
          message: 'A percentage promotion is between 1 and 100.',
        });
      }

      await tx.promotion.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description.trim() } : {}),
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.maxDiscountPaise !== undefined
            ? { maxDiscountPaise: input.maxDiscountPaise }
            : {}),
          validFrom,
          validTo,
        },
      });

      await this.audit.record(tx, tenantId, {
        action: 'promotion.update',
        resourceType: 'Promotion',
        resourceId: id,
        changedFields: Object.keys(input),
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /**
   * Switch a promotion off, or back on.
   *
   * This is the delete. There is no DELETE endpoint and the app role has no
   * DELETE privilege on the table — an invoice that was discounted in March has
   * to keep naming the thing that discounted it.
   */
  async setActive(tenantId: string, id: string, isActive: boolean, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      await this.load(tx, id);

      await tx.promotion.update({ where: { id }, data: { isActive } });

      await this.audit.record(tx, tenantId, {
        action: isActive ? 'promotion.activate' : 'promotion.deactivate',
        resourceType: 'Promotion',
        resourceId: id,
        changedFields: ['isActive'],
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /**
   * The clinic's promotions.
   *
   * `applicable` narrows to what the finance desk could use right now — switched
   * on, and today inside the validity window. Today is the CLINIC's today: a
   * camp offer ending on the 30th ends when the clinic's day ends, not when a
   * server in another timezone rolls over.
   */
  async list(tenantId: string, applicableOnly: boolean) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const today = toDateOnly(clinicToday(await this.timezone(tx, tenantId)));

      const promotions = await tx.promotion.findMany({
        where: applicableOnly
          ? {
              isActive: true,
              validFrom: { lte: today },
              OR: [{ validTo: null }, { validTo: { gte: today } }],
            }
          : {},
        orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      });

      // Usage counts, so the roles screen can say why one cannot be edited
      // before the administrator tries and is refused.
      const usage = await tx.promotionApplication.groupBy({
        by: ['promotionId'],
        _count: { _all: true },
      });
      const usedBy = new Map(usage.map((u) => [u.promotionId, u._count._all]));

      return {
        promotions: promotions.map((p) => ({
          ...shape(p),
          timesApplied: usedBy.get(p.id) ?? 0,
          editable: (usedBy.get(p.id) ?? 0) === 0,
        })),
      };
    });
  }

  /**
   * Apply a promotion to a bill (FR-PRO-02).
   *
   * The discount is a LINE ON THE INVOICE, not a changed price. The doctor's fee
   * still reads ₹600 and the discount reads −₹300, because a bill that simply
   * says ₹300 has lost the fact that anything was given away — and with it the
   * clinic's ability to say how much it discounts, or to pay a doctor on what
   * they billed.
   *
   * Every refusal below has its own code, because "cannot apply" is four
   * different conversations at the desk and the person holding the phone needs
   * to know which one they are having.
   */
  async apply(
    tenantId: string,
    invoiceId: string,
    input: {
      code?: string;
      promotionId?: string;
      authorisedByUserId: string;
      customDiscountPaise?: number;
    },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      // Before reading anything: see lockInvoice. A second discount or a payment
      // racing this one waits here, and what is read below is what it left.
      await lockInvoice(tx, invoiceId);

      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          status: true,
          patientId: true,
          totalPaise: true,
          activePromotion: { select: { id: true, promotion: { select: { code: true } } } },
        },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');

      // --- the invoice must still be discountable ---------------------------

      if (invoice.activePromotion) {
        // `invoice.active_promotion_application_id` is a single column, so two
        // at once is not expressible. This turns that into something the desk
        // can act on rather than a foreign-key error.
        throw new ConflictException({
          code: 'PROMOTION_ALREADY_APPLIED',
          message: `${invoice.activePromotion.promotion.code} is already on this bill.`,
        });
      }

      if (invoice.status === 'CANCELLED' || invoice.status === 'WAIVED') {
        throw new ConflictException({
          code: 'NOT_DISCOUNTABLE',
          message: `This invoice is ${invoice.status.toLowerCase()}.`,
        });
      }

      /**
       * Before payment only.
       *
       * ANY payment row, in either direction. Once money has moved, reducing the
       * bill is a refund or a correction — an administrator's job, already
       * built, and carrying its own reason and authoriser. Silently discounting
       * a paid invoice would leave it looking overpaid with nothing explaining
       * why.
       */
      const payments = await tx.payment.count({ where: { invoiceId } });
      if (payments > 0) {
        throw new ConflictException({
          code: 'PAYMENT_ALREADY_TAKEN',
          message:
            'Money has already been taken on this bill. A discount after payment is a refund — ' +
            'an administrator does that.',
        });
      }

      // --- the promotion must be usable today -------------------------------

      const promotion = input.promotionId
        ? await tx.promotion.findUnique({ where: { id: input.promotionId } })
        : await tx.promotion.findFirst({ where: { code: input.code!.trim().toUpperCase() } });

      if (!promotion) throw new NotFoundException('Promotion not found');

      if (!promotion.isActive) {
        throw new ConflictException({
          code: 'PROMOTION_INACTIVE',
          message: `${promotion.code} has been switched off.`,
        });
      }

      const today = toDateOnly(clinicToday(await this.timezone(tx, tenantId)));
      if (promotion.validFrom > today || (promotion.validTo && promotion.validTo < today)) {
        throw new ConflictException({
          code: 'PROMOTION_OUT_OF_DATE',
          message: `${promotion.code} is not valid today.`,
        });
      }

      // --- the approver must be a real member of this clinic's staff --------

      /**
       * Read through the tenant client on purpose.
       *
       * Row-level security means a user id belonging to another clinic simply is
       * not found here, so the "must be one of ours" half of the rule is the
       * database's rather than a comparison somebody has to remember to write.
       */
      const approver = await tx.user.findUnique({
        where: { id: input.authorisedByUserId },
        select: { id: true, fullName: true, isActive: true },
      });
      if (!approver) {
        throw new ConflictException({
          code: 'APPROVER_NOT_FOUND',
          message: 'Name someone from this clinic as the person who authorised the discount.',
        });
      }
      if (!approver.isActive) {
        throw new ConflictException({
          code: 'APPROVER_INACTIVE',
          message: `${approver.fullName}'s account is switched off and cannot authorise a discount.`,
        });
      }

      // --- the arithmetic ---------------------------------------------------

      const lines = await tx.invoiceLine.findMany({
        where: { invoiceId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          quantity: true,
          unitPricePaise: true,
          taxPaise: true,
          discountPaise: true,
        },
      });

      if (lines.length === 0) {
        throw new ConflictException({
          code: 'NOTHING_TO_DISCOUNT',
          message: 'This bill has no charges on it yet.',
        });
      }

      /**
       * CUSTOM: the amount comes with the request, and both directions are
       * refusals rather than corrections.
       *
       * A CUSTOM promotion without an amount is not "zero off" — it is a desk
       * that has not finished the form, and applying it would write a record
       * saying a discount was authorised for nothing.
       *
       * An amount sent for PERCENTAGE or FLAT is refused rather than ignored.
       * Those two carry a figure an administrator set; letting the desk send a
       * different one would be overruling that quietly, from a screen whose job
       * is to apply discounts rather than to define them.
       */
      const isCustom = promotion.type === 'CUSTOM';

      if (isCustom && input.customDiscountPaise === undefined) {
        throw new BadRequestException({
          code: 'CUSTOM_AMOUNT_REQUIRED',
          message: `${promotion.code} needs an amount — type what this bill should be discounted by.`,
        });
      }

      if (!isCustom && input.customDiscountPaise !== undefined) {
        throw new BadRequestException({
          code: 'CUSTOM_AMOUNT_NOT_ALLOWED',
          message: `${promotion.code} already has its own value. An amount cannot be set for it here.`,
        });
      }

      /**
       * Refused, not clamped — decision (c).
       *
       * `discountValueFor` floors every discount at the bill, so a clamp would
       * "work": the invoice would be correct and the desk would be told nothing.
       * That is exactly wrong for a number a person just typed. They entered
       * ₹500 against a ₹400 bill because one of the two is not what they think
       * it is, and the bill quietly becoming ₹0 tells them neither.
       */
      const subtotalPaise = lines.reduce((n, l) => n + l.quantity * l.unitPricePaise, 0);

      if (isCustom && (input.customDiscountPaise as number) > subtotalPaise) {
        throw new BadRequestException({
          code: 'CUSTOM_AMOUNT_ABOVE_TOTAL',
          message:
            `That discount is more than the bill. This bill is ${formatPaise(subtotalPaise)}, ` +
            `and the amount entered was ${formatPaise(input.customDiscountPaise as number)}.`,
        });
      }

      const plan = planDiscount(
        {
          type: promotion.type,
          value: promotion.value,
          maxDiscountPaise: promotion.maxDiscountPaise,
        },
        lines,
        input.customDiscountPaise,
      );

      for (const line of plan.lines) {
        await tx.invoiceLine.update({
          where: { id: line.id },
          // `totalPaise` moves with the discount because
          // `invoice_line_total_is_consistent` requires it to.
          data: { discountPaise: line.discountPaise, totalPaise: line.totalPaise },
        });
      }

      /**
       * The permanent record (FR-PRO-02).
       *
       * Append-only, and written in the same transaction as the line updates, so
       * a discounted invoice without the row explaining it is not a state this
       * database can hold.
       */
      const application = await tx.promotionApplication.create({
        data: {
          tenantId,
          promotionId: promotion.id,
          invoiceId,
          discountPaise: plan.totalDiscountPaise,
          appliedByUserId: meta.actorUserId!,
          authorisedByUserId: approver.id,
        },
      });

      // Point the invoice at it. This is what makes "one active discount" a
      // property of the schema rather than of this function.
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { activePromotionApplicationId: application.id },
      });

      await this.retotal(tx, invoiceId);

      await this.audit.record(tx, tenantId, {
        action: 'promotion.apply',
        resourceType: 'Invoice',
        resourceId: invoiceId,
        patientId: invoice.patientId,
        changedFields: ['discountPaise', 'totalPaise'],
        /**
         * Which kind of number this was — decision (e).
         *
         * "Entered by hand" and "worked out from a stored rule" are different
         * acts by different people, and an owner reading the day's discounts
         * needs to tell them apart: one was a judgement somebody made at the
         * desk, the other was an administrator's policy being executed. The
         * amount alone cannot say which, and `audit_event` has no field for it
         * — so it goes in the reason, which is the column built to carry the
         * part the schema does not model.
         */
        reason:
          `${promotion.code} authorised by ${approver.fullName} ` +
          `(${formatPaise(plan.totalDiscountPaise)}, ` +
          `${isCustom ? 'entered by hand' : 'calculated from the promotion'})`,
        ...meta,
      });

      return {
        applicationId: application.id,
        promotion: shape(promotion),
        discountPaise: plan.totalDiscountPaise,
        authorisedBy: { id: approver.id, fullName: approver.fullName },
      };
    });
  }

  /**
   * Take a promotion back off a bill, before any money has moved.
   *
   * A REVERSAL IS A NEW ROW. Nothing is edited and nothing is deleted — the
   * same shape as a refund against a payment, and the same reason: this table
   * is the record of who gave money away and on whose instruction, and a record
   * that can be rewritten is not one. `promotion_application` holds SELECT and
   * INSERT and nothing else, so the database enforces that rather than trusting
   * this method.
   *
   * What the compensating row does NOT do is free the invoice's discount slot —
   * a row cannot mark another row. That is why the active application is a
   * column on the invoice: setting it to NULL here is what lets a different
   * promotion be applied afterwards, while the history stays whole.
   */
  async reverse(
    tenantId: string,
    invoiceId: string,
    input: { reversalKind?: 'APPLIED_IN_ERROR' | 'AUTHORISATION_WITHDRAWN' },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      // A payment of the discounted balance may be in flight; it must land
      // before this decides whether money has been taken. See lockInvoice.
      await lockInvoice(tx, invoiceId);

      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          status: true,
          patientId: true,
          activePromotion: {
            select: {
              id: true,
              discountPaise: true,
              promotionId: true,
              authorisedByUserId: true,
              promotion: { select: { code: true } },
            },
          },
        },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');

      const active = invoice.activePromotion;
      if (!active) {
        throw new ConflictException({
          code: 'NO_PROMOTION_APPLIED',
          message: 'There is no discount on this bill to take off.',
        });
      }

      /**
       * Before payment only, exactly like applying one.
       *
       * Once money has moved, removing the discount would raise the bill under a
       * patient who has already paid against the lower figure. That is a
       * correction, it needs its own reason and authoriser, and it is an
       * administrator's job — already built.
       */
      const payments = await tx.payment.count({ where: { invoiceId } });
      if (payments > 0) {
        throw new ConflictException({
          code: 'PAYMENT_ALREADY_TAKEN',
          message:
            'Money has already been taken on this bill. Removing the discount now is a ' +
            'correction — an administrator does that.',
        });
      }

      if (invoice.status === 'CANCELLED' || invoice.status === 'WAIVED') {
        throw new ConflictException({
          code: 'NOT_DISCOUNTABLE',
          message: `This invoice is ${invoice.status.toLowerCase()}.`,
        });
      }

      const reversal = await tx.promotionApplication.create({
        data: {
          tenantId,
          promotionId: active.promotionId,
          invoiceId,
          // Positive, like a refund's amount. `reversalKind` carries the sign,
          // so the history reads as "₹300 given, ₹300 taken back" rather than
          // needing a negative number nobody can sum safely.
          discountPaise: active.discountPaise,
          appliedByUserId: meta.actorUserId!,
          // The authoriser of the discount being withdrawn, not a new one.
          // Inventing an approver for an undo would put a name against an
          // instruction nobody gave.
          authorisedByUserId: active.authorisedByUserId,
          reversalKind: input.reversalKind ?? 'APPLIED_IN_ERROR',
          reversesApplicationId: active.id,
        },
      });

      // Put every line back to its undiscounted state, then recompute the
      // header through the same path applying one uses.
      const lines = await tx.invoiceLine.findMany({
        where: { invoiceId },
        select: { id: true, quantity: true, unitPricePaise: true, taxPaise: true },
      });

      for (const line of lines) {
        await tx.invoiceLine.update({
          where: { id: line.id },
          data: {
            discountPaise: 0,
            totalPaise: line.quantity * line.unitPricePaise + line.taxPaise,
          },
        });
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { activePromotionApplicationId: null },
      });

      await this.retotal(tx, invoiceId);

      await this.audit.record(tx, tenantId, {
        action: 'promotion.reverse',
        resourceType: 'Invoice',
        resourceId: invoiceId,
        patientId: invoice.patientId,
        changedFields: ['discountPaise', 'totalPaise'],
        reason: `${active.promotion.code} removed (${reversal.reversalKind})`,
        ...meta,
      });

      return {
        reversalId: reversal.id,
        reversedApplicationId: active.id,
        promotionCode: active.promotion.code,
        discountRemovedPaise: active.discountPaise,
      };
    });
  }

  // --- internals ------------------------------------------------------------

  private async load(tx: TenantClient, id: string) {
    const promotion = await tx.promotion.findUnique({ where: { id } });
    if (!promotion) throw new NotFoundException('Promotion not found');
    return promotion;
  }

  private async view(tx: TenantClient, id: string) {
    const promotion = await this.load(tx, id);
    const timesApplied = await tx.promotionApplication.count({ where: { promotionId: id } });

    return { ...shape(promotion), timesApplied, editable: timesApplied === 0 };
  }

  /**
   * Recompute the invoice header from its lines.
   *
   * Deliberately the same arithmetic as `BillingService.retotal`, which is
   * private. Duplicated rather than exported because the alternative — widening
   * the billing service's surface so another module can drive its internals — is
   * a worse trade than eight lines that a CHECK constraint keeps honest.
   */
  private async retotal(tx: TenantClient, invoiceId: string): Promise<void> {
    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId },
      select: { quantity: true, unitPricePaise: true, discountPaise: true, taxPaise: true },
    });

    const subtotalPaise = lines.reduce((n, l) => n + l.quantity * l.unitPricePaise, 0);
    const discountPaise = lines.reduce((n, l) => n + l.discountPaise, 0);
    const taxPaise = lines.reduce((n, l) => n + l.taxPaise, 0);

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        subtotalPaise,
        discountPaise,
        taxPaise,
        totalPaise: subtotalPaise - discountPaise + taxPaise,
      },
    });
  }
}

/** The wire shape. Dates go out as `YYYY-MM-DD`, which is how they came in. */
function shape(p: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  value: number | null;
  maxDiscountPaise: number | null;
  validFrom: Date;
  validTo: Date | null;
  isActive: boolean;
}) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    type: p.type,
    value: p.value,
    maxDiscountPaise: p.maxDiscountPaise,
    validFrom: p.validFrom.toISOString().slice(0, 10),
    validTo: p.validTo ? p.validTo.toISOString().slice(0, 10) : null,
    isActive: p.isActive,
  };
}
