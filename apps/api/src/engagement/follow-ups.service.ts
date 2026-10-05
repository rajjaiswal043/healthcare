import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../platform/database/prisma.service.js';
import { AuditService } from '../platform/audit/audit.service.js';
import { clinicToday } from '../scheduling/clinic-time.js';
import { EngagementService, type EngagementMeta } from './engagement.service.js';

/** A return visit this long after the review date still counts as "came back". */
export const FOLLOW_UP_GRACE_DAYS = 14;

/** How far back an unreturned review stays on the board as overdue. */
const OVERDUE_WINDOW_DAYS = 30;

/** Weeks of return rate on the chart. */
const TREND_WEEKS = 10;

const DAY = 86400000;

type RowStatus = 'FLAGGED' | 'OVERDUE' | 'DUE' | 'BOOKED' | 'CAME_BACK';

const STATUS_ORDER: Record<RowStatus, number> = {
  FLAGGED: 0,
  OVERDUE: 1,
  DUE: 2,
  BOOKED: 3,
  CAME_BACK: 4,
};

/** A visit that counts as the patient having come back. */
const ATTENDED = new Set(['ARRIVED', 'IN_PROGRESS', 'AWAITING_TESTS', 'FULFILLED']);

/**
 * The follow-up board: who the clinic asked to come back, whether they did, and
 * how their recovery is going in between.
 *
 * Everything here is DERIVED from records that already exist — the review date
 * on a signed encounter, later appointments, check-in answers, invoices. There
 * is no "follow-up status" column to fall out of step with them. A patient who
 * books through the front desk without anybody touching this board still shows
 * as booked, because the appointment is what says so.
 */
@Injectable()
export class FollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engagement: EngagementService,
  ) {}

  /**
   * A doctor sees their own patients; everyone else sees the clinic. Same rule,
   * and the same reasoning, as the queue (AppointmentsService.assertMayReadQueue).
   */
  async scopeFor(
    tenantId: string,
    user: { userId: string; permissions: string[] },
  ): Promise<string | null> {
    if (user.permissions.includes('user:manage')) return null;
    const self = await this.prisma.forTenant(tenantId, (tx) =>
      tx.practitioner.findFirst({ where: { userId: user.userId }, select: { id: true } }),
    );
    return self?.id ?? null;
  }

  async board(tenantId: string, opts: { week?: string; practitionerId: string | null }) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const { timezone } = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const today = clinicToday(timezone);
      const todayMs = Date.parse(`${today}T00:00:00Z`);

      const weekStart = mondayOf(
        opts.week && /^\d{4}-\d{2}-\d{2}$/.test(opts.week) ? opts.week : today,
      );
      const weekStartMs = Date.parse(`${weekStart}T00:00:00Z`);
      const weekEndMs = weekStartMs + 6 * DAY;
      const trendStartMs = weekStartMs - (TREND_WEEKS - 1) * 7 * DAY;
      const overdueFromMs = todayMs - OVERDUE_WINDOW_DAYS * DAY;
      const fromMs = Math.min(trendStartMs, overdueFromMs);

      const scope = opts.practitionerId ? { practitionerId: opts.practitionerId } : {};

      const encounters = await tx.encounter.findMany({
        where: {
          status: 'SIGNED',
          ...scope,
          OR: [
            { followUpDate: { gte: new Date(fromMs), lte: new Date(weekEndMs) } },
            { recoveryCheckins: { some: { flaggedAt: { not: null }, flagClearedAt: null } } },
          ],
        },
        select: {
          id: true,
          startedAt: true,
          followUpDate: true,
          checkInIntervalDays: true,
          patient: { select: { id: true, name: true, uhid: true, mobile: true } },
          practitioner: { select: { id: true, fullName: true } },
          appointment: { select: { startAt: true } },
          recoveryCheckins: {
            orderBy: { dueOn: 'asc' },
            select: {
              id: true,
              dueOn: true,
              sentAt: true,
              answeredAt: true,
              painScore: true,
              exercisesDone: true,
              flaggedAt: true,
              flagReason: true,
              flagClearedAt: true,
            },
          },
        },
      });

      const patientIds = [...new Set(encounters.map((e) => e.patient.id))];
      const earliest = encounters.reduce(
        (min, e) => Math.min(min, e.appointment.startAt.getTime()),
        Date.now(),
      );

      const laterVisits = patientIds.length
        ? await tx.appointment.findMany({
            where: {
              patientId: { in: patientIds },
              startAt: { gt: new Date(earliest) },
              status: { notIn: ['CANCELLED', 'NO_SHOW'] },
            },
            orderBy: { startAt: 'asc' },
            select: {
              id: true,
              patientId: true,
              startAt: true,
              status: true,
              invoice: { select: { totalPaise: true, status: true } },
            },
          })
        : [];

      const reminders = encounters.length
        ? await tx.outboundMessage.findMany({
            where: {
              encounterId: { in: encounters.map((e) => e.id) },
              kind: 'REVIEW_REMINDER',
              status: 'SENT',
            },
            orderBy: { createdAt: 'desc' },
            select: { encounterId: true, createdAt: true },
          })
        : [];
      const lastReminder = new Map<string, Date>();
      for (const r of reminders) {
        if (r.encounterId && !lastReminder.has(r.encounterId))
          lastReminder.set(r.encounterId, r.createdAt);
      }

      const rows = encounters.map((e) => {
        const reviewMs = e.followUpDate ? e.followUpDate.getTime() : null;
        const after = laterVisits.filter(
          (v) => v.patientId === e.patient.id && v.startAt > e.appointment.startAt,
        );
        const returned =
          reviewMs === null
            ? undefined
            : after.find(
                (v) =>
                  ATTENDED.has(v.status) &&
                  v.startAt.getTime() < reviewMs + (FOLLOW_UP_GRACE_DAYS + 1) * DAY,
              );
        const booked = after.find((v) => v.status === 'BOOKED' && v.startAt.getTime() >= todayMs);

        const answered = e.recoveryCheckins.filter((c) => c.answeredAt);
        const openFlag = e.recoveryCheckins.find((c) => c.flaggedAt && !c.flagClearedAt) ?? null;
        const missed = e.recoveryCheckins.filter(
          (c) => c.sentAt && !c.answeredAt && c.dueOn.getTime() < todayMs,
        ).length;
        const lastAnswered = answered.at(-1) ?? null;

        let status: RowStatus;
        if (openFlag) status = 'FLAGGED';
        else if (returned) status = 'CAME_BACK';
        else if (booked) status = 'BOOKED';
        else if (reviewMs !== null && reviewMs < todayMs) status = 'OVERDUE';
        else status = 'DUE';

        return {
          encounterId: e.id,
          status,
          reviewDate: e.followUpDate?.toISOString().slice(0, 10) ?? null,
          daysOverdue:
            status === 'OVERDUE' && reviewMs !== null
              ? Math.round((todayMs - reviewMs) / DAY)
              : null,
          visitDate: e.startedAt.toISOString(),
          patient: e.patient,
          practitioner: e.practitioner,
          cameBackAt: returned?.startAt.toISOString() ?? null,
          cameBackStatus: returned ? (returned.status === 'BOOKED' ? null : returned.status) : null,
          valuePaise:
            returned?.invoice && returned.invoice.status !== 'CANCELLED'
              ? returned.invoice.totalPaise
              : 0,
          bookedFor: booked?.startAt.toISOString() ?? null,
          checkins: {
            intervalDays: e.checkInIntervalDays,
            answered: answered.length,
            missed,
            firstPain: answered[0]?.painScore ?? null,
            lastPain: lastAnswered?.painScore ?? null,
            lastAnsweredAt: lastAnswered?.answeredAt?.toISOString() ?? null,
            exercisesDone: answered.filter((c) => c.exercisesDone === true).length,
            exercisesAnswered: answered.filter((c) => c.exercisesDone !== null).length,
          },
          flag: openFlag
            ? {
                checkinId: openFlag.id,
                reason: openFlag.flagReason,
                at: openFlag.flaggedAt?.toISOString() ?? null,
              }
            : null,
          lastRemindedAt: lastReminder.get(e.id)?.toISOString() ?? null,
          _reviewMs: reviewMs,
        };
      });

      const inWeek = (r: (typeof rows)[number]) =>
        r._reviewMs !== null && r._reviewMs >= weekStartMs && r._reviewMs <= weekEndMs;

      const listed = rows
        .filter(
          (r) =>
            r.status === 'FLAGGED' ||
            inWeek(r) ||
            (r.status === 'OVERDUE' && (r._reviewMs ?? 0) >= overdueFromMs),
        )
        .sort(
          (a, b) =>
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
            (a._reviewMs ?? 0) - (b._reviewMs ?? 0),
        );

      const week = rows.filter(inWeek);
      const cameBackThisWeek = week.filter((r) => r.cameBackAt);

      const trend = [];
      for (let i = 0; i < TREND_WEEKS; i++) {
        const start = trendStartMs + i * 7 * DAY;
        const end = start + 6 * DAY;
        const due = rows.filter(
          (r) =>
            r._reviewMs !== null &&
            r._reviewMs >= start &&
            r._reviewMs <= end &&
            r._reviewMs < todayMs,
        );
        const back = due.filter((r) => r.cameBackAt).length;
        trend.push({
          weekStart: new Date(start).toISOString().slice(0, 10),
          due: due.length,
          cameBack: back,
          rate: due.length > 0 ? Math.round((back / due.length) * 100) : null,
        });
      }

      // "Waited from home": of today's visits, how many patients opened their
      // live link. Counted, not assumed from messages sent.
      const todays = await tx.appointment.findMany({
        where: {
          queueDate: new Date(`${today}T00:00:00Z`),
          status: { notIn: ['CANCELLED', 'NO_SHOW'] },
          ...scope,
        },
        select: { id: true, links: { where: { lastSeenAt: { not: null } }, select: { id: true } } },
      });

      return {
        today,
        weekStart,
        weekEnd: new Date(weekEndMs).toISOString().slice(0, 10),
        scopedToPractitionerId: opts.practitionerId,
        stats: {
          dueThisWeek: week.length,
          cameBack: cameBackThisWeek.length,
          booked: week.filter((r) => r.status === 'BOOKED').length,
          overdue: rows.filter((r) => r.status === 'OVERDUE' && (r._reviewMs ?? 0) >= overdueFromMs)
            .length,
          flagged: rows.filter((r) => r.status === 'FLAGGED').length,
          valueKeptPaise: cameBackThisWeek.reduce((sum, r) => sum + r.valuePaise, 0),
          waitedFromHome: {
            opened: todays.filter((a) => a.links.length > 0).length,
            total: todays.length,
          },
        },
        trend,
        rows: listed.map(({ _reviewMs: _unused, ...r }) => r),
      };
    });
  }

  /**
   * Check-ins since the last visit, for the doctor now sitting with the patient.
   *
   * "The last visit" is the most recent SIGNED consultation before this one —
   * its schedule is the one that ran between then and now.
   */
  async recoveryForEncounter(tenantId: string, encounterId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const current = await tx.encounter.findUnique({
        where: { id: encounterId },
        select: { id: true, patientId: true, startedAt: true },
      });
      if (!current) throw new NotFoundException('Consultation not found');

      const previous = await tx.encounter.findFirst({
        where: {
          patientId: current.patientId,
          id: { not: current.id },
          status: 'SIGNED',
          startedAt: { lt: current.startedAt },
        },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          startedAt: true,
          followUpDate: true,
          checkInIntervalDays: true,
          recoveryCheckins: {
            orderBy: { dueOn: 'asc' },
            select: {
              id: true,
              dueOn: true,
              sentAt: true,
              answeredAt: true,
              painScore: true,
              exercisesDone: true,
              note: true,
              flaggedAt: true,
              flagReason: true,
              flagClearedAt: true,
            },
          },
        },
      });

      if (!previous || previous.recoveryCheckins.length === 0) return { recovery: null };

      const answered = previous.recoveryCheckins.filter((c) => c.answeredAt);
      return {
        recovery: {
          sinceEncounterId: previous.id,
          since: previous.startedAt.toISOString(),
          reviewDate: previous.followUpDate?.toISOString().slice(0, 10) ?? null,
          intervalDays: previous.checkInIntervalDays,
          checkins: previous.recoveryCheckins.map((c) => ({
            id: c.id,
            dueOn: c.dueOn.toISOString().slice(0, 10),
            sent: Boolean(c.sentAt),
            answeredAt: c.answeredAt?.toISOString() ?? null,
            painScore: c.painScore,
            exercisesDone: c.exercisesDone,
            note: c.note,
            flagReason: c.flagReason,
            flagOpen: Boolean(c.flaggedAt && !c.flagClearedAt),
          })),
          summary: {
            answered: answered.length,
            missed: previous.recoveryCheckins.filter((c) => c.sentAt && !c.answeredAt).length,
            firstPain: answered[0]?.painScore ?? null,
            lastPain: answered.at(-1)?.painScore ?? null,
            exercisesDone: answered.filter((c) => c.exercisesDone === true).length,
            exercisesAnswered: answered.filter((c) => c.exercisesDone !== null).length,
          },
        },
      };
    });
  }

  /** Somebody called the patient back. The flag stays in the record, cleared, with their name. */
  async clearFlag(tenantId: string, checkinId: string, meta: EngagementMeta) {
    if (!meta.actorUserId) throw new ConflictException('Clearing a flag needs a person.');

    return this.prisma.forTenant(tenantId, async (tx) => {
      const row = await tx.recoveryCheckin.findUnique({
        where: { id: checkinId },
        select: {
          id: true,
          flaggedAt: true,
          flagClearedAt: true,
          patientId: true,
          encounterId: true,
        },
      });
      if (!row) throw new NotFoundException('Check-in not found');
      if (!row.flaggedAt || row.flagClearedAt) {
        throw new ConflictException({ code: 'NOT_FLAGGED', message: 'Nothing to clear here.' });
      }

      await tx.recoveryCheckin.update({
        where: { id: checkinId },
        data: { flagClearedAt: new Date(), flagClearedByUserId: meta.actorUserId as string },
      });

      await this.audit.record(tx, tenantId, {
        action: 'recovery.flag_clear',
        resourceType: 'Encounter',
        resourceId: row.encounterId,
        patientId: row.patientId,
        changedFields: ['flagClearedAt'],
        ...meta,
      });

      return { id: checkinId, cleared: true };
    });
  }

  /**
   * Remind everyone overdue on the board who has not been reminded in the last
   * day. Each goes through `remindReview`, so consent and the cooldown apply
   * exactly as they do to one tap.
   */
  async remindAllOverdue(
    tenantId: string,
    practitionerId: string | null,
    meta: EngagementMeta,
  ): Promise<{ sent: number; skipped: number }> {
    const board = await this.board(tenantId, { practitionerId });
    let sent = 0;
    let skipped = 0;
    for (const row of board.rows.filter((r) => r.status === 'OVERDUE')) {
      try {
        const { status } = await this.engagement.remindReview(tenantId, row.encounterId, meta);
        if (status === 'SENT') sent += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    return { sent, skipped };
  }
}

/** The Monday on or before a date, as YYYY-MM-DD. */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - offset * DAY).toISOString().slice(0, 10);
}
