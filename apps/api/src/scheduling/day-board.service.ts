import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../platform/database/prisma.service.js';
import {
  DIAGNOSTIC_BILLING_SELECT,
  diagnosticBillingState,
  invoiceSettlement,
  type DiagnosticBillingInput,
} from '../billing/billing.service.js';
import { clinicToday, instantToLocalTime, localToInstant } from './clinic-time.js';

/** Where a patient is in the clinic right now. */
export type DayBucket =
  'EXPECTED' | 'WAITING' | 'WITH_DOCTOR' | 'AT_DEPARTMENT' | 'DONE' | 'NOT_ATTENDING';

/** Money as a tag, never a figure. Null when nothing was charged. */
export type FeeTag = 'PAID' | 'PENDING' | null;

export interface DayBoardRow {
  patient: {
    id: string;
    name: string;
    uhid: string;
    ageYears: number | null;
    gender: string;
  };
  bucket: DayBucket;
  /** What they are here for. Both can be true; neither ever is. */
  hasVisit: boolean;
  hasTest: boolean;
  token: number | null;
  /** The doctor they are booked with, or the department for a test-only visit. */
  withWhom: string | null;
  /** Clinic-local "HH:mm" of the earliest thing they are here for. */
  time: string | null;
  visitFee: FeeTag;
  testFee: FeeTag;
}

export interface DayBoard {
  date: string;
  timezone: string;
  /** CLINIC for the desk and the administrator; OWN for a doctor. */
  scope: 'CLINIC' | 'OWN';
  counts: Record<Lowercase<DayBucket> | 'total', number>;
  rows: DayBoardRow[];
}

/** The order a patient moves through the clinic, most current state first. */
const PLACEMENT: DayBucket[] = [
  'WITH_DOCTOR',
  'AT_DEPARTMENT',
  'WAITING',
  'EXPECTED',
  'DONE',
  'NOT_ATTENDING',
];

/**
 * Everybody in the clinic today, one row per PATIENT.
 *
 * The home screen for the front desk, the doctor and the administrator: five
 * tabs across the patient's journey, and the question "who is still here"
 * answered without opening a doctor's queue one at a time.
 *
 * **One row per patient, not per appointment.** Somebody who sees a doctor and
 * has an X-ray on the same day is one person in the building, not two, and a
 * board that listed them twice would be counted twice in every tab. They get
 * one row carrying both tags. Narveer's decision, 29 Sep 2026.
 *
 * **A walk-in test patient has no appointment at all** — `appointment_id` is
 * nullable since the walk-in diagnostics work — so this reads two tables. A
 * board built on `appointment` alone would show the day emptier than it is, and
 * would miss precisely the people standing in a department corridor.
 *
 * **"Done" means nothing is outstanding.** A patient whose consultation is
 * finished but whose X-ray has not come back is still in the building, so they
 * stay under "At a department" until the report is handed over. Placing them by
 * the furthest-along thing would make people vanish off the board while they
 * are still sitting in it. See `PLACEMENT`.
 */
@Injectable()
export class DayBoardService {
  constructor(private readonly prisma: PrismaService) {}

  async forDay(
    tenantId: string,
    user: { userId: string; permissions: string[] },
    date?: string,
  ): Promise<DayBoard> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const tz = tenant.timezone;
      const day = date ?? clinicToday(tz);

      const ownPractitionerId = await this.confinedTo(tx, user);
      const scope = ownPractitionerId ? 'OWN' : 'CLINIC';

      const dayStart = localToInstant(day, '00:00', tz);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      const queueDate = new Date(`${day}T00:00:00Z`);

      const appointments = await tx.appointment.findMany({
        where: {
          ...(ownPractitionerId ? { practitionerId: ownPractitionerId } : {}),
          // Same two-sided window the queue uses: `queueDate` is the clinic day
          // a visit belongs to, and `startAt` catches anything booked before
          // that column existed.
          OR: [{ queueDate }, { startAt: { gte: dayStart, lt: dayEnd } }],
        },
        select: {
          id: true,
          status: true,
          tokenNumber: true,
          startAt: true,
          patient: { select: { id: true, name: true, uhid: true, ageYears: true, gender: true } },
          practitioner: { select: { fullName: true } },
        },
      });

      const orders = await tx.diagnosticOrder.findMany({
        where: {
          createdAt: { gte: dayStart, lt: dayEnd },
          // A doctor sees the tests raised on their own visits. A walk-in test
          // belongs to no doctor, so it is nobody's own — it appears only on
          // the clinic-wide board.
          ...(ownPractitionerId ? { appointment: { practitionerId: ownPractitionerId } } : {}),
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
          appointmentId: true,
          patient: { select: { id: true, name: true, uhid: true, ageYears: true, gender: true } },
          department: { select: { name: true } },
          ...DIAGNOSTIC_BILLING_SELECT,
        },
      });

      const visitFees = await this.visitFees(
        tx,
        appointments.map((a) => a.id),
      );

      return this.assemble({ day, tz, scope, appointments, orders, visitFees });
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * The practitioner this user is confined to, or null for the whole clinic.
   *
   * The same rule `assertMayReadQueue` applies to the queue, deliberately: a
   * doctor sees their own patients, and the desk, the nurses, finance and the
   * administrator see everyone. A second rule here would drift from that one
   * and the two screens would disagree about who a doctor may look at.
   */
  private async confinedTo(
    tx: TenantClient,
    user: { userId: string; permissions: string[] },
  ): Promise<string | null> {
    if (user.permissions.includes('user:manage')) return null;

    const self = await tx.practitioner.findFirst({
      where: { userId: user.userId },
      select: { id: true },
    });

    return self?.id ?? null;
  }

  /** The consultation bill for each appointment, settled or not. */
  private async visitFees(
    tx: TenantClient,
    appointmentIds: string[],
  ): Promise<Map<string, FeeTag>> {
    const fees = new Map<string, FeeTag>();
    if (appointmentIds.length === 0) return fees;

    const invoices = await tx.invoice.findMany({
      where: { appointmentId: { in: appointmentIds } },
      select: {
        appointmentId: true,
        number: true,
        status: true,
        totalPaise: true,
        payments: { select: { direction: true, amountPaise: true } },
      },
    });

    for (const invoice of invoices) {
      if (!invoice.appointmentId) continue;
      fees.set(invoice.appointmentId, tagFor(invoiceSettlement(invoice)));
    }

    return fees;
  }

  private assemble(input: {
    day: string;
    tz: string;
    scope: 'CLINIC' | 'OWN';
    appointments: Array<{
      id: string;
      status: string;
      tokenNumber: number | null;
      startAt: Date;
      patient: DayBoardRow['patient'];
      practitioner: { fullName: string } | null;
    }>;
    orders: Array<
      {
        status: string;
        createdAt: Date;
        appointmentId: string | null;
        patient: DayBoardRow['patient'];
        department: { name: string };
      } & DiagnosticBillingInput
    >;
    visitFees: Map<string, FeeTag>;
  }): DayBoard {
    const { day, tz, scope, appointments, orders, visitFees } = input;

    /** Everything one patient has going on today, gathered before it is judged. */
    interface Accumulator {
      patient: DayBoardRow['patient'];
      buckets: Set<DayBucket>;
      hasVisit: boolean;
      hasTest: boolean;
      token: number | null;
      doctor: string | null;
      department: string | null;
      earliest: Date | null;
      visitFee: FeeTag;
      testFees: FeeTag[];
    }

    const byPatient = new Map<string, Accumulator>();

    const open = (patient: DayBoardRow['patient']): Accumulator => {
      let row = byPatient.get(patient.id);
      if (!row) {
        row = {
          patient,
          buckets: new Set(),
          hasVisit: false,
          hasTest: false,
          token: null,
          doctor: null,
          department: null,
          earliest: null,
          visitFee: null,
          testFees: [],
        };
        byPatient.set(patient.id, row);
      }
      return row;
    };

    for (const a of appointments) {
      const row = open(a.patient);
      row.buckets.add(bucketForAppointment(a.status));

      // CANCELLED and NO_SHOW are not something the patient is here FOR.
      if (a.status !== 'CANCELLED' && a.status !== 'NO_SHOW') {
        row.hasVisit = true;
        row.doctor ??= a.practitioner?.fullName ?? null;
        row.token ??= a.tokenNumber;
        if (!row.earliest || a.startAt < row.earliest) row.earliest = a.startAt;
        // Only a live visit's bill is worth a tag; a cancelled one is not a
        // debt the front desk should be chasing.
        row.visitFee ??= visitFees.get(a.id) ?? null;
      }
    }

    for (const o of orders) {
      const row = open(o.patient);
      row.buckets.add(bucketForOrder(o.status));

      if (o.status !== 'CANCELLED' && o.status !== 'DECLINED') {
        row.hasTest = true;
        row.department ??= o.department.name;
        if (!row.earliest || o.createdAt < row.earliest) row.earliest = o.createdAt;
        row.testFees.push(tagFor(diagnosticBillingState(o)));
      }
    }

    const rows: DayBoardRow[] = [...byPatient.values()]
      .map((r) => ({
        patient: r.patient,
        bucket: PLACEMENT.find((b) => r.buckets.has(b)) ?? 'DONE',
        hasVisit: r.hasVisit,
        hasTest: r.hasTest,
        token: r.token,
        // A patient with a doctor is described by their doctor; a test-only
        // patient by the department holding them.
        withWhom: r.doctor ?? r.department,
        time: r.earliest ? instantToLocalTime(r.earliest, tz) : null,
        visitFee: r.visitFee,
        // One tag for all their tests: anything outstanding reads as pending,
        // because the desk's question is "is there money to collect", not
        // "which of the three".
        testFee: summariseTestFees(r.testFees),
      }))
      .sort(byTimeThenName);

    const counts = {
      expected: 0,
      waiting: 0,
      with_doctor: 0,
      at_department: 0,
      done: 0,
      not_attending: 0,
      total: 0,
    } as DayBoard['counts'];

    for (const row of rows) {
      counts[row.bucket.toLowerCase() as Lowercase<DayBucket>] += 1;
      // The total is everybody the clinic expected to see today, so a
      // cancellation is not one of them.
      if (row.bucket !== 'NOT_ATTENDING') counts.total += 1;
    }

    return { date: day, timezone: tz, scope, counts, rows };
  }
}

function bucketForAppointment(status: string): DayBucket {
  switch (status) {
    case 'BOOKED':
      return 'EXPECTED';
    case 'ARRIVED':
      return 'WAITING';
    case 'IN_PROGRESS':
      return 'WITH_DOCTOR';
    case 'AWAITING_TESTS':
      return 'AT_DEPARTMENT';
    case 'FULFILLED':
      return 'DONE';
    default:
      return 'NOT_ATTENDING';
  }
}

function bucketForOrder(status: string): DayBucket {
  switch (status) {
    case 'PENDING':
      return 'AT_DEPARTMENT';
    case 'COMPLETED':
      return 'DONE';
    default:
      // CANCELLED by the clinician, DECLINED by the patient. Neither is work
      // anybody is still waiting on.
      return 'NOT_ATTENDING';
  }
}

/**
 * A settlement to a tag.
 *
 * `NOT_BILLED` and `LEGACY` become null rather than "pending": billing is opt-in
 * per clinic, so a clinic that has priced nothing would otherwise open this
 * screen to a wall of "Fee pending" against patients who owe nothing. `VOID` is
 * pending — a cancelled invoice is money that still has to be dealt with.
 */
function tagFor(state: { status: string }): FeeTag {
  if (state.status === 'SETTLED') return 'PAID';
  if (state.status === 'UNPAID' || state.status === 'VOID') return 'PENDING';
  return null;
}

function summariseTestFees(tags: FeeTag[]): FeeTag {
  if (tags.some((t) => t === 'PENDING')) return 'PENDING';
  if (tags.some((t) => t === 'PAID')) return 'PAID';
  return null;
}

function byTimeThenName(a: DayBoardRow, b: DayBoardRow): number {
  if (a.time && b.time && a.time !== b.time) return a.time.localeCompare(b.time);
  if (a.time && !b.time) return -1;
  if (!a.time && b.time) return 1;
  return a.patient.name.localeCompare(b.patient.name);
}
