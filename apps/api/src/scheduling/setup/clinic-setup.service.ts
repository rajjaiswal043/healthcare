import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';

export interface RequestMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
}

/** "09:00" — wall clock in the clinic's own timezone. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h as number) * 60 + (m as number);
};

/**
 * Everything a clinic has to set up before it can see a patient.
 *
 * The gap this fills was invisible until somebody onboarded a real clinic: they
 * created an administrator, a doctor and a receptionist, and the booking screen
 * still said "no doctors". Because a USER is not a PRACTITIONER.
 *
 *   app_user      somebody who can sign in.
 *   practitioner  somebody a patient can be booked with — carrying the NMC
 *                 registration number that every prescription is required to
 *                 print, a specialty, and a fee.
 *
 * They come apart in both directions, which is why they are separate rows: a
 * visiting consultant who never signs in is a practitioner with no user, and a
 * receptionist is a user with no practitioner. What was missing was any way to
 * create the second kind, and any way to give one weekly hours — without which
 * availability is empty by construction, since slots are computed from the
 * template rather than stored.
 */
@Injectable()
export class ClinicSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- departments ---------------------------------------------------------

  async createDepartment(tenantId: string, name: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const clash = await tx.department.findFirst({ where: { name: name.trim() } });
      if (clash) {
        throw new ConflictException({
          code: 'DEPARTMENT_EXISTS',
          message: `There is already a department called “${name.trim()}”.`,
        });
      }

      const created = await tx.department.create({
        data: { tenantId, name: name.trim() },
        select: { id: true, name: true, displayOrder: true, isActive: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'department.create',
        resourceType: 'Department',
        resourceId: created.id,
        changedFields: ['name'],
        ...meta,
      });

      return created;
    });
  }

  async updateDepartment(
    tenantId: string,
    id: string,
    input: { name?: string; displayOrder?: number; isActive?: boolean },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.department.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException('Department not found');

      const updated = await tx.department.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.displayOrder === undefined ? {} : { displayOrder: input.displayOrder }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
        select: { id: true, name: true, displayOrder: true, isActive: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'department.update',
        resourceType: 'Department',
        resourceId: id,
        changedFields: Object.keys(input),
        ...meta,
      });

      return updated;
    });
  }

  // --- practitioners -------------------------------------------------------

  /** Every doctor, with their hours, for the setup screen. */
  async listPractitioners(tenantId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const practitioners = await tx.practitioner.findMany({
        orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
        select: {
          id: true,
          fullName: true,
          prefix: true,
          registrationNumber: true,
          qualification: true,
          specialty: true,
          departmentId: true,
          userId: true,
          consultationFeePaise: true,
          followUpFeePaise: true,
          overbookPerSession: true,
          isActive: true,
          department: { select: { id: true, name: true } },
          schedules: {
            where: { isActive: true },
            orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
            select: {
              id: true,
              locationId: true,
              dayOfWeek: true,
              startTime: true,
              endTime: true,
              slotMinutes: true,
              capacityPerSlot: true,
              validFrom: true,
              validTo: true,
            },
          },
        },
      });

      /**
       * The users who could be linked to a doctor, and are not already.
       *
       * Offered by the screen so the common case — the doctor who also signs in
       * — is one click rather than a hunt for an id.
       */
      const linkable = await tx.user.findMany({
        where: {
          isActive: true,
          roles: { some: { role: { key: 'doctor' } } },
        },
        select: { id: true, fullName: true, email: true },
        orderBy: { fullName: 'asc' },
      });

      const linked = new Set(practitioners.map((p) => p.userId).filter(Boolean));

      return {
        practitioners,
        linkableUsers: linkable.filter((u) => !linked.has(u.id)),
      };
    });
  }

  async createPractitioner(
    tenantId: string,
    input: {
      fullName: string;
      prefix?: string;
      registrationNumber?: string;
      qualification?: string;
      specialty?: string;
      departmentId?: string;
      userId?: string;
      consultationFeePaise?: number;
      followUpFeePaise?: number;
    },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      if (input.userId) await this.assertUserFree(tx, input.userId);

      const created = await tx.practitioner.create({
        data: {
          tenantId,
          fullName: input.fullName.trim(),
          // Never defaulted. The clinic types the honorific into the name —
          // a system-supplied "Dr" is wrong for a physiotherapist and, when the
          // admin typed one too, produced "Dr Dr. Vivek Swarnkar".
          // See 20260826170000_fold_practitioner_prefix.
          prefix: input.prefix ?? null,
          registrationNumber: input.registrationNumber ?? null,
          qualification: input.qualification ?? null,
          specialty: input.specialty ?? null,
          departmentId: input.departmentId ?? null,
          userId: input.userId ?? null,
          consultationFeePaise: input.consultationFeePaise ?? null,
          followUpFeePaise: input.followUpFeePaise ?? null,
        },
        select: { id: true, fullName: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'practitioner.create',
        resourceType: 'Practitioner',
        resourceId: created.id,
        changedFields: ['fullName', 'registrationNumber', 'userId'],
        ...meta,
      });

      return created;
    });
  }

  async updatePractitioner(
    tenantId: string,
    id: string,
    input: Record<string, unknown>,
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.practitioner.findUnique({
        where: { id },
        select: { id: true, userId: true },
      });
      if (!existing) throw new NotFoundException('Doctor not found');

      if (typeof input.userId === 'string' && input.userId !== existing.userId) {
        await this.assertUserFree(tx, input.userId);
      }

      const updated = await tx.practitioner.update({
        where: { id },
        data: input as never,
        select: { id: true, fullName: true, isActive: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'practitioner.update',
        resourceType: 'Practitioner',
        resourceId: id,
        changedFields: Object.keys(input),
        ...meta,
      });

      return updated;
    });
  }

  // --- weekly hours --------------------------------------------------------

  /**
   * Add a session to a doctor's week.
   *
   * The overlap check is the one that earns its place: two sessions covering the
   * same hour on the same day produce duplicate slots at the same time, and the
   * booking screen offers 09:15 twice with no way to tell them apart.
   */
  async addSchedule(
    tenantId: string,
    practitionerId: string,
    input: {
      locationId: string;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      slotMinutes?: number;
      capacityPerSlot?: number;
    },
    meta: RequestMeta,
  ) {
    if (!HHMM.test(input.startTime) || !HHMM.test(input.endTime)) {
      throw new BadRequestException('Times must be in 24-hour HH:mm form, such as 09:00.');
    }

    if (minutes(input.endTime) <= minutes(input.startTime)) {
      throw new BadRequestException('The session has to end after it starts.');
    }

    const slotMinutes = input.slotMinutes ?? 15;

    if (minutes(input.endTime) - minutes(input.startTime) < slotMinutes) {
      throw new BadRequestException(
        `A ${slotMinutes}-minute slot does not fit between ${input.startTime} and ${input.endTime}.`,
      );
    }

    return this.prisma.forTenant(tenantId, async (tx) => {
      const doctor = await tx.practitioner.findUnique({
        where: { id: practitionerId },
        select: { id: true, fullName: true },
      });
      if (!doctor) throw new NotFoundException('Doctor not found');

      const sameDay = await tx.practitionerSchedule.findMany({
        where: { practitionerId, dayOfWeek: input.dayOfWeek, isActive: true },
        select: { startTime: true, endTime: true },
      });

      const clash = sameDay.find(
        (s) =>
          minutes(input.startTime) < minutes(s.endTime) &&
          minutes(s.startTime) < minutes(input.endTime),
      );

      if (clash) {
        throw new ConflictException({
          code: 'SESSION_OVERLAPS',
          message: `That overlaps ${doctor.fullName}'s ${clash.startTime}–${clash.endTime} session on the same day.`,
        });
      }

      const created = await tx.practitionerSchedule.create({
        data: {
          tenantId,
          practitionerId,
          locationId: input.locationId,
          dayOfWeek: input.dayOfWeek,
          startTime: input.startTime,
          endTime: input.endTime,
          slotMinutes,
          capacityPerSlot: input.capacityPerSlot ?? 1,
          visitTypes: [],
          // Today, so a session added this morning is bookable this morning.
          validFrom: new Date(),
        },
        select: { id: true, dayOfWeek: true, startTime: true, endTime: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'schedule.create',
        resourceType: 'PractitionerSchedule',
        resourceId: created.id,
        changedFields: ['dayOfWeek', 'startTime', 'endTime'],
        ...meta,
      });

      return created;
    });
  }

  /**
   * Remove a session.
   *
   * Deactivated rather than deleted: appointments already booked into it keep
   * their times, and a deleted row would make "why was this booked at 4pm when
   * he does not sit on Thursdays" unanswerable.
   */
  async removeSchedule(tenantId: string, id: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.practitionerSchedule.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Session not found');

      await tx.practitionerSchedule.update({ where: { id }, data: { isActive: false } });

      await this.audit.record(tx, tenantId, {
        action: 'schedule.remove',
        resourceType: 'PractitionerSchedule',
        resourceId: id,
        changedFields: ['isActive'],
        ...meta,
      });

      return { id, isActive: false };
    });
  }

  // --- what the clinic charges ---------------------------------------------

  async upsertService(
    tenantId: string,
    input: { code: string; name: string; category: string; pricePaise: number },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const service = await tx.service.upsert({
        where: { tenantId_code: { tenantId, code: input.code } },
        create: {
          tenantId,
          code: input.code,
          name: input.name.trim(),
          category: input.category as never,
          pricePaise: input.pricePaise,
        },
        update: { name: input.name.trim(), pricePaise: input.pricePaise, isActive: true },
        select: { id: true, code: true, name: true, pricePaise: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'service.upsert',
        resourceType: 'Service',
        resourceId: service.id,
        changedFields: ['pricePaise'],
        ...meta,
      });

      return service;
    });
  }

  // --- internals -----------------------------------------------------------

  /** One user, one practitioner — the column is unique, so say so kindly. */
  private async assertUserFree(tx: TenantClient, userId: string): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    if (!user) throw new BadRequestException('That user does not exist in this clinic.');

    const taken = await tx.practitioner.findFirst({
      where: { userId },
      select: { fullName: true },
    });

    if (taken) {
      throw new ConflictException({
        code: 'USER_ALREADY_LINKED',
        message: `${user.fullName}'s login is already linked to ${taken.fullName}.`,
      });
    }
  }
}
