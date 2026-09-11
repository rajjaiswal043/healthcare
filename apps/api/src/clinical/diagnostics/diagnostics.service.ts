import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { clinicToday, instantToLocalDate, localToInstant } from '../../scheduling/clinic-time.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import {
  BillingService,
  DIAGNOSTIC_BILLING_SELECT,
  diagnosticBillingState,
  type DiagnosticBillingInput,
} from '../../billing/billing.service.js';

interface RequestMeta {
  actorUserId: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

/**
 * Diagnostic orders — the doctor's "X-ray, left knee" and the department's list
 * of what to do about it.
 *
 * Checkpoint 2 of docs/09-diagnostics-plan.md. Attaching the result is
 * checkpoint 3; this file raises orders and shows them.
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    private readonly billing: BillingService,
  ) {}

  /** Departments that do tests. The worklist's filter, and the order form's choices. */
  async departments(tenantId: string) {
    const departments = await this.prisma.forTenant(tenantId, (tx) =>
      tx.department.findMany({
        where: { isActive: true, isDiagnostic: true },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true },
      }),
    );
    return { departments };
  }

  /**
   * Midnight today, in the clinic's own timezone.
   *
   * The walk-in duplicate guard is scoped to a DAY, and which day that is has
   * to be the clinic's — using the UTC date would put every evening order in
   * Kolkata onto tomorrow, and the guard would stop firing after 5:30pm.
   */
  private async startOfClinicDay(tx: TenantClient, tenantId: string): Promise<Date> {
    const { timezone } = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return localToInstant(clinicToday(timezone), '00:00', timezone);
  }

  /**
   * The orderable tests, with their fees (FR-DIA decision (f)).
   *
   * A doctor in India knows roughly what a test costs and says so in the room.
   * Hiding the number here would not protect anything — it is printed on the
   * bill and on the receipt the patient is handed — and it would make the
   * doctor order a scan without knowing they have just added ₹4,000 to a bill
   * the patient may not be able to settle.
   *
   * Behind `diagnostic:order` rather than `invoice:read`, which no doctor holds
   * and which would hand over the whole billing surface to buy one number. Same
   * reasoning as `GET /practitioners`, which already returns
   * `consultationFeePaise` for the screen that has to choose a doctor.
   *
   * A DIAGNOSTIC service with no department is excluded, and that is not an
   * oversight: an order has to land on some department's worklist, so a test
   * nobody performs cannot be ordered. It shows up as a gap in the price list,
   * which is where an administrator can fix it.
   */
  async catalogue(tenantId: string, departmentId?: string) {
    const tests = await this.prisma.forTenant(tenantId, (tx) =>
      tx.service.findMany({
        where: {
          isActive: true,
          category: 'DIAGNOSTIC',
          ...(departmentId ? { departmentId } : { departmentId: { not: null } }),
          department: { isActive: true, isDiagnostic: true },
        },
        orderBy: [{ name: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          pricePaise: true,
          department: { select: { id: true, name: true } },
        },
      }),
    );
    return { tests };
  }

  /**
   * Raise an order against a visit.
   *
   * The appointment is looked up inside the tenant's policy, which is what binds
   * the order to a visit this clinic actually has — and gives us the patient
   * rather than trusting one from the request. A caller supplying both an
   * appointment and a patient id could otherwise attach an order for one
   * patient to another patient's visit.
   */
  async createOrder(
    tenantId: string,
    input: {
      /** A consultation, for an INTERNAL order. Absent for a walk-in. */
      appointmentId?: string;
      /** The patient, for a walk-in. Ignored when an appointment is given. */
      patientId?: string;
      departmentId: string;
      description?: string;
      serviceId?: string;
      referralSource?: 'INTERNAL' | 'EXTERNAL_DOCTOR' | 'SELF';
      referrerName?: string;
      referrerClinic?: string;
      referrerPhone?: string;
    },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const referralSource = input.referralSource ?? 'INTERNAL';

      /**
       * Where the patient comes from, and why it differs by referral source.
       *
       * With a consultation the patient is READ OFF THE VISIT and never taken
       * from the request — a caller supplying both could otherwise file one
       * patient's order against another's visit. A walk-in has no visit to read
       * from, so the patient id has to be supplied; it is looked up inside the
       * tenant's policy, which is what stops it naming somebody else's patient.
       */
      let appointmentId: string | null = null;
      let patientId: string;

      if (referralSource === 'INTERNAL') {
        if (!input.appointmentId) {
          throw new BadRequestException({
            code: 'VISIT_REQUIRED',
            message: 'An order from this clinic’s own doctor belongs to a visit.',
          });
        }

        const appointment = await tx.appointment.findUnique({
          where: { id: input.appointmentId },
          select: { id: true, patientId: true },
        });
        if (!appointment) throw new NotFoundException('No such visit.');

        appointmentId = appointment.id;
        patientId = appointment.patientId;
      } else {
        /**
         * A walk-in never attaches to a visit, and the database agrees: the
         * biconditional CHECK admits an appointment only on an INTERNAL order.
         * Refused here rather than left to the constraint so the caller gets a
         * sentence instead of a violation.
         */
        if (input.appointmentId) {
          throw new BadRequestException({
            code: 'WALK_IN_HAS_NO_VISIT',
            message: 'A walk-in test does not belong to a consultation.',
          });
        }
        if (!input.patientId) {
          throw new BadRequestException({
            code: 'PATIENT_REQUIRED',
            message: 'Say which patient this test is for.',
          });
        }

        const patient = await tx.patient.findUnique({
          where: { id: input.patientId },
          select: { id: true },
        });
        if (!patient) throw new NotFoundException('No such patient.');

        patientId = patient.id;
      }

      const referrerName = input.referrerName?.trim();
      if (referralSource === 'EXTERNAL_DOCTOR' && !referrerName) {
        throw new BadRequestException({
          code: 'REFERRER_REQUIRED',
          message: 'Name the doctor who sent them — it is printed on the report.',
        });
      }

      const department = await tx.department.findUnique({
        where: { id: input.departmentId },
        select: { id: true, isDiagnostic: true, isActive: true, name: true },
      });
      if (!department) throw new NotFoundException('No such department.');

      // A clinic that sends an X-ray request to "Orthopaedics" has misconfigured
      // something, and the order would sit on a worklist nobody looks at.
      if (!department.isDiagnostic) {
        throw new BadRequestException({
          code: 'NOT_A_DIAGNOSTIC_DEPARTMENT',
          message: `“${department.name}” does not do tests. Mark it as a diagnostic department first.`,
        });
      }
      if (!department.isActive) {
        throw new BadRequestException({
          code: 'DEPARTMENT_INACTIVE',
          message: `“${department.name}” is switched off.`,
        });
      }

      /**
       * A catalogue test, when one was picked.
       *
       * Looked up rather than trusted, and checked against the department the
       * order is being raised on — otherwise a request could file "MRI Brain"
       * under pathology, and in phase 2 that mismatch becomes a charge on a
       * worklist that will never run it.
       */
      let serviceId: string | undefined;
      let description = input.description?.trim();

      if (input.serviceId) {
        const service = await tx.service.findUnique({
          where: { id: input.serviceId },
          select: {
            id: true,
            name: true,
            isActive: true,
            category: true,
            departmentId: true,
          },
        });
        if (!service) throw new NotFoundException('No such test.');

        if (!service.isActive) {
          throw new BadRequestException({
            code: 'TEST_INACTIVE',
            message: `“${service.name}” is no longer offered. Pick another test.`,
          });
        }
        if (service.category !== 'DIAGNOSTIC') {
          throw new BadRequestException({
            code: 'NOT_A_TEST',
            message: `“${service.name}” is not a diagnostic test.`,
          });
        }
        if (service.departmentId !== department.id) {
          throw new BadRequestException({
            code: 'TEST_WRONG_DEPARTMENT',
            message: `“${service.name}” is not performed by ${department.name}.`,
          });
        }

        /**
         * The same test twice on one visit is a mis-click, not an order.
         *
         * Scoped to this VISIT, not to the patient forever: the same knee needs
         * re-imaging next month, and that must not be refused. Scoped to ACTIVE
         * orders too — a declined or cancelled one leaves the way clear, which
         * is what makes `undeclineOrder` and a simple re-order possible at all.
         *
         * A genuine repeat inside one visit does exist — bloods after a meal,
         * an ECG after fresh chest pain — and this refuses it. That is the
         * clinic's call, taken on 10 Sep 2026; the way to take it is to order
         * the second one after the first is completed, or to say so in the
         * description of one order.
         */
        const already = await tx.diagnosticOrder.findFirst({
          where: {
            serviceId: service.id,
            status: { in: ['PENDING', 'COMPLETED'] },
            /**
             * Scoped to the visit when there is one, and to the patient's day
             * when there is not. A walk-in has no appointment to group by, so
             * without the second form the guard would simply never fire on the
             * flow that most invites double entry — finance taking the money
             * and raising the request in the same breath.
             */
            ...(appointmentId
              ? { appointmentId }
              : { patientId, createdAt: { gte: await this.startOfClinicDay(tx, tenantId) } }),
          },
          select: { id: true },
        });
        if (already) {
          throw new ConflictException({
            code: 'TEST_ALREADY_ORDERED',
            message: `“${service.name}” has already been ordered on this visit.`,
          });
        }

        serviceId = service.id;
        // The catalogue name is the floor, not the ceiling: the form pre-fills
        // it so the doctor can add "left knee, AP and lateral". If they cleared
        // it, the order still has to say what it is.
        if (!description) description = service.name;
      }

      if (!description || description.length < 2) {
        throw new BadRequestException({
          code: 'DESCRIPTION_REQUIRED',
          message: 'Say what test is being ordered.',
        });
      }

      /**
       * Free text is not an order when the department has a catalogue.
       *
       * Decision (b): "Other" means this centre does not do it. Such a test has
       * no department to land on and no price to charge, so an order for it
       * would sit on a worklist nobody can clear behind a gate over money that
       * will never arrive. It belongs on the slip — see `setExternalTestNote`.
       *
       * Conditional on the department actually having priced tests, because a
       * clinic that has priced nothing must keep ordering the way it always
       * has. Billing is opt-in per tenant everywhere else in this codebase and
       * this is no place to make it compulsory.
       */
      if (!serviceId) {
        const priced = await tx.service.count({
          where: { isActive: true, category: 'DIAGNOSTIC', departmentId: department.id },
        });
        if (priced > 0) {
          throw new BadRequestException({
            code: 'TEST_NOT_OFFERED',
            message:
              `Pick a test ${department.name} performs. Anything they do not do goes on the ` +
              'slip for the patient to have done elsewhere.',
          });
        }
      }

      /**
       * A catalogue test is billed as it is ordered (decision (d)).
       *
       * In this transaction, so an order and its charge cannot come apart: an
       * order with no charge walks straight through the pay-first gate, and a
       * charge with no order is money for work nobody asked for.
       *
       * Free-text orders raise nothing. The clinic does not have a price for
       * them, and inventing one here would be worse than leaving the charge to
       * the desk. Phase 5 removes free text from the doctor's form entirely.
       */
      let invoiceLineId: string | undefined;
      if (serviceId) {
        const charge = await this.billing.chargeDiagnosticTest(
          tx,
          tenantId,
          {
            patientId,
            visitAppointmentId: appointmentId,
            serviceId,
            description,
          },
          meta,
        );
        invoiceLineId = charge.lineId;
      }

      const order = await tx.diagnosticOrder.create({
        data: {
          tenantId,
          appointmentId,
          patientId,
          departmentId: department.id,
          orderedByUserId: meta.actorUserId,
          description,
          ...(serviceId ? { serviceId } : {}),
          ...(invoiceLineId ? { invoiceLineId } : {}),
          referralSource,
          ...(referrerName ? { referrerName } : {}),
          ...(input.referrerClinic?.trim() ? { referrerClinic: input.referrerClinic.trim() } : {}),
          ...(input.referrerPhone?.trim() ? { referrerPhone: input.referrerPhone.trim() } : {}),
        },
        select: ORDER_SELECT,
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.order',
        resourceType: 'DiagnosticOrder',
        resourceId: order.id,
        patientId,
        changedFields: ['description', 'departmentId', 'serviceId', 'referralSource'],
        ...meta,
      });

      return toView(order);
    });
  }

  /**
   * Refuse to move on an unpaid test.
   *
   * Both gate points call this rather than duplicating the check, and both gate
   * points exist rather than one: blocking only `completeOrder` would let a
   * technician upload the film and leave the order a click away from release,
   * which is not a gate so much as a speed bump. Blocking only `attachResult`
   * would let a report be typed as a note instead.
   *
   * The worklist itself is NOT gated — decision (c). The technician has to see
   * the patient standing in front of them, and a row that quietly vanishes is
   * how a clinic loses a patient in a corridor. What is withheld is the result,
   * not the knowledge that the test was asked for.
   */
  private async assertPaidFor(tenantId: string, orderId: string): Promise<void> {
    const unpaid = await this.prisma.forTenant(tenantId, (tx) =>
      this.billing.blockingReasonForOrder(tx, orderId),
    );
    if (unpaid) {
      throw new ConflictException({ code: 'TEST_NOT_PAID', message: unpaid });
    }
  }

  /**
   * A patient walked in wanting tests: price them, raise them, one bill.
   *
   * Separate from `createOrder` rather than a loop over it, and the invoice is
   * why. `ensureInvoiceForDiagnosticOrder` groups charges by VISIT, and a
   * walk-in has none — so calling it once per test would open one bill per
   * test and hand the patient three pieces of paper to pay separately, which
   * is exactly what FR-DIA-11 says must not happen. Here the invoice is opened
   * once and every test becomes a line on it.
   *
   * One transaction for the lot. A half-applied batch is the worst outcome
   * available: money raised for a test no department was told about, or a
   * department told about a test nobody was charged for.
   *
   * The referral fields are recorded once and copied onto every order, because
   * they describe the VISIT, not the individual test — the same outside doctor
   * sent them for all three.
   */
  async createWalkInOrders(
    tenantId: string,
    input: {
      patientId: string;
      /** Catalogue tests, in the order the desk picked them. */
      serviceIds: string[];
      referralSource: 'EXTERNAL_DOCTOR' | 'SELF';
      referrerName?: string;
      referrerClinic?: string;
      referrerPhone?: string;
    },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const referrerName = input.referrerName?.trim();
      if (input.referralSource === 'EXTERNAL_DOCTOR' && !referrerName) {
        throw new BadRequestException({
          code: 'REFERRER_REQUIRED',
          message: 'Name the doctor who sent them — it is printed on the report.',
        });
      }

      const unique = [...new Set(input.serviceIds)];
      if (unique.length === 0) {
        throw new BadRequestException({
          code: 'NO_TESTS',
          message: 'Pick at least one test.',
        });
      }
      if (unique.length !== input.serviceIds.length) {
        throw new BadRequestException({
          code: 'TEST_REPEATED',
          message: 'The same test is in this list twice.',
        });
      }

      const patient = await tx.patient.findUnique({
        where: { id: input.patientId },
        select: { id: true },
      });
      if (!patient) throw new NotFoundException('No such patient.');

      const dayStart = await this.startOfClinicDay(tx, tenantId);

      /**
       * Every test validated BEFORE anything is written.
       *
       * The alternative — charge, raise, move on, fail on the fourth — rolls
       * back cleanly here but would still have taken a payment screen through
       * three successful steps before refusing. The desk should be told the
       * list is wrong while it is still a list.
       */
      const tests: Array<{
        id: string;
        name: string;
        departmentId: string;
      }> = [];

      for (const serviceId of unique) {
        const service = await tx.service.findUnique({
          where: { id: serviceId },
          select: {
            id: true,
            name: true,
            isActive: true,
            category: true,
            departmentId: true,
            department: { select: { isActive: true, isDiagnostic: true, name: true } },
          },
        });
        if (!service) throw new NotFoundException('No such test.');

        if (!service.isActive || service.category !== 'DIAGNOSTIC') {
          throw new BadRequestException({
            code: 'NOT_A_TEST',
            message: `“${service.name}” is not a test this centre offers.`,
          });
        }
        if (!service.departmentId || !service.department?.isDiagnostic) {
          throw new BadRequestException({
            code: 'TEST_HAS_NO_DEPARTMENT',
            message: `Nobody here performs “${service.name}”. Give it a diagnostic department first.`,
          });
        }
        if (!service.department.isActive) {
          throw new BadRequestException({
            code: 'DEPARTMENT_INACTIVE',
            message: `“${service.department.name}” is switched off.`,
          });
        }

        // Same guard as a doctor's order, scoped the way a walk-in has to be:
        // there is no visit, so it is this patient, on this clinic day.
        const already = await tx.diagnosticOrder.findFirst({
          where: {
            serviceId: service.id,
            patientId: patient.id,
            status: { in: ['PENDING', 'COMPLETED'] },
            createdAt: { gte: dayStart },
          },
          select: { id: true },
        });
        if (already) {
          throw new ConflictException({
            code: 'TEST_ALREADY_ORDERED',
            message: `“${service.name}” was already ordered for this patient today.`,
          });
        }

        tests.push({ id: service.id, name: service.name, departmentId: service.departmentId });
      }

      /** Opened once, before the loop. This is the whole point of the method. */
      const invoice = await this.billing.ensureInvoiceForDiagnosticOrder(
        tx,
        tenantId,
        { patientId: patient.id, visitAppointmentId: null },
        meta,
      );

      const orders = [];
      for (const test of tests) {
        const line = await this.billing.addDiagnosticLine(
          tx,
          tenantId,
          invoice.id,
          { patientId: patient.id, serviceId: test.id, description: test.name },
          meta,
        );

        const order = await tx.diagnosticOrder.create({
          data: {
            tenantId,
            appointmentId: null,
            patientId: patient.id,
            departmentId: test.departmentId,
            orderedByUserId: meta.actorUserId,
            serviceId: test.id,
            description: test.name,
            invoiceLineId: line.id,
            referralSource: input.referralSource,
            ...(referrerName ? { referrerName } : {}),
            ...(input.referrerClinic?.trim()
              ? { referrerClinic: input.referrerClinic.trim() }
              : {}),
            ...(input.referrerPhone?.trim() ? { referrerPhone: input.referrerPhone.trim() } : {}),
          },
          select: ORDER_SELECT,
        });

        await this.audit.record(tx, tenantId, {
          action: 'diagnostic.order',
          resourceType: 'DiagnosticOrder',
          resourceId: order.id,
          patientId: patient.id,
          changedFields: ['description', 'departmentId', 'serviceId', 'referralSource'],
          ...meta,
        });

        orders.push(toView(order));
      }

      return { invoiceId: invoice.id, orders };
    });
  }

  /**
   * The department's worklist.
   *
   * Oldest first. A queue that does not run oldest-first is not a queue, and a
   * patient waiting in a corridor for a film has already waited once.
   */
  async worklist(
    tenantId: string,
    filter: { departmentId?: string; status?: 'PENDING' | 'COMPLETED' | 'DECLINED' },
  ) {
    const orders = await this.prisma.forTenant(tenantId, (tx) =>
      tx.diagnosticOrder.findMany({
        where: {
          ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
          status: filter.status ?? 'PENDING',
        },
        orderBy: { createdAt: 'asc' },
        select: ORDER_SELECT,
      }),
    );
    return { orders: orders.map(toView) };
  }

  /** What was ordered on one visit — the consultation's view. */
  async forVisit(tenantId: string, appointmentId: string) {
    const orders = await this.prisma.forTenant(tenantId, (tx) =>
      tx.diagnosticOrder.findMany({
        where: { appointmentId },
        orderBy: { createdAt: 'asc' },
        select: ORDER_SELECT,
      }),
    );
    return { orders: orders.map(toView) };
  }

  /** One order, with whatever has been attached to it. */
  async order(tenantId: string, orderId: string) {
    const order = await this.prisma.forTenant(tenantId, (tx) =>
      tx.diagnosticOrder.findUnique({ where: { id: orderId }, select: ORDER_SELECT }),
    );
    if (!order) throw new NotFoundException('No such order.');

    return { ...toView(order), documents: await this.documents.forOrder(tenantId, orderId) };
  }

  /**
   * Attach a file to an order.
   *
   * **The patient comes from the order, not from the request.** That is the
   * whole reason this lives here rather than on the documents controller: the
   * order was resolved inside the tenant's policy, so the patient it names is
   * one this clinic has, and a technician cannot file somebody else's film
   * against it.
   *
   * Attaching does not complete the order — `completeOrder` does. A study is
   * often several images, and an order that completed on the first would leave
   * the rest arriving against something already finished.
   */
  async attachResult(
    tenantId: string,
    orderId: string,
    file: { bytes: Buffer; fileName: string },
    meta: RequestMeta,
  ) {
    const order = await this.prisma.forTenant(tenantId, (tx) =>
      tx.diagnosticOrder.findUnique({
        where: { id: orderId },
        select: { id: true, patientId: true, status: true },
      }),
    );
    if (!order) throw new NotFoundException('No such order.');

    if (order.status === 'CANCELLED') {
      throw new BadRequestException({
        code: 'ORDER_CANCELLED',
        message: 'That test was cancelled. Ask for it to be re-ordered before attaching a result.',
      });
    }

    // Said differently from CANCELLED on purpose. The technician needs to know
    // that nobody is coming and no money is due, rather than that the bill is
    // still being settled at the counter.
    if (order.status === 'DECLINED') {
      throw new BadRequestException({
        code: 'ORDER_DECLINED',
        message: 'The patient declined this test. It is not to be done.',
      });
    }

    await this.assertPaidFor(tenantId, orderId);

    return this.documents.upload(tenantId, order.patientId, file, meta, order.id);
  }

  /**
   * Mark the test done, with the report.
   *
   * Refuses an order with neither a file nor a note. A completed order carrying
   * nothing tells the doctor the test happened and nothing about what it found,
   * which is worse than a pending one — at least a pending order is visibly
   * unfinished.
   *
   * Completing twice is refused rather than silently re-stamped: the second
   * caller would overwrite who did it and when.
   */
  async completeOrder(
    tenantId: string,
    orderId: string,
    resultNote: string | undefined,
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.diagnosticOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          patientId: true,
          _count: { select: { documents: true } },
        },
      });
      if (!existing) throw new NotFoundException('No such order.');

      if (existing.status !== 'PENDING') {
        throw new BadRequestException({
          code: 'ORDER_NOT_PENDING',
          message:
            existing.status === 'COMPLETED'
              ? 'That test is already marked done.'
              : existing.status === 'DECLINED'
                ? 'The patient declined this test. It is not to be done.'
                : 'That test was cancelled.',
        });
      }

      const unpaid = await this.billing.blockingReasonForOrder(tx, orderId);
      if (unpaid) {
        throw new ConflictException({ code: 'TEST_NOT_PAID', message: unpaid });
      }

      const note = resultNote?.trim();
      if (!note && existing._count.documents === 0) {
        throw new BadRequestException({
          code: 'RESULT_IS_EMPTY',
          message: 'Attach a file or write a report before marking the test done.',
        });
      }

      const order = await tx.diagnosticOrder.update({
        where: { id: orderId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          completedByUserId: meta.actorUserId,
          ...(note ? { resultNote: note } : {}),
        },
        select: ORDER_SELECT,
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.result',
        resourceType: 'DiagnosticOrder',
        resourceId: orderId,
        patientId: existing.patientId,
        changedFields: ['status', 'resultNote'],
        ...meta,
      });

      return toView(order);
    });
  }

  /**
   * Every test this patient has ever had back, for the doctor seeing them now.
   *
   * A deliberately narrow door onto a wide record, and the narrowness is the
   * feature. Decision (e): a doctor does not get standing access to any
   * patient's history — they get this patient's, while they are the one with
   * that patient in front of them.
   *
   * Three conditions, all of them checked here rather than by a permission:
   *
   *   1. the caller is a practitioner at all,
   *   2. they are THIS encounter's practitioner, and
   *   3. it is still that visit's own day.
   *
   * Condition 3 is what keeps it from becoming standing access. It does NOT
   * close at signing, because a doctor writing an addendum an hour later is
   * still working on the same visit and would otherwise lose the history
   * mid-sentence. It does close overnight.
   *
   * `user:manage` gets no exemption, unlike `assertMayReadQueue`. An
   * administrator holding every permission in the clinic is exactly who this
   * gate exists to keep out of a patient's results.
   *
   * The query is patient-level and COMPLETED-only: no three-visit window, no
   * "signed encounters only", and NOT keyed on the appointment — a walk-in test
   * has no appointment, and those are precisely the results that would go
   * missing from a history keyed that way.
   */
  async patientTestHistory(tenantId: string, encounterId: string, user: { userId: string }) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const encounter = await tx.encounter.findUnique({
        where: { id: encounterId },
        select: {
          id: true,
          patientId: true,
          practitionerId: true,
          appointmentId: true,
          appointment: { select: { startAt: true } },
        },
      });
      if (!encounter) throw new NotFoundException('Consultation not found.');

      const self = await tx.practitioner.findFirst({
        where: { userId: user.userId },
        select: { id: true },
      });
      if (!self || self.id !== encounter.practitionerId) {
        throw new ForbiddenException(
          'A patient’s test history is open to the doctor seeing them, during that visit.',
        );
      }

      const { timezone } = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true },
      });

      if (instantToLocalDate(encounter.appointment.startAt, timezone) !== clinicToday(timezone)) {
        throw new ForbiddenException(
          'That visit was on another day. Open today’s consultation to see this patient’s tests.',
        );
      }

      const orders = await tx.diagnosticOrder.findMany({
        where: {
          patientId: encounter.patientId,
          status: 'COMPLETED',
          /**
           * Everything except this visit's own tests, which the consultation
           * already has on screen.
           *
           * Written as an OR rather than `appointmentId: { not: current }`,
           * which reads as equivalent and is not. In SQL `appointment_id <> $1`
           * evaluates to NULL for a row with no appointment, and NULL is not
           * true, so a plain NOT silently drops every walk-in test — the exact
           * results this endpoint exists to surface, and the reason decision 5
           * needed no new feature. The test below pins it.
           */
          OR: [{ appointmentId: null }, { appointmentId: { not: encounter.appointmentId } }],
        },
        orderBy: { completedAt: 'desc' },
        /**
         * Generous rather than absent. The three-visit window is gone, as asked
         * — this is a guard against one query returning a decade of a chronic
         * patient's results, not a window on the history.
         */
        take: 200,
        select: {
          id: true,
          description: true,
          resultNote: true,
          completedAt: true,
          appointmentId: true,
          department: { select: { name: true } },
          service: { select: { name: true } },
          documents: { select: { id: true, fileName: true }, orderBy: { createdAt: 'asc' } },
        },
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.history_read',
        resourceType: 'Patient',
        resourceId: encounter.patientId,
        patientId: encounter.patientId,
        changedFields: [],
        actorUserId: user.userId,
      });

      return { orders };
    });
  }

  /**
   * Record a test this centre does not perform (decision (b)).
   *
   * Deliberately NOT an order. No row on any worklist, no charge, no pay-first
   * gate — just words that reach two people: the patient, who takes them away
   * on the printed slip, and the finance desk, who can then say "that one is
   * not done here" before the patient has waited for it.
   *
   * On the appointment, so it survives the consultation being signed and so
   * the finance desk can read it without being handed the clinical record.
   * Replaces rather than appends: the doctor is editing one line of a slip
   * they are looking at, and an accumulating log would print the deletions.
   */
  async setExternalTestNote(
    tenantId: string,
    appointmentId: string,
    note: string | null,
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const appointment = await tx.appointment.findUnique({
        where: { id: appointmentId },
        select: { id: true, patientId: true },
      });
      if (!appointment) throw new NotFoundException('No such visit.');

      const trimmed = note?.trim() ? note.trim() : null;

      await tx.appointment.update({
        where: { id: appointmentId },
        data: { externalTestNote: trimmed },
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.external_note',
        resourceType: 'Appointment',
        resourceId: appointmentId,
        patientId: appointment.patientId,
        changedFields: ['externalTestNote'],
        ...meta,
      });

      return { externalTestNote: trimmed };
    });
  }

  /**
   * The patient said no at the desk.
   *
   * The counterweight to auto-charging (decision (d)). A test is billed the
   * moment the doctor orders it, which is before anybody has asked the patient
   * whether they want it — so the desk needs a way to record the refusal that
   * both takes the money off and stops the department running the test.
   *
   * One action, two effects, one transaction. Splitting them would allow the
   * two states that matter most: a test with no charge that the department
   * still performs, and a charge for a test that was never going to happen.
   *
   * Distinct from `cancelOrder`, which is the clinician withdrawing the
   * request. Both leave the order on the record; they answer different
   * questions about it, and a report that cannot tell "we called it off" from
   * "they refused" cannot tell a clinical decision from a commercial one.
   */
  async declineOrder(tenantId: string, orderId: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.diagnosticOrder.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, patientId: true, invoiceLineId: true },
      });
      if (!existing) throw new NotFoundException('No such order.');

      if (existing.status !== 'PENDING') {
        throw new BadRequestException({
          code: 'ORDER_NOT_PENDING',
          message:
            existing.status === 'COMPLETED'
              ? 'That test has already been done. Its charge stands — a refund is the finance desk’s call.'
              : existing.status === 'DECLINED'
                ? 'That test was already declined.'
                : 'That test was cancelled, so there is nothing to decline.',
        });
      }

      /**
       * Nothing to decline on a test that was never charged for.
       *
       * A free-text order has no price, and one raised before billing existed
       * has no line. Neither is a refusal to pay, and calling them "declined"
       * would put a commercial answer on a clinical record. Cancelling is the
       * right verb, and it is a different button.
       */
      if (!existing.invoiceLineId) {
        throw new BadRequestException({
          code: 'ORDER_NOT_BILLED',
          message: 'There is no charge on this test to take off. Cancel it instead.',
        });
      }

      /**
       * Unlink before deleting. The foreign key is RESTRICT — deliberately, so
       * a charge cannot vanish from under an order by accident — which means
       * the order has to let go of it first.
       */
      await tx.diagnosticOrder.update({
        where: { id: orderId },
        data: { invoiceLineId: null },
      });

      await this.billing.removeDiagnosticLine(tx, tenantId, existing.invoiceLineId, meta);

      const order = await tx.diagnosticOrder.update({
        where: { id: orderId },
        data: { status: 'DECLINED' },
        select: ORDER_SELECT,
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.decline',
        resourceType: 'DiagnosticOrder',
        resourceId: orderId,
        patientId: existing.patientId,
        changedFields: ['status'],
        ...meta,
      });

      return toView(order);
    });
  }

  /**
   * Put a declined test back — the desk pressed it by mistake.
   *
   * Decline takes money off a bill and stands a department down in one move,
   * so a mis-click costs more than most. Without this the only way back is for
   * the doctor to order the test again, from a screen the finance desk cannot
   * reach, over a telephone call that should not have been necessary.
   *
   * Finance-only (`invoice:write`), the same hand that declined it. The charge
   * is raised fresh rather than resurrected: the old line is gone, and
   * `chargeDiagnosticTest` will reuse the visit's open test bill or open a new
   * one — which is what happens when the previous bill auto-cancelled because
   * this was the last thing on it.
   *
   * Priced at TODAY'S catalogue price, not the original. The alternative is
   * storing the old price on the order to resurrect it, and a bill that quietly
   * charges last month's rate is harder to explain than one that charges the
   * rate on the price list.
   */
  async undeclineOrder(tenantId: string, orderId: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.diagnosticOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          patientId: true,
          appointmentId: true,
          serviceId: true,
          description: true,
        },
      });
      if (!existing) throw new NotFoundException('No such order.');

      if (existing.status !== 'DECLINED') {
        throw new BadRequestException({
          code: 'ORDER_NOT_DECLINED',
          message: 'That test was not declined, so there is nothing to put back.',
        });
      }

      if (!existing.serviceId) {
        throw new BadRequestException({
          code: 'ORDER_NOT_BILLED',
          message: 'That test has no catalogue price, so there is no charge to raise.',
        });
      }

      const charge = await this.billing.chargeDiagnosticTest(
        tx,
        tenantId,
        {
          patientId: existing.patientId,
          visitAppointmentId: existing.appointmentId,
          serviceId: existing.serviceId,
          description: existing.description,
        },
        meta,
      );

      const order = await tx.diagnosticOrder.update({
        where: { id: orderId },
        data: { status: 'PENDING', invoiceLineId: charge.lineId },
        select: ORDER_SELECT,
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.undecline',
        resourceType: 'DiagnosticOrder',
        resourceId: orderId,
        patientId: existing.patientId,
        changedFields: ['status', 'invoiceLineId'],
        ...meta,
      });

      return toView(order);
    });
  }

  /**
   * The patient has been given their report.
   *
   * A doctor-ordered result ends up in a consultation, where the software can
   * watch it arrive. A walk-in result ends as a sheet of paper handed across a
   * counter, which it cannot see at all — and "I paid and never got my film"
   * is a complaint with no answer unless somebody wrote down who took it.
   *
   * Behind `diagnostic:result`, the department that did the work and, per
   * FR-DIA-13, hands the report over. Allowed on a doctor-ordered test too:
   * patients ask for copies of those as well, and refusing would mean the one
   * record that answers the complaint depends on why the test was raised.
   *
   * Recorded once. This is an event that happened, not a flag — handing the
   * same report over twice would overwrite who took it the first time, which
   * is precisely the fact in dispute.
   */
  async recordHandover(tenantId: string, orderId: string, handedOverTo: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.diagnosticOrder.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, patientId: true, handedOverAt: true },
      });
      if (!existing) throw new NotFoundException('No such order.');

      if (existing.status !== 'COMPLETED') {
        throw new BadRequestException({
          code: 'RESULT_NOT_READY',
          message:
            existing.status === 'PENDING'
              ? 'That test has not been reported yet — there is nothing to hand over.'
              : 'That test was not done, so there is no report.',
        });
      }

      if (existing.handedOverAt) {
        throw new ConflictException({
          code: 'ALREADY_HANDED_OVER',
          message: 'This report has already been handed over.',
        });
      }

      const to = handedOverTo.trim();
      if (!to) {
        throw new BadRequestException({
          code: 'RECIPIENT_REQUIRED',
          message: 'Say who took the report — the patient, or whoever collected it.',
        });
      }

      const order = await tx.diagnosticOrder.update({
        where: { id: orderId },
        data: {
          handedOverAt: new Date(),
          handedOverByUserId: meta.actorUserId,
          handedOverTo: to,
        },
        select: ORDER_SELECT,
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.handover',
        resourceType: 'DiagnosticOrder',
        resourceId: orderId,
        patientId: existing.patientId,
        changedFields: ['handedOverAt', 'handedOverTo'],
        ...meta,
      });

      return toView(order);
    });
  }

  /**
   * Cancel an order raised in error.
   *
   * Not a delete — "why was this patient sent for an X-ray" is a question with
   * an answer, and removing the row removes the answer. A completed order cannot
   * be cancelled: the film exists, and pretending otherwise would leave a
   * document attached to a cancelled request.
   */
  async cancelOrder(tenantId: string, orderId: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.diagnosticOrder.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, patientId: true },
      });
      if (!existing) throw new NotFoundException('No such order.');

      if (existing.status === 'COMPLETED') {
        throw new BadRequestException({
          code: 'ORDER_ALREADY_COMPLETED',
          message: 'That test has already been done. It cannot be cancelled.',
        });
      }

      const order = await tx.diagnosticOrder.update({
        where: { id: orderId },
        data: { status: 'CANCELLED' },
        select: ORDER_SELECT,
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.cancel',
        resourceType: 'DiagnosticOrder',
        resourceId: orderId,
        patientId: existing.patientId,
        changedFields: ['status'],
        ...meta,
      });

      return toView(order);
    });
  }
}

/**
 * What an order looks like on the wire.
 *
 * The patient's name and UHID are here because the worklist is unusable without
 * them — a technician has to match a request to the person in front of them.
 * Everything else about the patient is not in this shape.
 */
const ORDER_SELECT = {
  id: true,
  description: true,
  status: true,
  createdAt: true,
  completedAt: true,
  resultNote: true,
  appointmentId: true,
  department: { select: { id: true, name: true } },
  /**
   * Which catalogue test this was, when it was one. Deliberately without the
   * price: the worklist is read by the diagnostics role, which holds no billing
   * permission, and a department does not need to know what it charges to run
   * the machine. The fee is served by `catalogue()` to whoever may order.
   */
  service: { select: { id: true, code: true, name: true } },
  /** Who decided the test was needed, and the outside doctor when there is one. */
  referralSource: true,
  referrerName: true,
  referrerClinic: true,
  referrerPhone: true,
  /**
   * Everything the pay-first rule needs, loaded with the order.
   *
   * Nested rather than fetched per row: a worklist of forty would otherwise be
   * forty extra round trips, and a worklist that is slow to load is a worklist
   * people leave open and stale.
   */
  invoiceLineId: true,
  ...DIAGNOSTIC_BILLING_SELECT,
  patient: { select: { id: true, name: true, uhid: true, gender: true, ageYears: true } },
  orderedBy: { select: { id: true, fullName: true } },
  completedBy: { select: { id: true, fullName: true } },
  /** Whether the patient has actually been given the report (FR-DIA-13). */
  handedOverAt: true,
  handedOverTo: true,
  handedOverBy: { select: { id: true, fullName: true } },
  /** So the worklist can show "2 files" without a second query per row. */
  _count: { select: { documents: true } },
} as const;

/**
 * An order as a screen sees it: the billing STATE, never the billing rows.
 *
 * `ORDER_SELECT` pulls the invoice's payments in so the state can be computed
 * without a query per row. Handing those payments onward would put a bill's
 * takings in front of the diagnostics role, which holds no billing permission
 * at all — so they are reduced to a state here and the raw rows are dropped.
 * Every method that returns an order goes through this.
 */
function toView<T extends DiagnosticBillingInput>(order: T) {
  const { invoiceLine: _invoiceLine, legacyUnbilled: _legacyUnbilled, ...rest } = order;
  return { ...rest, billing: diagnosticBillingState(order) };
}
