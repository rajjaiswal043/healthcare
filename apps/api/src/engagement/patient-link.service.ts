import {
  ConflictException,
  GoneException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { logoVersionOf } from '../platform/branding/logo-version.js';
import { clinicToday, instantToLocalTime } from '../scheduling/clinic-time.js';
import { hashPatientLinkKey, tenantIdFromPatientLinkKey } from './patient-link-key.js';
import { estimatePosition } from './queue-estimate.js';
import { loadQueueDay } from './queue-day.js';
import { flagFor } from './recovery.js';
import { firstName } from './engagement.service.js';

/**
 * What a patient sees when they open the link on their phone, and the two
 * things they can say back.
 *
 * One rule governs this file: **the response carries nothing a stranger holding
 * the phone could misuse.** A first name, a token, the doctor, the wait, and on
 * a recovery link the advice they were already given on paper. Never a UHID, a
 * mobile number, a diagnosis or a surname. Decided here, in the response,
 * because a page that "chooses not to show" something has already sent it.
 *
 * Every failure to resolve a key is the same 401, as for a waiting-room
 * screen: a mistyped link and a link from another clinic must be
 * indistinguishable to whoever holds it.
 */
@Injectable()
export class PatientLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async view(key: string) {
    const { tenantId, linkId } = await this.resolve(key, 'read');

    return this.prisma.forTenant(tenantId, async (tx) => {
      const link = await tx.patientLink.findUniqueOrThrow({
        where: { id: linkId },
        select: { purpose: true, appointmentId: true, encounterId: true, patientId: true },
      });
      const clinic = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, slug: true, timezone: true, logoMimeType: true, logoUpdatedAt: true },
      });
      const patient = await tx.patient.findUniqueOrThrow({
        where: { id: link.patientId },
        select: { name: true },
      });

      const header = {
        clinic: {
          name: clinic.name,
          slug: clinic.slug,
          logoVersion: clinic.logoMimeType ? logoVersionOf(clinic.logoUpdatedAt) : null,
        },
        patientFirstName: firstName(patient.name),
        generatedAt: new Date().toISOString(),
      };

      if (link.purpose === 'VISIT' && link.appointmentId) {
        return {
          purpose: 'VISIT' as const,
          ...header,
          visit: await this.visitView(tx, link.appointmentId, clinic.timezone),
        };
      }

      return {
        purpose: 'RECOVERY' as const,
        ...header,
        recovery: await this.recoveryView(tx, link.encounterId as string, clinic.timezone),
      };
    });
  }

  /** "On my way" or "running late". Moves nobody; tells the front desk. */
  async setArrivalIntent(key: string, intent: 'ON_THE_WAY' | 'RUNNING_LATE') {
    const { tenantId, linkId } = await this.resolve(key, 'write');

    return this.prisma.forTenant(tenantId, async (tx) => {
      const link = await tx.patientLink.findUniqueOrThrow({
        where: { id: linkId },
        select: { purpose: true, appointmentId: true, patientId: true },
      });
      if (link.purpose !== 'VISIT' || !link.appointmentId) {
        throw new ConflictException({
          code: 'WRONG_LINK',
          message: 'This link is not for a visit.',
        });
      }

      const appt = await tx.appointment.findUniqueOrThrow({
        where: { id: link.appointmentId },
        select: { status: true },
      });
      if (appt.status !== 'BOOKED') {
        throw new ConflictException({
          code: 'ALREADY_HERE',
          message: 'The clinic already has you checked in.',
        });
      }

      await tx.appointment.update({
        where: { id: link.appointmentId },
        data: { arrivalIntent: intent, arrivalIntentAt: new Date() },
      });

      await this.audit.record(tx, tenantId, {
        action: 'appointment.arrival_intent',
        resourceType: 'Appointment',
        resourceId: link.appointmentId,
        patientId: link.patientId,
        changedFields: ['arrivalIntent'],
        actorLabel: 'Patient, by link',
      });

      return { arrivalIntent: intent };
    });
  }

  /**
   * The patient's answer to "how is your pain today".
   *
   * Fills the most recent check-in that is due and unanswered. A patient who
   * answers before the first one is due — or answers again on a day nothing
   * was asked — gets a row for today, because a patient who volunteers that
   * they are worse must never be told the form is closed. Twice on one day is
   * refused: the first answer is what the chart shows.
   */
  async answerCheckin(
    key: string,
    input: { painScore: number; exercisesDone?: boolean; note?: string },
  ) {
    const { tenantId, linkId } = await this.resolve(key, 'write');

    return this.prisma.forTenant(tenantId, async (tx) => {
      const link = await tx.patientLink.findUniqueOrThrow({
        where: { id: linkId },
        select: { purpose: true, encounterId: true, patientId: true },
      });
      if (link.purpose !== 'RECOVERY' || !link.encounterId) {
        throw new ConflictException({
          code: 'WRONG_LINK',
          message: 'This link is not for check-ins.',
        });
      }
      const encounterId = link.encounterId;

      const clinic = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const today = new Date(`${clinicToday(clinic.timezone)}T00:00:00Z`);

      const due = await tx.recoveryCheckin.findFirst({
        where: { encounterId, dueOn: { lte: today }, answeredAt: null },
        orderBy: { dueOn: 'desc' },
        select: { id: true },
      });

      let target: { id: string };
      if (due) {
        target = due;
      } else {
        const todays = await tx.recoveryCheckin.findUnique({
          where: { tenantId_encounterId_dueOn: { tenantId, encounterId, dueOn: today } },
          select: { id: true, answeredAt: true },
        });
        if (todays?.answeredAt) {
          throw new ConflictException({
            code: 'ALREADY_ANSWERED',
            message: 'You have already told us how you are today. Thank you.',
          });
        }
        target =
          todays ??
          (await tx.recoveryCheckin.create({
            data: { tenantId, encounterId, patientId: link.patientId, dueOn: today },
            select: { id: true },
          }));
      }

      const previous = await tx.recoveryCheckin.findFirst({
        where: { encounterId, answeredAt: { not: null }, id: { not: target.id } },
        orderBy: { answeredAt: 'desc' },
        select: { painScore: true },
      });

      const reason = flagFor(input.painScore, previous?.painScore ?? null);
      const now = new Date();

      await tx.recoveryCheckin.update({
        where: { id: target.id },
        data: {
          answeredAt: now,
          painScore: input.painScore,
          exercisesDone: input.exercisesDone ?? null,
          note: input.note?.trim() ? input.note.trim().slice(0, 300) : null,
          ...(reason ? { flaggedAt: now, flagReason: reason } : {}),
        },
      });

      await this.audit.record(tx, tenantId, {
        action: 'recovery.checkin_answer',
        resourceType: 'Encounter',
        resourceId: encounterId,
        patientId: link.patientId,
        changedFields: ['painScore', ...(reason ? ['flaggedAt'] : [])],
        actorLabel: 'Patient, by link',
      });

      return {
        painScore: input.painScore,
        previousPainScore: previous?.painScore ?? null,
        /** True means "the clinic will call you". Never advice. */
        clinicWillCall: reason !== null,
        recovery: await this.recoveryView(tx, encounterId, clinic.timezone),
      };
    });
  }

  // --- internals -------------------------------------------------------------

  private async visitView(tx: TenantClient, appointmentId: string, timezone: string) {
    const appt = await tx.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        startAt: true,
        calledAt: true,
        completedAt: true,
        tokenNumber: true,
        queueDate: true,
        source: true,
        arrivalIntent: true,
        practitionerId: true,
        practitioner: { select: { fullName: true, specialty: true } },
      },
    });

    const isToday =
      appt.queueDate !== null &&
      appt.queueDate.toISOString().slice(0, 10) === clinicToday(timezone);

    let estimate: ReturnType<typeof estimatePosition> | null = null;
    let nowServing: number | null = null;
    if (isToday && appt.queueDate) {
      const day = await loadQueueDay(tx, appt.practitionerId, appt.queueDate);
      nowServing = day.inProgress?.tokenNumber ?? null;
      estimate = estimatePosition({
        appointment: { ...appt, status: String(appt.status) },
        waitingInOrder: day.waitingInOrder,
        inProgress: day.inProgress,
        bookedToday: day.bookedToday,
        allToday: day.all,
        now: new Date(),
      });
    }

    return {
      token: appt.tokenNumber,
      status: appt.status,
      isToday,
      date: appt.queueDate?.toISOString().slice(0, 10) ?? null,
      time: appt.source === 'WALK_IN' ? null : instantToLocalTime(appt.startAt, timezone),
      doctor: { name: appt.practitioner.fullName, specialty: appt.practitioner.specialty },
      nowServing,
      ahead: estimate?.ahead ?? null,
      etaMinutes: estimate?.etaMinutes ?? null,
      arrivalIntent: appt.arrivalIntent,
    };
  }

  private async recoveryView(tx: TenantClient, encounterId: string, timezone: string) {
    const encounter = await tx.encounter.findUniqueOrThrow({
      where: { id: encounterId },
      select: {
        startedAt: true,
        followUpDate: true,
        checkInIntervalDays: true,
        advice: true,
        prescriptionNote: true,
        practitioner: { select: { fullName: true } },
      },
    });

    const today = clinicToday(timezone);
    const rows = await tx.recoveryCheckin.findMany({
      where: { encounterId, answeredAt: { not: null } },
      orderBy: { answeredAt: 'asc' },
      select: { answeredAt: true, painScore: true, exercisesDone: true },
    });

    const answeredToday = rows.some(
      (r) => r.answeredAt && r.answeredAt.toISOString().slice(0, 10) === today,
    );

    return {
      doctor: encounter.practitioner.fullName,
      visitDate: encounter.startedAt.toISOString().slice(0, 10),
      reviewDate: encounter.followUpDate?.toISOString().slice(0, 10) ?? null,
      intervalDays: encounter.checkInIntervalDays,
      /** What the doctor asked them to do — already on their printed prescription. */
      advice: encounter.advice,
      instructions: encounter.prescriptionNote,
      answeredToday,
      history: rows.map((r) => ({
        date: (r.answeredAt as Date).toISOString(),
        painScore: r.painScore,
        exercisesDone: r.exercisesDone,
      })),
    };
  }

  /**
   * Key → tenant and link, or a uniform 401.
   *
   * Reads work for a suspended clinic (read-only means read-only, not dark);
   * answers do not, matching what a suspended clinic's staff can do.
   */
  private async resolve(
    key: string,
    mode: 'read' | 'write',
  ): Promise<{ tenantId: string; linkId: string }> {
    const tenantId = tenantIdFromPatientLinkKey(key);
    if (!tenantId) throw new UnauthorizedException('This link is not valid.');

    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (!tenant || tenant.status === 'ARCHIVED') {
      throw new UnauthorizedException('This link is not valid.');
    }
    if (mode === 'write' && tenant.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'CLINIC_UNAVAILABLE',
        message: 'The clinic cannot take replies right now. Please call them.',
      });
    }

    const keyHash = hashPatientLinkKey(key);
    const link = await this.prisma.forTenant(tenantId, async (tx) => {
      const row = await tx.patientLink.findUnique({
        where: { keyHash },
        select: { id: true, expiresAt: true, revokedAt: true },
      });
      if (!row) return null;
      if (!row.revokedAt && row.expiresAt > new Date()) {
        await tx.patientLink.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
      }
      return row;
    });

    if (!link) throw new UnauthorizedException('This link is not valid.');
    if (link.revokedAt || link.expiresAt <= new Date()) {
      throw new GoneException({
        code: 'LINK_EXPIRED',
        message: 'This link has expired. The clinic will send a new one with your next visit.',
      });
    }

    return { tenantId, linkId: link.id };
  }
}
