import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { loadEnv } from '../config/env.js';
import { clinicToday, instantToLocalDate } from '../scheduling/clinic-time.js';
import { MESSAGE_CHANNEL, type MessageChannel } from './message-channel.js';
import { generatePatientLinkKey, hashPatientLinkKey } from './patient-link-key.js';
import { estimatePosition, LEAVE_NOW_MINUTES } from './queue-estimate.js';
import { loadQueueDay } from './queue-day.js';

export interface EngagementMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
}

type MessageKind =
  'TOKEN_ISSUED' | 'LEAVE_NOW' | 'CHECKIN_REQUEST' | 'REVIEW_REMINDER' | 'PRESCRIPTION';

type DeliveryStatus = 'SENT' | 'FAILED' | 'SKIPPED_NO_CONSENT';

/** Placeholder the stored copy of a message carries instead of the credential. */
const LINK_PLACEHOLDER = '[patient link]';

/** A reminder about the same review, sent again sooner than this, is nagging. */
const REMINDER_COOLDOWN_HOURS = 20;

/**
 * Everything the clinic says to a patient outside the building.
 *
 * Three rules, each enforced here and nowhere else so nothing can route round
 * them:
 *
 * 1. **Consent first.** A message goes only to a patient whose latest
 *    COMMUNICATIONS consent is granted and not withdrawn. Without it a row is
 *    still written, as SKIPPED_NO_CONSENT, so "why did she hear nothing" has an
 *    answer.
 *
 * 2. **A message never blocks the clinic.** Booking, calling and signing all
 *    succeed whether or not a message goes. Callers use the `after*` methods,
 *    which catch and log, never throw (NFR-01).
 *
 * 3. **The link is a credential and is never stored.** The patient receives it;
 *    the log keeps "[patient link]" in its place. Only the hash is in
 *    `patient_link`.
 */
@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);
  private readonly webBaseUrl = loadEnv().WEB_BASE_URL.replace(/\/$/, '');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(MESSAGE_CHANNEL) private readonly channel: MessageChannel,
  ) {}

  // --- hooks the clinic's own actions call ---------------------------------

  /** After a booking or a walk-in has committed: send the token and its live link. */
  async afterVisitBooked(tenantId: string, appointmentId: string): Promise<void> {
    await this.safely('token message', () => this.sendToken(tenantId, appointmentId));
  }

  /** After anything that moves a doctor's queue: tell whoever should now leave home. */
  async afterQueueMoved(tenantId: string, practitionerId: string): Promise<void> {
    await this.safely('leave-now check', () => this.leaveNowFor(tenantId, practitionerId));
  }

  // --- the timer -------------------------------------------------------------

  /**
   * One pass over every active clinic: due check-ins, and "time to leave" for
   * patients whose slot has come closer without the queue moving.
   *
   * Tenants are listed from `tenant`, which is not under RLS, and each is then
   * worked inside its own tenant context — the same shape as forEachTenant.
   */
  async sweep(): Promise<{ checkins: number; leaveNow: number }> {
    const tenants = await this.prisma.client.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    let checkins = 0;
    let leaveNow = 0;
    for (const t of tenants) {
      await this.safely('check-in dispatch', async () => {
        checkins += await this.dispatchDueCheckins(t.id);
      });
      await this.safely('leave-now sweep', async () => {
        leaveNow += await this.leaveNowSweep(t.id);
      });
    }
    return { checkins, leaveNow };
  }

  // --- tokens and "time to leave" --------------------------------------------

  private async sendToken(tenantId: string, appointmentId: string): Promise<void> {
    await this.prisma.forTenant(tenantId, async (tx) => {
      const appt = await tx.appointment.findUnique({
        where: { id: appointmentId },
        select: {
          id: true,
          status: true,
          startAt: true,
          source: true,
          tokenNumber: true,
          patient: { select: { id: true, name: true, mobile: true } },
          practitioner: { select: { fullName: true } },
        },
      });
      if (!appt || appt.tokenNumber === null) return;
      if (appt.status !== 'BOOKED' && appt.status !== 'ARRIVED') return;

      // Once per visit. A reschedule is a new appointment and gets its own.
      const already = await tx.outboundMessage.findFirst({
        where: { appointmentId, kind: 'TOKEN_ISSUED' },
        select: { id: true },
      });
      if (already) return;

      const clinic = await this.clinic(tx, tenantId);
      const when =
        instantToLocalDate(appt.startAt, clinic.timezone) === clinicToday(clinic.timezone)
          ? 'today'
          : `on ${formatDay(appt.startAt, clinic.timezone)}`;
      const slot =
        appt.source === 'WALK_IN'
          ? ''
          : ` Your time is ${formatTime(appt.startAt, clinic.timezone)}.`;

      await this.deliver(tx, tenantId, {
        kind: 'TOKEN_ISSUED',
        patient: appt.patient,
        appointmentId,
        link: {
          purpose: 'VISIT',
          appointmentId,
          expiresAt: new Date(appt.startAt.getTime() + 36 * 3600 * 1000),
        },
        text: (link) =>
          `Namaste ${firstName(appt.patient.name)}. Your token with ${appt.practitioner.fullName} ` +
          `${when} is ${appt.tokenNumber}.${slot}\n` +
          `Wait from home and see your place in line live: ${link}\n— ${clinic.name}`,
      });
    });
  }

  /**
   * Tell each patient still at home whose turn is close enough to set off.
   *
   * Once per visit (`leaveNowSentAt`), including when consent stops the message
   * going — otherwise every sweep would write another SKIPPED row for them.
   */
  private async leaveNowFor(tenantId: string, practitionerId: string): Promise<number> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const clinic = await this.clinic(tx, tenantId);
      const today = clinicToday(clinic.timezone);
      const day = await loadQueueDay(tx, practitionerId, new Date(`${today}T00:00:00Z`));
      const now = new Date();

      const due = day.bookedToday.filter((a) => {
        if (a.leaveNowSentAt) return false;
        const { etaMinutes } = estimatePosition({
          appointment: a,
          waitingInOrder: day.waitingInOrder,
          inProgress: day.inProgress,
          bookedToday: day.bookedToday,
          allToday: day.all,
          now,
        });
        return etaMinutes !== null && etaMinutes <= LEAVE_NOW_MINUTES;
      });
      if (due.length === 0) return 0;

      const practitioner = await tx.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
        select: { fullName: true },
      });

      let sent = 0;
      for (const a of due) {
        const estimate = estimatePosition({
          appointment: a,
          waitingInOrder: day.waitingInOrder,
          inProgress: day.inProgress,
          bookedToday: day.bookedToday,
          allToday: day.all,
          now,
        });
        const patient = await tx.patient.findUniqueOrThrow({
          where: { id: a.patientId },
          select: { id: true, name: true, mobile: true },
        });

        const status = await this.deliver(tx, tenantId, {
          kind: 'LEAVE_NOW',
          patient,
          appointmentId: a.id,
          link: {
            purpose: 'VISIT',
            appointmentId: a.id,
            expiresAt: new Date(a.startAt.getTime() + 36 * 3600 * 1000),
          },
          text: (link) =>
            `Time to leave, ${firstName(patient.name)}. About ${estimate.etaMinutes} min until your ` +
            `turn with ${practitioner.fullName} (token ${a.tokenNumber ?? '—'}).\n` +
            `Live queue: ${link}\n— ${clinic.name}`,
        });

        await tx.appointment.update({ where: { id: a.id }, data: { leaveNowSentAt: now } });
        if (status === 'SENT') sent += 1;
      }
      return sent;
    });
  }

  private async leaveNowSweep(tenantId: string): Promise<number> {
    const practitionerIds = await this.prisma.forTenant(tenantId, async (tx) => {
      const clinic = await this.clinic(tx, tenantId);
      const today = clinicToday(clinic.timezone);
      const rows = await tx.appointment.findMany({
        where: {
          queueDate: new Date(`${today}T00:00:00Z`),
          status: 'BOOKED',
          leaveNowSentAt: null,
        },
        distinct: ['practitionerId'],
        select: { practitionerId: true },
      });
      return rows.map((r) => r.practitionerId);
    });

    let sent = 0;
    for (const id of practitionerIds) sent += await this.leaveNowFor(tenantId, id);
    return sent;
  }

  // --- recovery check-ins -----------------------------------------------------

  /**
   * Send every check-in that has come due, for one clinic.
   *
   * One message per consultation per run, for the LATEST due date: if the timer
   * was off for a week, the patient gets one "how are you today", not seven.
   * Nothing goes after the review date — on that day the patient should be in
   * the room, and after it the question belongs to the next consultation.
   */
  async dispatchDueCheckins(tenantId: string, meta: EngagementMeta = {}): Promise<number> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const clinic = await this.clinic(tx, tenantId);
      const today = new Date(`${clinicToday(clinic.timezone)}T00:00:00Z`);

      const rows = await tx.recoveryCheckin.findMany({
        where: {
          dueOn: { lte: today },
          sentAt: null,
          answeredAt: null,
          encounter: { status: 'SIGNED', followUpDate: { gt: today } },
        },
        orderBy: { dueOn: 'desc' },
        select: {
          id: true,
          dueOn: true,
          encounterId: true,
          encounter: {
            select: {
              followUpDate: true,
              startedAt: true,
              practitioner: { select: { fullName: true } },
              patient: { select: { id: true, name: true, mobile: true } },
            },
          },
        },
      });

      const latestPerEncounter = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        if (!latestPerEncounter.has(r.encounterId)) latestPerEncounter.set(r.encounterId, r);
      }

      let sent = 0;
      for (const r of latestPerEncounter.values()) {
        const visitDate = instantToLocalDate(r.encounter.startedAt, clinic.timezone);
        const dayNumber = Math.round(
          (r.dueOn.getTime() - Date.parse(`${visitDate}T00:00:00Z`)) / 86400000,
        );

        const status = await this.deliver(tx, tenantId, {
          kind: 'CHECKIN_REQUEST',
          patient: r.encounter.patient,
          encounterId: r.encounterId,
          ...(meta.actorUserId ? { actorUserId: meta.actorUserId } : {}),
          link: {
            purpose: 'RECOVERY',
            encounterId: r.encounterId,
            expiresAt: recoveryLinkExpiry(r.encounter.followUpDate),
          },
          text: (link) =>
            `Namaste ${firstName(r.encounter.patient.name)}. Day ${dayNumber} since your visit to ` +
            `${r.encounter.practitioner.fullName}. How is your pain today? It takes 20 seconds: ${link}\n` +
            `— ${clinic.name}`,
        });

        // Marked sent even when consent stopped it: the schedule has been
        // worked, and re-trying every sweep would only add SKIPPED rows.
        await tx.recoveryCheckin.update({ where: { id: r.id }, data: { sentAt: new Date() } });
        if (status === 'SENT') sent += 1;
      }
      return sent;
    });
  }

  // --- things staff send on purpose -----------------------------------------

  /** "Your review was due" — one tap on the follow-up board. */
  async remindReview(
    tenantId: string,
    encounterId: string,
    meta: EngagementMeta,
  ): Promise<{ status: DeliveryStatus }> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const encounter = await tx.encounter.findUnique({
        where: { id: encounterId },
        select: {
          id: true,
          status: true,
          followUpDate: true,
          practitioner: { select: { fullName: true } },
          patient: { select: { id: true, name: true, mobile: true } },
        },
      });
      if (!encounter || encounter.status !== 'SIGNED') {
        throw new NotFoundException('Consultation not found');
      }
      if (!encounter.followUpDate) {
        throw new ConflictException({
          code: 'NO_REVIEW_DATE',
          message: 'This consultation has no review date to remind them about.',
        });
      }

      const recent = await tx.outboundMessage.findFirst({
        where: {
          encounterId,
          kind: 'REVIEW_REMINDER',
          status: 'SENT',
          createdAt: { gt: new Date(Date.now() - REMINDER_COOLDOWN_HOURS * 3600 * 1000) },
        },
        select: { id: true },
      });
      if (recent) {
        throw new ConflictException({
          code: 'RECENTLY_REMINDED',
          message: 'They were reminded in the last day. Call them instead of sending another.',
        });
      }

      const clinic = await this.clinic(tx, tenantId);
      const today = clinicToday(clinic.timezone);
      const review = encounter.followUpDate.toISOString().slice(0, 10);
      const overdue = review < today;

      const status = await this.deliver(tx, tenantId, {
        kind: 'REVIEW_REMINDER',
        patient: encounter.patient,
        encounterId,
        ...(meta.actorUserId ? { actorUserId: meta.actorUserId } : {}),
        link: null,
        text: () =>
          `Namaste ${firstName(encounter.patient.name)}. ${encounter.practitioner.fullName} ` +
          (overdue
            ? `wanted to see you again on ${formatDateOnly(review)}, and we have not seen you yet. `
            : `will see you again on ${formatDateOnly(review)}. `) +
          `Reply or call us to book a time that suits you.\n— ${clinic.name}`,
      });

      await this.audit.record(tx, tenantId, {
        action: 'followup.remind',
        resourceType: 'Encounter',
        resourceId: encounterId,
        patientId: encounter.patient.id,
        changedFields: [],
        ...meta,
      });

      return { status };
    });
  }

  /**
   * The signed prescription, to the patient's phone — and, when the doctor set
   * check-ins, the link that answers them.
   */
  async sendPrescription(
    tenantId: string,
    encounterId: string,
    meta: EngagementMeta,
  ): Promise<{ status: DeliveryStatus }> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const encounter = await tx.encounter.findUnique({
        where: { id: encounterId },
        select: {
          id: true,
          status: true,
          startedAt: true,
          followUpDate: true,
          checkInIntervalDays: true,
          advice: true,
          practitioner: { select: { fullName: true } },
          patient: { select: { id: true, name: true, mobile: true } },
          prescriptions: {
            orderBy: { displayOrder: 'asc' },
            select: {
              drugName: true,
              strength: true,
              dose: true,
              frequency: true,
              durationDays: true,
              instructions: true,
            },
          },
        },
      });
      if (!encounter) throw new NotFoundException('Consultation not found');
      if (encounter.status !== 'SIGNED') {
        throw new ConflictException({
          code: 'NOT_SIGNED',
          message: 'Sign the consultation before sending the prescription.',
        });
      }

      const clinic = await this.clinic(tx, tenantId);
      const medicines = encounter.prescriptions.map((p, i) =>
        [
          `${i + 1}. ${p.drugName}${p.strength ? ` ${p.strength}` : ''}`,
          p.dose,
          p.frequency,
          p.durationDays ? `${p.durationDays} days` : null,
          p.instructions,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      const review = encounter.followUpDate?.toISOString().slice(0, 10) ?? null;
      const withCheckins = Boolean(review && encounter.checkInIntervalDays);

      const status = await this.deliver(tx, tenantId, {
        kind: 'PRESCRIPTION',
        patient: encounter.patient,
        encounterId,
        ...(meta.actorUserId ? { actorUserId: meta.actorUserId } : {}),
        link: withCheckins
          ? {
              purpose: 'RECOVERY',
              encounterId,
              expiresAt: recoveryLinkExpiry(encounter.followUpDate),
            }
          : null,
        text: (link) =>
          [
            `Namaste ${firstName(encounter.patient.name)}. Your prescription from ` +
              `${encounter.practitioner.fullName}, ${formatDay(encounter.startedAt, clinic.timezone)}:`,
            ...(medicines.length > 0 ? medicines : ['No medicines this time.']),
            encounter.advice ? `Advice: ${encounter.advice}` : null,
            review ? `Next review: ${formatDateOnly(review)}.` : null,
            withCheckins && link
              ? `We will ask how you are every ${encounter.checkInIntervalDays} days. Answer here: ${link}`
              : null,
            `Get well soon.\n— ${clinic.name}`,
          ]
            .filter(Boolean)
            .join('\n'),
      });

      await this.audit.record(tx, tenantId, {
        action: 'encounter.send_to_patient',
        resourceType: 'Encounter',
        resourceId: encounterId,
        patientId: encounter.patient.id,
        changedFields: [],
        ...meta,
      });

      return { status };
    });
  }

  /**
   * Record or withdraw a patient's consent to be messaged.
   *
   * A new row every time, never an update — ConsentRecord is append-only in
   * spirit, because proving what was agreed and when is the point of it.
   */
  async setCommunicationsConsent(
    tenantId: string,
    patientId: string,
    granted: boolean,
    meta: EngagementMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) throw new NotFoundException('Patient not found');

      await tx.consentRecord.create({
        data: {
          tenantId,
          patientId,
          purpose: 'COMMUNICATIONS',
          granted,
          noticeVersion: COMMUNICATIONS_NOTICE_VERSION,
          capturedByUserId: meta.actorUserId ?? null,
        },
      });

      await this.audit.record(tx, tenantId, {
        action: granted ? 'consent.communications.grant' : 'consent.communications.withdraw',
        resourceType: 'Patient',
        resourceId: patientId,
        patientId,
        changedFields: ['consent'],
        ...meta,
      });

      return { patientId, communications: granted };
    });
  }

  /** What was sent to one patient, newest first. Bodies never carry the link. */
  async messagesFor(tenantId: string, patientId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const messages = await tx.outboundMessage.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          kind: true,
          channel: true,
          status: true,
          body: true,
          createdAt: true,
          appointmentId: true,
          encounterId: true,
        },
      });
      const consent = await mayMessage(tx, patientId);
      return { messages, communicationsConsent: consent };
    });
  }

  // --- internals -------------------------------------------------------------

  /**
   * Check consent, mint the link, send, and write the row — in that order and
   * always all of it, so every attempt is on record.
   *
   * Runs inside the caller's transaction. With the console channel that costs
   * nothing; a real provider's network call should move to an outbox worker
   * before it holds a transaction open (docs/10 section 3).
   */
  private async deliver(
    tx: TenantClient,
    tenantId: string,
    input: {
      kind: MessageKind;
      patient: { id: string; name: string; mobile: string };
      appointmentId?: string;
      encounterId?: string;
      actorUserId?: string;
      link:
        | { purpose: 'VISIT'; appointmentId: string; expiresAt: Date }
        | { purpose: 'RECOVERY'; encounterId: string; expiresAt: Date }
        | null;
      text: (link: string) => string;
    },
  ): Promise<DeliveryStatus> {
    const base = {
      tenantId,
      patientId: input.patient.id,
      appointmentId: input.appointmentId ?? null,
      encounterId: input.encounterId ?? null,
      kind: input.kind,
      channel: this.channel.name,
      toMobile: input.patient.mobile,
      createdByUserId: input.actorUserId ?? null,
    };

    if (!(await mayMessage(tx, input.patient.id))) {
      await tx.outboundMessage.create({
        data: { ...base, status: 'SKIPPED_NO_CONSENT', body: input.text(LINK_PLACEHOLDER) },
      });
      return 'SKIPPED_NO_CONSENT';
    }

    let url = LINK_PLACEHOLDER;
    if (input.link) {
      const key = generatePatientLinkKey(tenantId);
      await tx.patientLink.create({
        data: {
          tenantId,
          patientId: input.patient.id,
          purpose: input.link.purpose,
          appointmentId: input.link.purpose === 'VISIT' ? input.link.appointmentId : null,
          encounterId: input.link.purpose === 'RECOVERY' ? input.link.encounterId : null,
          keyHash: hashPatientLinkKey(key),
          expiresAt: input.link.expiresAt,
        },
      });
      url = `${this.webBaseUrl}/p/${key}`;
    }

    try {
      const { providerRef } = await this.channel.send(input.patient.mobile, input.text(url));
      await tx.outboundMessage.create({
        data: { ...base, status: 'SENT', body: input.text(LINK_PLACEHOLDER), providerRef },
      });
      return 'SENT';
    } catch (err) {
      await tx.outboundMessage.create({
        data: {
          ...base,
          status: 'FAILED',
          body: input.text(LINK_PLACEHOLDER),
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        },
      });
      return 'FAILED';
    }
  }

  private async clinic(tx: TenantClient, tenantId: string) {
    return tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, timezone: true },
    });
  }

  private async safely(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const COMMUNICATIONS_NOTICE_VERSION = '2026-09-v1';

/**
 * Whether this patient may be messaged: their LATEST communications decision
 * is a yes that has not been withdrawn. An absent record is a no.
 */
export async function mayMessage(tx: TenantClient, patientId: string): Promise<boolean> {
  const latest = await tx.consentRecord.findFirst({
    where: { patientId, purpose: 'COMMUNICATIONS' },
    orderBy: { grantedAt: 'desc' },
    select: { granted: true, withdrawnAt: true },
  });
  return Boolean(latest?.granted && !latest.withdrawnAt);
}

/** A week after the review, so a patient a little late can still answer. */
function recoveryLinkExpiry(followUpDate: Date | null): Date {
  const base = followUpDate ? followUpDate.getTime() : Date.now() + 30 * 86400000;
  return new Date(base + 7 * 86400000);
}

/** "Ramesh Kumar" → "Ramesh". What a person is called on their own phone. */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function formatDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(instant);
}

function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(instant);
}

function formatDateOnly(date: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
