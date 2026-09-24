import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { clinicToday, localToInstant } from '../clinic-time.js';

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

  /**
   * Every department, diagnostic ones included.
   *
   * Distinct from `GET /departments`, which is the FIRST STEP OF BOOKING and
   * deliberately hides diagnostic departments — nobody books an appointment with
   * radiology. Setup needs to see what booking hides, or an administrator can
   * create an X-ray department and never see it again.
   */
  async listDepartments(tenantId: string) {
    const departments = await this.prisma.forTenant(tenantId, (tx) =>
      tx.department.findMany({
        where: { isActive: true },
        orderBy: [{ isDiagnostic: 'asc' }, { displayOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, isDiagnostic: true },
      }),
    );
    return { departments };
  }

  async createDepartment(tenantId: string, name: string, meta: RequestMeta, isDiagnostic = false) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const clash = await tx.department.findFirst({ where: { name: name.trim() } });
      if (clash) {
        throw new ConflictException({
          code: 'DEPARTMENT_EXISTS',
          message: `There is already a department called “${name.trim()}”.`,
        });
      }

      const created = await tx.department.create({
        data: { tenantId, name: name.trim(), isDiagnostic },
        select: { id: true, name: true, displayOrder: true, isActive: true, isDiagnostic: true },
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
    input: { name?: string; displayOrder?: number; isActive?: boolean; isDiagnostic?: boolean },
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
          ...(input.isDiagnostic === undefined ? {} : { isDiagnostic: input.isDiagnostic }),
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
          previousUserId: true,
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
          // What decides whether this doctor may be deleted. Sent as counts, not
          // a flag, so the screen can say WHY a doctor cannot be — "12
          // appointments" — rather than only greying a button out.
          _count: { select: { appointments: true, encounters: true } },
        },
      });

      /**
       * For an unlinked entry with consultations, the one login that may be
       * linked back (see `linkLogin`) — so the screen offers that login alone,
       * or explains why nobody can be linked, instead of a picker full of
       * logins the server will refuse.
       */
      const relinkOnly = new Map<string, string | null>();
      for (const p of practitioners) {
        if (!p.userId && p._count.encounters > 0) relinkOnly.set(p.id, p.previousUserId);
      }

      const loginIds = [...practitioners.map((p) => p.userId), ...relinkOnly.values()].filter(
        (id): id is string => Boolean(id),
      );
      const logins = new Map(
        (
          await tx.user.findMany({
            where: { id: { in: loginIds } },
            select: { id: true, fullName: true, email: true },
          })
        ).map((u) => [u.id, u]),
      );

      return {
        practitioners: practitioners.map(({ _count, previousUserId: _previous, ...p }) => {
          const previous = relinkOnly.get(p.id);
          return {
            ...p,
            history: { appointments: _count.appointments, encounters: _count.encounters },
            login: p.userId ? (logins.get(p.userId) ?? null) : null,
            // Absent when any eligible login may be linked; null when none may.
            ...(relinkOnly.has(p.id)
              ? { relinkOnly: previous ? (logins.get(previous) ?? null) : null }
              : {}),
          };
        }),
        // Offered by the screen so the common case — the doctor who also signs
        // in — is one click rather than a hunt for an id.
        linkableUsers: await linkableLogins(tx),
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
      if (input.userId) await assertLoginLinkable(tx, input.userId);

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

  /**
   * Change a doctor's profile.
   *
   * The signature IS the rule. This took `Record<string, unknown>` and handed it
   * to Prisma as `data: input as never` — a cast that turns off the only
   * check that would have noticed the shape growing a column it should not
   * write. Whatever the DTO happened to allow went to the database, which is how
   * `departmentId` was editable without anybody choosing that.
   *
   * Now the fields are named here as well as in the DTO. Two lists is a cost;
   * it buys a compiler error rather than a silent write if either one moves,
   * and `departmentId` is not spellable in either.
   */
  async updatePractitioner(
    tenantId: string,
    id: string,
    input: {
      fullName?: string;
      prefix?: string;
      registrationNumber?: string;
      qualification?: string;
      specialty?: string;
      consultationFeePaise?: number | null;
      followUpFeePaise?: number | null;
      isActive?: boolean;
    },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.practitioner.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Doctor not found');

      /**
       * Switching off is refused while patients are still coming to see this
       * doctor. Switching off takes them off the booking screen, but it does
       * not move anybody already booked — those patients would arrive to a
       * doctor the clinic no longer lists. Switching back on is never refused.
       *
       * The row is locked first, so a booking already in flight for this doctor
       * finishes before the count and is included in it.
       */
      if (input.isActive === false) {
        await tx.$queryRaw`SELECT id FROM practitioner WHERE id = ${id}::uuid FOR UPDATE`;
        const upcoming = await upcomingAppointments(tx, tenantId, id);
        if (upcoming > 0) {
          throw new ConflictException({
            code: 'PRACTITIONER_HAS_UPCOMING',
            message:
              `This doctor has ${upcoming} upcoming appointment${upcoming === 1 ? '' : 's'} ` +
              `(today or later). Cancel or move ${upcoming === 1 ? 'it' : 'them'} before switching ` +
              `the doctor off.`,
            upcoming,
          });
        }
      }

      // Built key by key, and only from keys the caller actually sent: an
      // absent field must leave the stored value alone, while an explicit
      // `null` fee must clear it. Spreading `input` wholesale would write
      // `undefined` over columns nobody mentioned.
      const data = {
        ...(input.fullName === undefined ? {} : { fullName: input.fullName.trim() }),
        ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
        ...(input.registrationNumber === undefined
          ? {}
          : { registrationNumber: input.registrationNumber }),
        ...(input.qualification === undefined ? {} : { qualification: input.qualification }),
        ...(input.specialty === undefined ? {} : { specialty: input.specialty }),
        ...(input.consultationFeePaise === undefined
          ? {}
          : { consultationFeePaise: input.consultationFeePaise }),
        ...(input.followUpFeePaise === undefined
          ? {}
          : { followUpFeePaise: input.followUpFeePaise }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      };

      const updated = await tx.practitioner.update({
        where: { id },
        data,
        select: { id: true, fullName: true, isActive: true },
      });

      await this.audit.record(tx, tenantId, {
        action: 'practitioner.update',
        resourceType: 'Practitioner',
        resourceId: id,
        changedFields: Object.keys(data),
        ...meta,
      });

      return updated;
    });
  }

  /**
   * Delete a doctor who was added by mistake — and ONLY one with no history.
   *
   * "No history" means no appointment of any status, cancelled and no-show
   * included, and no consultation. A cancelled appointment is still a record
   * that the clinic offered this doctor to a patient on a date; it is refused
   * rather than swept away with the doctor. Everyone with history is switched
   * off instead, the same as users, services, promotions and schedules.
   *
   * The refusal is checked first and answered as a 409 with the counts, so the
   * administrator is told what is in the way rather than being shown the
   * database's foreign-key error as a generic 500.
   *
   * **The race.** An appointment booked for this doctor between the check and
   * the delete is closed off twice:
   *
   *   1. The practitioner row is locked `FOR UPDATE` before counting. Booking
   *      takes a key-share lock on the same row when it checks its foreign key,
   *      so a booking already in flight makes this wait until it commits — and
   *      the count, a fresh statement at READ COMMITTED, then sees it.
   *   2. If the delete still trips the RESTRICT foreign key regardless, the
   *      failure is caught OUTSIDE the transaction (Postgres has aborted it by
   *      then, so nothing more can run inside it), history is counted afresh,
   *      and the answer is the same 409.
   *
   * A doctor who is the ONLY one on a live waiting-room screen is refused with
   * a 409 naming the screen — an empty list means "all doctors", and the delete
   * must not quietly widen what a screen shows.
   *
   * In the same transaction, the doctor is taken off every other waiting-room
   * screen that listed them — `display_device.practitioner_ids` has no foreign key, so
   * nothing else would — and the delete is audited with the doctor's name and
   * registration number. Every earlier audit row about this doctor points at an
   * id that will no longer exist; this row is what says who it was.
   *
   * Schedules and schedule exceptions go with the doctor (CASCADE). A linked
   * login is freed by the row disappearing: the link lives on this row.
   */
  async deletePractitioner(tenantId: string, id: string, meta: RequestMeta) {
    try {
      return await this.prisma.forTenant(tenantId, async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM practitioner WHERE id = ${id}::uuid FOR UPDATE
        `;
        if (locked.length === 0) throw new NotFoundException('Doctor not found');

        const history = await practitionerHistory(tx, id);
        if (history.appointments > 0 || history.encounters > 0) {
          throw historyConflict(history);
        }

        const doctor = await tx.practitioner.findUniqueOrThrow({
          where: { id },
          select: { fullName: true, registrationNumber: true, userId: true },
        });

        /**
         * A screen that shows ONLY this doctor is refused, not cleaned.
         *
         * An empty `practitioner_ids` means "every doctor at this location", so
         * taking the last id off would silently turn a screen outside one
         * doctor's room into the whole clinic's queue. Only live screens count:
         * a revoked one shows nothing and never comes back, so emptying its
         * list changes nothing anybody sees.
         */
        const soleScreens = await tx.$queryRaw<Array<{ name: string }>>`
          SELECT name FROM display_device
           WHERE is_active
             AND ${id}::uuid = ANY(practitioner_ids)
             AND cardinality(array_remove(practitioner_ids, ${id}::uuid)) = 0
           ORDER BY name
        `;
        if (soleScreens.length > 0) {
          throw onlyDoctorOnScreenConflict(
            doctor.fullName,
            soleScreens.map((s) => s.name),
          );
        }

        const screens = await tx.$executeRaw`
          UPDATE display_device
             SET practitioner_ids = array_remove(practitioner_ids, ${id}::uuid),
                 updated_at = now()
           WHERE ${id}::uuid = ANY(practitioner_ids)
        `;

        await tx.practitioner.delete({ where: { id } });

        await this.audit.record(tx, tenantId, {
          action: 'practitioner.delete',
          resourceType: 'Practitioner',
          resourceId: id,
          changedFields: [],
          reason:
            `${doctor.fullName}` +
            (doctor.registrationNumber ? `, registration ${doctor.registrationNumber}` : '') +
            (doctor.userId ? ', login unlinked by the delete' : '') +
            (screens > 0 ? `, removed from ${screens} waiting-room screen(s)` : ''),
          ...meta,
        });

        return { id, deleted: true as const };
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        const history = await this.prisma.forTenant(tenantId, (tx) => practitionerHistory(tx, id));
        throw historyConflict(history);
      }
      throw err;
    }
  }

  // --- the login link ------------------------------------------------------

  /**
   * Take a login off a doctor entry — the fix for a login linked to the wrong
   * doctor. Administrator only (the controller asks for `user:manage` as well
   * as `schedule:manage`), with a reason, audited.
   *
   * Only the link moves. The entry, its hours, appointments and consultations
   * are untouched; the login stops resolving to it on its next request,
   * because `/auth/me`, the queue gate and the consultation gate all look the
   * link up per request rather than carrying it in the session token.
   *
   * The removed login is kept in `previous_user_id`, in the same
   * transaction: it is the one login that may be linked back to an entry that
   * has consultations. The audit event says the same thing in words, for
   * people; the rule reads the column.
   */
  async unlinkLogin(tenantId: string, id: string, reason: string, meta: RequestMeta) {
    const why = requireReason(reason);

    return this.prisma.forTenant(tenantId, async (tx) => {
      const doctor = await lockPractitioner(tx, id);
      if (!doctor.userId) {
        throw new ConflictException({
          code: 'NO_LOGIN_LINKED',
          message: `${doctor.fullName} has no login linked, so there is nothing to unlink.`,
        });
      }

      const user = await tx.user.findUnique({
        where: { id: doctor.userId },
        select: { email: true },
      });

      await tx.practitioner.update({
        where: { id },
        data: { userId: null, previousUserId: doctor.userId },
      });

      await this.audit.record(tx, tenantId, {
        action: 'practitioner.unlink_login',
        resourceType: 'Practitioner',
        resourceId: id,
        changedFields: ['userId'],
        reason: loginAuditReason(
          doctor.userId,
          `(${user?.email ?? 'unknown email'}) unlinked from ${doctor.fullName}`,
          why,
        ),
        ...meta,
      });

      return { id, userId: null };
    });
  }

  /**
   * Link a login to a doctor entry that has none.
   *
   * Refused when:
   *   - the entry already has a login — unlink it first, so that moving a
   *     login is always two audited acts and never a silent swap;
   *   - the login fails the same rule the linkable-logins list uses
   *     (`assertLoginLinkable`) — active, holds the doctor role, not linked
   *     to any entry;
   *   - the entry has consultations and this is not the login last unlinked
   *     from it. Linking would make another person the owner of notes they did
   *     not write: every consultation gate asks "is the caller's entry the one
   *     on this note", and the link is what answers it.
   *
   * Appointments never block: a booking is the clinic's, not the doctor's
   * writing.
   *
   * **Concurrency.** The entry is locked `FOR UPDATE`, so two links to the same
   * entry run one after the other and the second finds the first's login. Two
   * links of the same login to different entries each pass the check (neither
   * sees the other's uncommitted write), and the unique index on
   * `practitioner.user_id` settles it — that violation is caught and answered
   * as the same 409 the check gives, never a 500.
   */
  async linkLogin(tenantId: string, id: string, userId: string, reason: string, meta: RequestMeta) {
    const why = requireReason(reason);

    try {
      return await this.prisma.forTenant(tenantId, async (tx) => {
        const doctor = await lockPractitioner(tx, id);
        if (doctor.userId) {
          throw new ConflictException({
            code: 'PRACTITIONER_HAS_LOGIN',
            message: `${doctor.fullName} already has a login linked. Unlink it first.`,
          });
        }

        const user = await assertLoginLinkable(tx, userId);

        const encounters = await tx.encounter.count({ where: { practitionerId: id } });
        if (encounters > 0 && doctor.previousUserId !== userId) {
          throw new ConflictException({
            code: 'LOGIN_WOULD_TAKE_OVER_NOTES',
            message:
              `${doctor.fullName} has ${encounters} consultation${encounters === 1 ? '' : 's'}. ` +
              `Linking ${user.fullName}'s login would make them the owner of those notes, so ` +
              `only the login that was previously linked to this doctor can be linked back.`,
            encounters,
          });
        }

        await tx.practitioner.update({ where: { id }, data: { userId } });

        await this.audit.record(tx, tenantId, {
          action: 'practitioner.link_login',
          resourceType: 'Practitioner',
          resourceId: id,
          changedFields: ['userId'],
          reason: loginAuditReason(userId, `(${user.email}) linked to ${doctor.fullName}`, why),
          ...meta,
        });

        return { id, userId };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'USER_ALREADY_LINKED',
          message: 'That login was linked to another doctor a moment ago. Reload and try again.',
        });
      }
      throw err;
    }
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

  /**
   * The whole price list, including what is switched off (FR-PRC-01).
   *
   * A SECOND list endpoint rather than a flag on the existing one. `GET
   * /services` answers "what may I put on a bill", is behind `invoice:read`, and
   * correctly hides inactive rows — the finance desk must not be able to charge
   * for something the clinic stopped offering. This answers "what does this
   * clinic charge for", is behind `tenant:configure`, and must show the
   * switched-off ones because FR-PRC-03 is about being able to see and revive
   * them. One endpoint serving both would have to be told which it was doing,
   * and the wrong answer either hides a price from the administrator or offers a
   * withdrawn service to the desk.
   */
  async priceList(tenantId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const services = await tx.service.findMany({
        orderBy: [{ isActive: 'desc' }, { category: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          category: true,
          pricePaise: true,
          taxRateBasisPoints: true,
          isActive: true,
          updatedAt: true,
          department: { select: { id: true, name: true } },
        },
      });

      // The departments an administrator may attach a service to, so the screen
      // does not need a second round trip to fill one dropdown.
      const departments = await tx.department.findMany({
        where: { isActive: true },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true },
      });

      return { services, departments };
    });
  }

  /**
   * Create a service, or change one that exists.
   *
   * **`isActive` is not touched unless the caller says so**, and that is a fix
   * rather than a preference. This used to hardcode `isActive: true` in the
   * update branch, so switching a service off and later correcting its price
   * silently brought it back — the clinic would start being offered a service it
   * had withdrawn, with nothing on any screen to explain how. FR-PRC-03 says a
   * service is switched off and never deleted; a switch that undoes itself on
   * the next edit is not a switch.
   *
   * Every field is optional on update for the same reason: a partial edit must
   * change what it names and nothing else.
   */
  async upsertService(
    tenantId: string,
    input: {
      code: string;
      name: string;
      category: string;
      pricePaise: number;
      taxRateBasisPoints?: number;
      departmentId?: string | null;
      isActive?: boolean;
    },
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      if (input.departmentId) {
        // Read through the tenant client, so a department id from another clinic
        // is simply not found rather than being compared against.
        const department = await tx.department.findUnique({
          where: { id: input.departmentId },
          select: { id: true },
        });
        if (!department) throw new BadRequestException('That department does not exist.');
      }

      const service = await tx.service.upsert({
        where: { tenantId_code: { tenantId, code: input.code } },
        create: {
          tenantId,
          code: input.code,
          name: input.name.trim(),
          category: input.category as never,
          pricePaise: input.pricePaise,
          taxRateBasisPoints: input.taxRateBasisPoints ?? 0,
          departmentId: input.departmentId ?? null,
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
        update: {
          name: input.name.trim(),
          category: input.category as never,
          pricePaise: input.pricePaise,
          ...(input.taxRateBasisPoints === undefined
            ? {}
            : { taxRateBasisPoints: input.taxRateBasisPoints }),
          ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
          // Absent means "leave it as it is". See the note above.
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
        select: {
          id: true,
          code: true,
          name: true,
          category: true,
          pricePaise: true,
          taxRateBasisPoints: true,
          isActive: true,
          department: { select: { id: true, name: true } },
        },
      });

      await this.audit.record(tx, tenantId, {
        action: 'service.upsert',
        resourceType: 'Service',
        resourceId: service.id,
        changedFields: Object.keys(input).filter((k) => k !== 'code'),
        ...meta,
      });

      return service;
    });
  }

  /**
   * Switch a service off, or back on (FR-PRC-03).
   *
   * The delete. A service no longer offered is withdrawn, never removed —
   * reporting groups by service, and a deleted one makes last month's figures
   * unexplainable. Historical invoice lines are untouched either way: they
   * copied the name and price at billing time and do not read this row.
   */
  async setServiceActive(tenantId: string, id: string, isActive: boolean, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const existing = await tx.service.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException('Service not found');

      const service = await tx.service.update({
        where: { id },
        data: { isActive },
        select: {
          id: true,
          code: true,
          name: true,
          category: true,
          pricePaise: true,
          taxRateBasisPoints: true,
          isActive: true,
          department: { select: { id: true, name: true } },
        },
      });

      await this.audit.record(tx, tenantId, {
        action: isActive ? 'service.activate' : 'service.deactivate',
        resourceType: 'Service',
        resourceId: id,
        changedFields: ['isActive'],
        ...meta,
      });

      return service;
    });
  }
}

/**
 * The visits that stand in the way of switching a doctor off: still to happen
 * or still happening, from the start of today in the clinic's own timezone.
 * "Today" includes this morning — a patient booked at 09:00 who has not been
 * seen yet is still coming. Cancelled, no-show and finished visits do not count.
 */
const UPCOMING_STATUSES = ['BOOKED', 'ARRIVED', 'IN_PROGRESS', 'AWAITING_TESTS'] as const;

async function upcomingAppointments(
  tx: TenantClient,
  tenantId: string,
  practitionerId: string,
): Promise<number> {
  const { timezone } = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { timezone: true },
  });
  const startOfToday = localToInstant(clinicToday(timezone), '00:00', timezone);

  return tx.appointment.count({
    where: {
      practitionerId,
      status: { in: [...UPCOMING_STATUSES] },
      startAt: { gte: startOfToday },
    },
  });
}

/** What stands in the way of deleting a doctor. */
async function practitionerHistory(
  tx: TenantClient,
  practitionerId: string,
): Promise<{ appointments: number; encounters: number }> {
  const [appointments, encounters] = await Promise.all([
    tx.appointment.count({ where: { practitionerId } }),
    tx.encounter.count({ where: { practitionerId } }),
  ]);
  return { appointments, encounters };
}

/**
 * The refusal, worded as the way out.
 *
 * The counts can come back as zero on the race path: the conflicting row was
 * someone else's, and it may have been rolled back by the time this recounts.
 * The request was still refused, so it is still a 409 — with a sentence that
 * says to look again rather than one claiming "0 appointments" is the problem.
 */
function historyConflict(history: { appointments: number; encounters: number }) {
  const parts = [
    history.appointments > 0
      ? `${history.appointments} appointment${history.appointments === 1 ? '' : 's'}`
      : null,
    history.encounters > 0
      ? `${history.encounters} consultation${history.encounters === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean);

  return new ConflictException({
    code: 'PRACTITIONER_HAS_HISTORY',
    message:
      parts.length > 0
        ? `This doctor has ${parts.join(' and ')}, so they cannot be deleted — switch them off instead.`
        : 'Something was recorded for this doctor while they were being deleted. Reload and try again.',
    appointments: history.appointments,
    encounters: history.encounters,
  });
}

/**
 * The refusal for a doctor who is the whole of some waiting-room screen.
 *
 * "Switch it off, pair a new one" is the only way out that exists: a paired
 * screen's doctors cannot be edited, and switching one off is permanent. The
 * message says so rather than offering a "reassign" nobody can find.
 */
function onlyDoctorOnScreenConflict(doctorName: string, screens: string[]) {
  const quoted = screens.map((n) => `“${n}”`);
  const named =
    quoted.length === 1
      ? `the waiting-room screen ${quoted[0]}`
      : `the waiting-room screens ${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;

  return new ConflictException({
    code: 'PRACTITIONER_ONLY_DOCTOR_ON_SCREEN',
    message:
      `${doctorName} is the only doctor on ${named}. Deleting them would make ` +
      `${quoted.length === 1 ? 'it' : 'those screens'} show every doctor's queue — ` +
      `switch ${quoted.length === 1 ? 'that screen' : 'them'} off first, and pair a new ` +
      `screen for the doctors it should show.`,
    screens,
  });
}

/**
 * The delete tripping a foreign key that still points at the doctor.
 *
 * Matched on the POSTGRES code, not Prisma's, and both halves of that were
 * learnt from the race test rather than guessed:
 *
 *   - `ON DELETE RESTRICT` raises 23001 (restrict_violation), not the 23503
 *     (foreign_key_violation) that NO ACTION raises. Both mean "still
 *     referenced", so both are accepted.
 *   - Under the pg driver adapter Prisma reports this as P2039, not the P2003
 *     its documentation leads you to expect, and the database's own code sits
 *     at `meta.driverAdapterError.cause.code`. Prisma's code is the part most
 *     likely to change between versions; the database's is not.
 */
function isForeignKeyViolation(err: unknown): boolean {
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { code?: string; originalCode?: string } } };
  } | null;
  const pg = e?.meta?.driverAdapterError?.cause;
  const code = pg?.code ?? pg?.originalCode ?? e?.code;
  return code === '23001' || code === '23503' || e?.code === 'P2003';
}

// --- the login link: rules ---------------------------------------------------

/**
 * Who may be linked to a doctor entry: an active login holding the doctor
 * role, not already linked to an entry.
 *
 * The ONE statement of that rule. The linkable-logins list on the setup screen
 * is this with no filter; the check at doctor creation and at "Link login" is
 * this filtered to one id. A login the screen offers is therefore exactly a
 * login the server accepts, and a change to the rule cannot reach one without
 * the other.
 */
async function linkableLogins(tx: TenantClient, onlyUserId?: string) {
  const [candidates, linked] = await Promise.all([
    tx.user.findMany({
      where: {
        ...(onlyUserId ? { id: onlyUserId } : {}),
        isActive: true,
        roles: { some: { role: { key: 'doctor' } } },
      },
      select: { id: true, fullName: true, email: true },
      orderBy: { fullName: 'asc' },
    }),
    tx.practitioner.findMany({
      where: onlyUserId ? { userId: onlyUserId } : { userId: { not: null } },
      select: { userId: true },
    }),
  ]);

  const taken = new Set(linked.map((p) => p.userId));
  return candidates.filter((u) => !taken.has(u.id));
}

/**
 * `linkableLogins` for one login, refusing with the reason when it is not.
 *
 * The rule is decided by `linkableLogins` alone. What follows a refusal only
 * chooses the sentence — it never lets through a login the rule turned away.
 */
async function assertLoginLinkable(tx: TenantClient, userId: string) {
  const [eligible] = await linkableLogins(tx, userId);
  if (eligible) return eligible;

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { fullName: true, isActive: true },
  });
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

  throw new ConflictException({
    code: 'LOGIN_NOT_LINKABLE',
    message: user.isActive
      ? `${user.fullName}'s login does not hold the doctor role, so it cannot be linked to a doctor.`
      : `${user.fullName}'s login is deactivated, so it cannot be linked to a doctor.`,
  });
}

/** Lock a doctor entry for a link change, or 404. */
async function lockPractitioner(tx: TenantClient, id: string) {
  const [row] = await tx.$queryRaw<
    Array<{ full_name: string; user_id: string | null; previous_user_id: string | null }>
  >`
    SELECT full_name, user_id, previous_user_id
      FROM practitioner WHERE id = ${id}::uuid FOR UPDATE
  `;
  if (!row) throw new NotFoundException('Doctor not found');
  return {
    fullName: row.full_name,
    userId: row.user_id,
    // The login last unlinked from this entry — the only one that may be linked
    // back once it has consultations. See 20260922100000_practitioner_previous_user.
    previousUserId: row.previous_user_id,
  };
}

/**
 * `login <id> (<email>) linked to Dr X. Reason: …` — which login, which doctor
 * and why, for whoever reads the trail. Cut to the column's 500 characters from
 * the end, so it is the administrator's words that are shortened, not the ids.
 */
function loginAuditReason(userId: string, what: string, why: string): string {
  return `login ${userId} ${what}. Reason: ${why}`.slice(0, 500);
}

function requireReason(reason: string): string {
  const why = reason.trim();
  if (why.length < 3) {
    throw new BadRequestException(
      'Say why. A link change nobody can explain is one nobody can check.',
    );
  }
  return why;
}

/** The unique index on `practitioner.user_id`, however Prisma reports it. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { code?: string; originalCode?: string } } };
  } | null;
  const pg = e?.meta?.driverAdapterError?.cause;
  return (pg?.code ?? pg?.originalCode) === '23505' || e?.code === 'P2002';
}
