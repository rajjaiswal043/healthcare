import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { DocumentsService } from '../documents/documents.service.js';

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
      appointmentId: string;
      departmentId: string;
      description?: string;
      serviceId?: string;
    },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const appointment = await tx.appointment.findUnique({
        where: { id: input.appointmentId },
        select: { id: true, patientId: true },
      });
      if (!appointment) throw new NotFoundException('No such visit.');

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

      const order = await tx.diagnosticOrder.create({
        data: {
          tenantId,
          appointmentId: appointment.id,
          patientId: appointment.patientId,
          departmentId: department.id,
          orderedByUserId: meta.actorUserId,
          description,
          ...(serviceId ? { serviceId } : {}),
        },
        select: ORDER_SELECT,
      });

      await this.audit.record(tx, tenantId, {
        action: 'diagnostic.order',
        resourceType: 'DiagnosticOrder',
        resourceId: order.id,
        patientId: appointment.patientId,
        changedFields: ['description', 'departmentId', 'serviceId'],
        ...meta,
      });

      return order;
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
    filter: { departmentId?: string; status?: 'PENDING' | 'COMPLETED' },
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
    return { orders };
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
    return { orders };
  }

  /** One order, with whatever has been attached to it. */
  async order(tenantId: string, orderId: string) {
    const order = await this.prisma.forTenant(tenantId, (tx) =>
      tx.diagnosticOrder.findUnique({ where: { id: orderId }, select: ORDER_SELECT }),
    );
    if (!order) throw new NotFoundException('No such order.');

    return { ...order, documents: await this.documents.forOrder(tenantId, orderId) };
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
              : 'That test was cancelled.',
        });
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

      return order;
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

      return order;
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
  patient: { select: { id: true, name: true, uhid: true, gender: true, ageYears: true } },
  orderedBy: { select: { id: true, fullName: true } },
  completedBy: { select: { id: true, fullName: true } },
  /** So the worklist can show "2 files" without a second query per row. */
  _count: { select: { documents: true } },
} as const;
