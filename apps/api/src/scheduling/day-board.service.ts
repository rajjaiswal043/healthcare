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

/**
 * Where a patient is in the clinic right now.
 *
 * BACK_FROM_TESTS is the state the clinic had and the software did not. A
 * patient sent for an X-ray stayed AT_DEPARTMENT until the doctor finished
 * them, so the twenty minutes between the film coming back and the doctor
 * seeing it looked identical to the time they were lying under the machine.
 * They are not at the department any more — they are sitting in the corridor
 * holding a film, and nobody was looking for them.
 */
export type DayBucket =
  | 'EXPECTED'
  | 'WAITING'
  | 'WITH_DOCTOR'
  | 'AT_DEPARTMENT'
  | 'BACK_FROM_TESTS'
  /**
   * The doctor has finished and nobody has said the visit is over.
   *
   * FULFILLED and closed are different facts: the first is the clinician's
   * sign-off, the second is the patient leaving. This bucket is the gap
   * between them, and it is the front desk's queue — the people still in the
   * building with nothing clinical left to do.
   */
  | 'READY_TO_CLOSE'
  | 'DONE'
  /**
   * Booked for a day that has since gone, and never checked in.
   *
   * Not a status anybody set: NOTHING in this clinic ever marks a no-show.
   * There is no nightly job, and until 27 Oct 2026 there was no button either,
   * so a missed visit sat at BOOKED for ever and the board said "Expected"
   * about a Tuesday three weeks ago. Reading the date instead fixes every past
   * day at once, including the ones already in the database.
   *
   * Its own bucket rather than folded into NOT_ATTENDING, which is hidden from
   * the default view: a cancellation is something the clinic was told about and
   * has dealt with, while somebody who simply never arrived is a fact the desk
   * still wants to see when it looks back at the day.
   */
  | 'DID_NOT_COME'
  | 'NOT_ATTENDING';

/** Where a bill stands, without saying how much. Null when nothing was charged. */
export type FeeTag = 'PAID' | 'PENDING' | null;

/**
 * What a patient was charged today, and what is still owed.
 *
 * NULL FOR A CALLER WITHOUT `invoice:read`, which is most of the clinical
 * staff. The tags above exist precisely because doctors and nurses read this
 * board and deliberately do not hold that permission — Narveer's decision, 29
 * Sep 2026 — so the figures are left out of the response rather than sent and
 * hidden by the browser. A number omitted from the payload cannot leak.
 */
export interface RowMoney {
  /** Every live bill behind this row. A cancelled one is not a charge. */
  billedPaise: number;
  duePaise: number;
}

/**
 * What this patient needs next, most blocking first.
 *
 * A LIST, NOT ONE STEP, and the reason is a patient sitting with the doctor who
 * has just been sent for an X-ray: the desk's next move is to take the money,
 * the doctor's is to carry on with the consultation. Both are true at once.
 * Each screen shows the FIRST step its user is allowed to perform, so the desk
 * sees Collect, the doctor sees Resume, and somebody holding every permission
 * sees Collect — money first, because an unpaid bill blocks everything after
 * it.
 *
 * Ordering is the patient's journey, with money ahead of each stage it gates:
 * nothing can be checked in while the consultation is unpaid, and no department
 * may start while the test is unpaid. See `blockingReason`.
 *
 * THE LIST IS WHAT IS POSSIBLE, NOT WHAT IS PERMITTED. Every one of these
 * endpoints enforces its own permission; this only decides which button to
 * draw. The single exception is COLLECT, which carries a figure and so is left
 * out entirely for a caller who may not see money — the same rule as `money`.
 */
export type NextStep =
  /**
   * `duePaise` is THIS BILL's balance, not the patient's.
   *
   * A visit with a test on it has two bills, and the row's money column sums
   * both — so a button saying "Collect ₹500" beside a column saying "₹1,000
   * due" read as a contradiction to the desk. `billsOwing` says how many there
   * are, so the browser can write "1 of 2" and the two numbers explain each
   * other instead of disagreeing.
   */
  | { kind: 'COLLECT'; invoiceId: string; duePaise: number; billsOwing: number }
  | { kind: 'CHECK_IN'; appointmentId: string }
  | { kind: 'START'; appointmentId: string }
  | { kind: 'RESUME'; appointmentId: string }
  /** Their tests are back. Put them in the waiting list for the doctor. */
  | { kind: 'BRING_BACK'; appointmentId: string }
  /** Nothing left to do. Say the visit is over. */
  | { kind: 'CLOSE_VISIT'; appointmentId: string }
  /** Closed by mistake. Put it back the way it was. */
  | { kind: 'REOPEN_VISIT'; appointmentId: string }
  | { kind: 'FINISH'; appointmentId: string }
  | { kind: 'RECORD_RESULT'; orderId: string }
  /**
   * The patient said no — usually "not today, I cannot pay for it".
   *
   * Takes the charge off and records that the request stood and the answer was
   * no. Only for an order that HAS a charge: `declineOrder` refuses one without
   * an invoice line, because calling a free-text or legacy order "declined"
   * would put a commercial answer on a clinical record.
   */
  | { kind: 'DECLINE_TEST'; orderId: string }
  /**
   * The same escape hatch where there is no money involved.
   *
   * A free-text order, or one raised before tests were billable, cannot be
   * declined — there is nothing to take off. Withdrawing the request is the
   * only honest verb, and it is a different permission.
   */
  | { kind: 'CANCEL_TEST'; orderId: string }
  /**
   * They never came. Record it.
   *
   * The endpoint and the service transition have existed since the scheduling
   * work; what was missing was anywhere to press. Offered on the day, where it
   * also frees the slot, and on a past row the board has inferred, where it
   * turns that inference into the actual record.
   */
  | { kind: 'MARK_NO_SHOW'; appointmentId: string }
  | { kind: 'RECEIPT'; paymentId: string };

export interface DayBoardRow {
  patient: {
    id: string;
    name: string;
    uhid: string;
    ageYears: number | null;
    gender: string;
  };
  bucket: DayBucket;
  /**
   * The visit this row hangs off, when there is one.
   *
   * Null for a walk-in test patient, who has no appointment at all. Carried so
   * the board can act on the visit — ordering a test from a row needs something
   * to attach it to, and the row itself is keyed on the patient.
   */
  appointmentId: string | null;
  /** What they are here for. Both can be true; neither ever is. */
  hasVisit: boolean;
  hasTest: boolean;
  /**
   * The doctor has finished with them — "OPD done".
   *
   * Independent of whether the visit has been CLOSED: one is the clinician's
   * sign-off, the other is the desk sending them home, and the whole point of
   * the 22 Oct split is that they are different facts. A row can be OPD done
   * and still sitting in the building.
   */
  opdDone: boolean;
  /**
   * The department that finished their tests, once every one is back.
   *
   * Carries the NAME rather than a boolean because the chip says it: "X-ray
   * done", "Pathology done". Null while anything is still pending, and null
   * for a patient with no tests at all.
   */
  testsDoneIn: string | null;
  token: number | null;
  /** The doctor they are booked with, or the department for a test-only visit. */
  withWhom: string | null;
  /**
   * WHAT THEY WERE SENT FOR, and where.
   *
   * `withWhom` names the DOCTOR for anybody who had a consultation, so the
   * department only ever surfaced for a walk-in — a receptionist reading the
   * board could see that somebody was at a department without being told which
   * one, and never what test. The answer lived on a different screen, which is
   * the opposite of a board.
   *
   * Live tests only: a cancelled request and one the patient declined are not
   * things anybody is waiting for. Capped at three, because a row is a line on
   * a board rather than a record.
   */
  tests: string[];
  /** The department holding them. Null when no test is live. */
  testDepartment: string | null;
  /** Clinic-local "HH:mm" of the earliest thing they are here for. */
  time: string | null;
  visitFee: FeeTag;
  testFee: FeeTag;
  /**
   * How they actually paid, today, across every bill of theirs — usually one
   * entry, two when a consultation went on a card and a test was settled in
   * cash. Empty when nothing has been collected yet.
   */
  paymentMethods: string[];
  /** Null without `invoice:read`. See `RowMoney`. */
  money: RowMoney | null;
  /** What to do with this patient next, most blocking first. See `NextStep`. */
  nextSteps: NextStep[];
}

export interface DayBoard {
  date: string;
  timezone: string;
  /** CLINIC for the desk and the administrator; OWN for a doctor. */
  scope: 'CLINIC' | 'OWN';
  counts: Record<Lowercase<DayBucket> | 'total', number>;
  /**
   * The day's money, over every row on the board. Null without `invoice:read`.
   *
   * Summed here rather than in the browser because the browser only ever holds
   * the rows it was sent, and this has to be the day's figure whichever tab is
   * open. `collectedPaise` is derived — billed minus due — so it cannot
   * disagree with the other two.
   */
  money: { billedPaise: number; collectedPaise: number; duePaise: number } | null;
  rows: DayBoardRow[];
}

/** The order a patient moves through the clinic, most current state first. */
const PLACEMENT: DayBucket[] = [
  'WITH_DOCTOR',
  /**
   * Second only to somebody already in the room.
   *
   * A patient whose film is back is the most urgent thing in the building: the
   * clinic has their result, they are sitting outside, and every minute from
   * here is one nobody meant to make them wait. Above AT_DEPARTMENT because a
   * patient with two tests — one back, one still running — is still at the
   * department, and the placement list takes the first match.
   */
  'BACK_FROM_TESTS',
  'AT_DEPARTMENT',
  'WAITING',
  'EXPECTED',
  /**
   * Below everybody still being seen, above the finished.
   *
   * Nothing clinical is owed to these patients, so they must not sit above a
   * queue of people who have not been seen — but they ARE still here, which
   * is what separates them from DONE.
   */
  'READY_TO_CLOSE',
  'DONE',
  /* Below the finished, above the cancelled. They were expected and they are
     not here, which is a different thing from never having been coming. */
  'DID_NOT_COME',
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
          /* FULFILLED says the doctor has finished; this says the visit is
             over. The board needs both to tell "about to leave" from "gone". */
          closedAt: true,
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
          /* What was asked for, in the doctor's own words — "X-ray, left knee
             — AP and lateral" rather than the catalogue's "X-ray, knee". That
             is what the patient will say at the desk. */
          description: true,
          patient: { select: { id: true, name: true, uhid: true, ageYears: true, gender: true } },
          department: { select: { name: true } },
          ...DIAGNOSTIC_BILLING_SELECT,
        },
      });

      /**
       * The figures are read only for somebody allowed to see them.
       *
       * `invoice:read` is the same permission the billing tab and the receipt
       * endpoint sit behind. Without it the tags are still assembled — they
       * come from the orders' own select and from this query's tag half — and
       * the money is dropped before it reaches the response.
       */
      const mayReadMoney = user.permissions.includes('invoice:read');

      const bills = await this.billsForDay(
        tx,
        appointments.map((a) => a.id),
        orders.map((o) => o.id),
      );

      const patientIds = [...new Set([...appointments, ...orders].map((r) => r.patient.id))];
      const paymentMethods = await this.paymentMethods(tx, patientIds, dayStart, dayEnd);

      return this.assemble({
        day,
        tz,
        scope,
        appointments,
        orders,
        visitFees: bills.visitTags,
        money: mayReadMoney ? bills.byPatient : null,
        // Carries a figure, so it follows the same rule as `money`: left out
        // entirely for a caller who may not see amounts.
        unpaid: mayReadMoney ? bills.unpaid : null,
        paymentMethods,
      });
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

  /**
   * Every bill behind today's board: the consultation tag, and the totals.
   *
   * ONE QUERY FOR BOTH, because they read the same invoices. The tag half used
   * to be a query of its own keyed on `appointmentId`; adding a second read for
   * the figures would have asked the same rows the same question twice.
   *
   * A bill reaches today's board three ways, which is why the OR has three
   * arms: `appointmentId` when it IS the consultation bill,
   * `visitAppointmentId` when it is the test bill raised during that visit, and
   * through a LINE when the test was a walk-in and has no appointment anywhere.
   * Missing the third arm would show a walk-in test patient as owing nothing,
   * which is the one row on this board that exists only because money is owed.
   *
   * Summed per PATIENT rather than per invoice, because the board is one row
   * per patient and several orders in one visit share a single test bill — a
   * per-order sum would count that bill once for each test on it.
   */
  private async billsForDay(
    tx: TenantClient,
    appointmentIds: string[],
    orderIds: string[],
  ): Promise<{
    visitTags: Map<string, FeeTag>;
    byPatient: Map<string, RowMoney>;
    unpaid: Map<string, { invoiceId: string; duePaise: number; billsOwing: number }>;
  }> {
    const visitTags = new Map<string, FeeTag>();
    const byPatient = new Map<string, RowMoney>();
    /** The bill Collect opens: the oldest one still owing, and how many there are. */
    const unpaid = new Map<string, { invoiceId: string; duePaise: number; billsOwing: number }>();
    if (appointmentIds.length === 0 && orderIds.length === 0) {
      return { visitTags, byPatient, unpaid };
    }

    const invoices = await tx.invoice.findMany({
      where: {
        OR: [
          ...(appointmentIds.length > 0
            ? [
                { appointmentId: { in: appointmentIds } },
                { visitAppointmentId: { in: appointmentIds } },
              ]
            : []),
          ...(orderIds.length > 0
            ? [{ lines: { some: { diagnosticOrder: { id: { in: orderIds } } } } }]
            : []),
        ],
      },
      // Oldest first, so the bill Collect opens is the one that has been owed
      // longest rather than whichever the planner returned first.
      orderBy: { issuedAt: 'asc' },
      select: {
        id: true,
        patientId: true,
        appointmentId: true,
        number: true,
        status: true,
        totalPaise: true,
        payments: { select: { direction: true, amountPaise: true } },
      },
    });

    for (const invoice of invoices) {
      const state = invoiceSettlement(invoice);

      if (invoice.appointmentId) visitTags.set(invoice.appointmentId, tagFor(state));

      /**
       * A CANCELLED bill is no longer a charge, so it is in neither figure.
       *
       * Its tag stays PENDING — see `tagFor`: somebody has to deal with it —
       * and that pairing is deliberate. "Fee pending" beside a blank amount
       * reads as a bill to sort out, which is what it is. Adding its total to
       * the day would report the clinic as having charged for work it
       * explicitly cancelled.
       */
      if (state.status === 'VOID') continue;

      const money = byPatient.get(invoice.patientId) ?? { billedPaise: 0, duePaise: 0 };
      money.billedPaise += invoice.totalPaise;
      if (state.status === 'UNPAID') {
        money.duePaise += state.balancePaise;
        const owing = unpaid.get(invoice.patientId);
        if (owing) {
          // A second bill on the same patient. The oldest stays the one Collect
          // opens; this only makes the count honest.
          owing.billsOwing += 1;
        } else {
          unpaid.set(invoice.patientId, {
            invoiceId: invoice.id,
            duePaise: state.balancePaise,
            billsOwing: 1,
          });
        }
      }
      byPatient.set(invoice.patientId, money);
    }

    return { visitTags, byPatient, unpaid };
  }

  /**
   * How each patient paid today.
   *
   * Money IN only. A refund carries a mode too, and listing it here would read
   * as a second way the patient paid rather than money going back to them.
   *
   * Keyed on the payment's own date rather than the invoice's: a bill raised
   * yesterday and settled this morning is this morning's cash, which is the
   * answer the desk and the day's collections both want.
   */
  private async paymentMethods(
    tx: TenantClient,
    patientIds: string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, { modes: string[]; lastPaymentId: string | null }>> {
    const byPatient = new Map<string, { modes: string[]; lastPaymentId: string | null }>();
    if (patientIds.length === 0) return byPatient;

    const payments = await tx.payment.findMany({
      where: {
        direction: 'IN',
        collectedAt: { gte: from, lt: to },
        invoice: { patientId: { in: patientIds } },
      },
      /**
       * The id comes too: a receipt prints for the LAST money in, which this
       * ordering makes the last row seen.
       *
       * `receipt` with it, because not every payment has one — money recorded
       * outside `collectPayment`, in a seed or before receipts shipped, has
       * none, and the Receipt button would offer a sheet the server cannot
       * produce.
       */
      select: {
        id: true,
        mode: true,
        receipt: { select: { id: true } },
        invoice: { select: { patientId: true } },
      },
      orderBy: { collectedAt: 'asc' },
    });

    for (const p of payments) {
      const id = p.invoice.patientId;
      const entry = byPatient.get(id) ?? { modes: [], lastPaymentId: null };
      // Distinct, in the order they were taken: "Cash, UPI" reads as a story,
      // "Cash, Cash, UPI" reads as a bug.
      if (!entry.modes.includes(p.mode)) entry.modes.push(p.mode);
      // Only a payment that HAS a receipt can print one.
      if (p.receipt) entry.lastPaymentId = p.id;
      byPatient.set(id, entry);
    }

    return byPatient;
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
      /** Null while the visit is still open. See `bucketForAppointment`. */
      closedAt: Date | null;
      patient: DayBoardRow['patient'];
      practitioner: { fullName: string } | null;
    }>;
    orders: Array<
      {
        id: string;
        status: string;
        createdAt: Date;
        description: string;
        appointmentId: string | null;
        patient: DayBoardRow['patient'];
        department: { name: string };
      } & DiagnosticBillingInput
    >;
    visitFees: Map<string, FeeTag>;
    /** Null when the caller may not see figures. See `RowMoney`. */
    money: Map<string, RowMoney> | null;
    /** The bill Collect opens. Null when the caller may not see figures. */
    unpaid: Map<string, { invoiceId: string; duePaise: number; billsOwing: number }> | null;
    /** `lastPaymentId` is null unless that payment actually has a receipt. */
    paymentMethods: Map<string, { modes: string[]; lastPaymentId: string | null }>;
  }): DayBoard {
    const { day, tz, scope, appointments, orders, visitFees, money, unpaid, paymentMethods } =
      input;

    /**
     * Whether the day being looked at is already over.
     *
     * Compared as text because both sides are `YYYY-MM-DD` in the clinic's own
     * timezone, which orders correctly without going near a Date. Today is not
     * "passed": somebody booked for four o'clock, read at two, has not failed
     * to turn up — they are expected.
     */
    const dayHasPassed = day < clinicToday(tz);

    /** Everything one patient has going on today, gathered before it is judged. */
    interface Accumulator {
      patient: DayBoardRow['patient'];
      buckets: Set<DayBucket>;
      hasVisit: boolean;
      hasTest: boolean;
      appointmentId: string | null;
      token: number | null;
      doctor: string | null;
      department: string | null;
      earliest: Date | null;
      visitFee: FeeTag;
      testFees: FeeTag[];
      /**
       * A test waiting to be done, and whether its bill is clear.
       *
       * The FIRST pending order, because the department works one at a time and
       * the row offers one button. `blocked` mirrors the gate in
       * `blockingReasonForOrder`: an unpaid test cannot be started, so the row
       * must offer the money rather than the work.
       */
      pendingOrderId: string | null;
      pendingOrderBlocked: boolean;
      /**
       * Whether that pending test has a charge on it.
       *
       * Decides which escape hatch the row can offer: decline takes money off
       * and refuses an order with none, so a legacy or free-text test has to
       * be cancelled instead. Without this the board would draw a button the
       * server then refuses, in front of the patient it concerns.
       */
      pendingOrderBilled: boolean;
      /**
       * Whether the live visit is out at a department.
       *
       * Tracked apart from `buckets` because the bucket a patient belongs in
       * depends on TWO facts that arrive from different queries — the visit
       * says "sent out", the orders say "all back" — and a set of buckets can
       * only record that each was seen. BACK_FROM_TESTS is the conjunction.
       */
      visitIsAway: boolean;
      /** At least one test has come back. Distinguishes "back" from "never went". */
      hasCompletedTest: boolean;
      /** What was asked for, in the order it was asked. */
      testDescriptions: string[];
      /** Any live visit the doctor has signed off. */
      visitFulfilled: boolean;
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
          appointmentId: null,
          token: null,
          doctor: null,
          department: null,
          earliest: null,
          visitFee: null,
          testFees: [],
          pendingOrderId: null,
          pendingOrderBlocked: false,
          pendingOrderBilled: false,
          visitIsAway: false,
          hasCompletedTest: false,
          testDescriptions: [],
          visitFulfilled: false,
        };
        byPatient.set(patient.id, row);
      }
      return row;
    };

    for (const a of appointments) {
      const row = open(a.patient);
      row.buckets.add(bucketForAppointment(a.status, a.closedAt, dayHasPassed));

      // CANCELLED and NO_SHOW are not something the patient is here FOR.
      if (a.status !== 'CANCELLED' && a.status !== 'NO_SHOW') {
        row.hasVisit = true;
        if (a.status === 'AWAITING_TESTS') row.visitIsAway = true;
        if (a.status === 'FULFILLED') row.visitFulfilled = true;
        row.doctor ??= a.practitioner?.fullName ?? null;
        // The live visit, not a cancelled one: a test ordered from this row has
        // to attach to the appointment the patient is actually here for.
        row.appointmentId ??= a.id;
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
        if (o.status === 'COMPLETED') row.hasCompletedTest = true;
        row.testDescriptions.push(o.description);
        row.department ??= o.department.name;
        if (!row.earliest || o.createdAt < row.earliest) row.earliest = o.createdAt;

        const state = diagnosticBillingState(o);
        row.testFees.push(tagFor(state));

        if (o.status === 'PENDING' && row.pendingOrderId === null) {
          row.pendingOrderId = o.id;
          // The same two states that stop a result being released.
          row.pendingOrderBlocked = state.status === 'UNPAID' || state.status === 'VOID';
          /* NOT_BILLED and LEGACY are the two states with no invoice line, and
             `declineOrder` refuses both. Everything else has money on it. */
          row.pendingOrderBilled = state.status !== 'NOT_BILLED' && state.status !== 'LEGACY';
        }
      }
    }

    const rows: DayBoardRow[] = [...byPatient.values()]
      .map((r) => {
        // Worked out once. The row's stage and the steps offered against it
        // have to be the same fact — two copies of this expression is two
        // places for them to drift apart.
        /**
         * THE FILM IS IN AND THEY ARE STILL OUT.
         *
         * Added to the set rather than special-cased after the placement run,
         * so one list decides where every patient sits. Requires all three:
         * the visit says they were sent out, something came back, and nothing
         * is still running — a patient with the knee done and the spine still
         * on the machine has not finished at the department.
         */
        if (r.visitIsAway && r.hasCompletedTest && r.pendingOrderId === null) {
          r.buckets.add('BACK_FROM_TESTS');
        }

        const bucket = PLACEMENT.find((b) => r.buckets.has(b)) ?? 'DONE';
        const paid = paymentMethods.get(r.patient.id);

        return {
          patient: r.patient,
          bucket,
          appointmentId: r.appointmentId,
          hasVisit: r.hasVisit,
          hasTest: r.hasTest,
          opdDone: r.visitFulfilled,
          /* Every test back, and there was at least one. A patient still
             waiting on one film has not finished at the department, however
             many others came back. */
          testsDoneIn:
            r.hasTest && r.hasCompletedTest && r.pendingOrderId === null ? r.department : null,
          token: r.token,
          // A patient with a doctor is described by their doctor; a test-only
          // patient by the department holding them.
          withWhom: r.doctor ?? r.department,
          // Three is a glance; the fourth is a list, and a list belongs on the
          // tests page rather than on a row.
          tests: r.testDescriptions.slice(0, 3),
          testDepartment: r.department,
          time: r.earliest ? instantToLocalTime(r.earliest, tz) : null,
          visitFee: r.visitFee,
          // One tag for all their tests: anything outstanding reads as pending,
          // because the desk's question is "is there money to collect", not
          // "which of the three".
          testFee: summariseTestFees(r.testFees),
          paymentMethods: paid?.modes ?? [],
          /**
           * Zeroes rather than null for a patient with no bill, so the column
           * reads as "nothing charged" instead of "not allowed to know". The
           * whole field is null when the caller may not see figures at all.
           */
          money: money ? (money.get(r.patient.id) ?? { billedPaise: 0, duePaise: 0 }) : null,
          nextSteps: stepsFor({
            bucket,
            appointmentId: r.appointmentId,
            owed: unpaid?.get(r.patient.id) ?? null,
            visitFeePending: r.visitFee === 'PENDING',
            pendingOrderId: r.pendingOrderId,
            pendingOrderBlocked: r.pendingOrderBlocked,
            pendingOrderBilled: r.pendingOrderBilled,
            lastPaymentId: paid?.lastPaymentId ?? null,
          }),
        };
      })
      .sort(byTimeThenName);

    const counts = {
      expected: 0,
      waiting: 0,
      with_doctor: 0,
      at_department: 0,
      back_from_tests: 0,
      ready_to_close: 0,
      done: 0,
      did_not_come: 0,
      not_attending: 0,
      total: 0,
    } as DayBoard['counts'];

    for (const row of rows) {
      counts[row.bucket.toLowerCase() as Lowercase<DayBucket>] += 1;
      // The total is everybody the clinic expected to see today, so a
      // cancellation is not one of them. Somebody who never came IS: the slot
      // was held, the day was planned around them, and a day that quietly
      // shrinks when patients fail to arrive cannot be compared with any other.
      if (row.bucket !== 'NOT_ATTENDING') counts.total += 1;
    }

    /**
     * The day's totals, over every row including those not attending.
     *
     * A no-show's consultation bill is still live and still unpaid, and the
     * desk chasing money at six o'clock wants it in the figure. A cancellation
     * normally has its bill cancelled too, which `billsForDay` has already left
     * out.
     */
    const dayMoney = money
      ? rows.reduce(
          (total, row) => ({
            billedPaise: total.billedPaise + (row.money?.billedPaise ?? 0),
            collectedPaise: 0,
            duePaise: total.duePaise + (row.money?.duePaise ?? 0),
          }),
          { billedPaise: 0, collectedPaise: 0, duePaise: 0 },
        )
      : null;
    if (dayMoney) dayMoney.collectedPaise = dayMoney.billedPaise - dayMoney.duePaise;

    return { date: day, timezone: tz, scope, counts, money: dayMoney, rows };
  }
}

/**
 * What this patient needs next, most blocking first.
 *
 * ONE FUNCTION, no permissions in it. Every screen asks the same question and
 * gets the same answer; who may act on which part of it is decided where the
 * buttons are drawn, and enforced again by each endpoint. Mixing the two here
 * would mean the board's idea of "what is going on with this patient" changed
 * depending on who was looking at it.
 *
 * MONEY COMES FIRST, at every stage it gates. An unpaid consultation stops the
 * check-in, an unpaid test stops the department — those are the real rules in
 * `blockingReason` and `blockingReasonForOrder`, and a board that offered Check
 * in on an unpaid visit would be offering a button the server refuses.
 *
 * `owed` is null for a caller who may not see figures, which quietly removes
 * COLLECT for them. That is correct rather than convenient: they could not have
 * collected it anyway.
 */
function stepsFor(row: {
  bucket: DayBucket;
  appointmentId: string | null;
  owed: { invoiceId: string; duePaise: number; billsOwing: number } | null;
  /** This VISIT'S own bill, which is the one the check-in gate reads. */
  visitFeePending: boolean;
  pendingOrderId: string | null;
  pendingOrderBlocked: boolean;
  /** Whether that pending test carries a charge. Decides decline vs cancel. */
  pendingOrderBilled: boolean;
  lastPaymentId: string | null;
}): NextStep[] {
  const steps: NextStep[] = [];

  // Nobody is chasing a cancellation, a no-show, or somebody who never came
  // around the clinic. Their bill may still be owed, so the money step stands
  // and nothing else does.
  const attending = row.bucket !== 'NOT_ATTENDING' && row.bucket !== 'DID_NOT_COME';

  if (row.owed) {
    steps.push({
      kind: 'COLLECT',
      invoiceId: row.owed.invoiceId,
      duePaise: row.owed.duePaise,
      billsOwing: row.owed.billsOwing,
    });
  }

  if (attending && row.appointmentId) {
    /**
     * CHECK IN ONLY WHEN THE VISIT'S OWN BILL IS CLEAR.
     *
     * `blockingReason` refuses a check-in against an unpaid consultation, so
     * offering the button would be offering a refusal. Keyed on the VISIT's
     * fee rather than on anything owed at all, because that is exactly what
     * the gate reads: a patient who owes for something else entirely is not
     * blocked from arriving, and hiding their button would strand the desk.
     */
    if (row.bucket === 'EXPECTED') {
      if (!row.visitFeePending) {
        steps.push({ kind: 'CHECK_IN', appointmentId: row.appointmentId });
      }
    } else if (row.bucket === 'BACK_FROM_TESTS') {
      /**
       * One button, and it is not "finish".
       *
       * The doctor has not seen the result yet. Bringing them back puts them
       * in the waiting list carrying the BACK_FROM_TESTS priority that
       * `returnFromTests` already stamps, so they go in front of people who
       * have not been seen at all rather than to the end of the queue they
       * already waited in once.
       */
      steps.push({ kind: 'BRING_BACK', appointmentId: row.appointmentId });
    } else if (row.bucket === 'DONE') {
      /**
       * The way back, for the row somebody pressed by mistake.
       *
       * Offered on every closed visit rather than only a recent one: a clinic
       * notices at the end of the afternoon, not within thirty seconds. The
       * browser draws it as the quiet button beside the receipt, never as the
       * thing the row is telling you to do — a finished patient is not waiting
       * to be reopened.
       */
      steps.push({ kind: 'REOPEN_VISIT', appointmentId: row.appointmentId });
    } else if (row.bucket === 'READY_TO_CLOSE') {
      /**
       * The last button of the visit.
       *
       * Offered after COLLECT, which `stepsFor` pushes first when money is
       * owed — so the desk is shown the bill before the thing that sends the
       * patient away. Closing with a balance is still allowed; it is a
       * decision somebody makes in front of the patient, not one this board
       * should refuse on their behalf.
       */
      steps.push({ kind: 'CLOSE_VISIT', appointmentId: row.appointmentId });
    } else if (row.bucket === 'WAITING') {
      steps.push({ kind: 'START', appointmentId: row.appointmentId });
    } else if (row.bucket === 'WITH_DOCTOR') {
      steps.push({ kind: 'RESUME', appointmentId: row.appointmentId });
      /**
       * CLOSING THE OPD, from the board.
       *
       * After RESUME, so a doctor's one button stays "open the consultation" —
       * finishing a visit cannot be undone, and it should not be the thing a
       * misplaced click does. The front desk, holding no `consultation:write`,
       * skips RESUME and lands on this: they are who closes visits today.
       *
       * The server only moves IN_PROGRESS to FULFILLED, which is exactly this
       * bucket, so the step is never offered where it would be refused.
       */
      steps.push({ kind: 'FINISH', appointmentId: row.appointmentId });
    }
  }

  // The department's own work, offered only once its bill is clear — the same
  // gate that decides whether the result may be released at all.
  if (attending && row.pendingOrderId && !row.pendingOrderBlocked) {
    steps.push({ kind: 'RECORD_RESULT', orderId: row.pendingOrderId });
  }

  /**
   * THE WAY OUT, for a patient who is not going to have the test.
   *
   * "I cannot pay for it today" was a dead end: a row at a department with an
   * unpaid test offered Collect and nothing else, so the only way to clear it
   * was the finance desk or the consultation screen. The patient is standing
   * at the board, and so is the person who has to answer them.
   *
   * LAST in the list on purpose. It must never become anybody's primary action
   * while there is real work on the row — the browser picks it out explicitly
   * as a secondary, and `firstDoableStep` reaching it means nothing else on
   * this row was doable at all.
   *
   * Which verb depends on the MONEY, not on the role. `declineOrder` refuses
   * an order with no invoice line, so offering Decline there would draw a
   * button the server then refuses.
   */
  if (attending && row.pendingOrderId) {
    steps.push(
      row.pendingOrderBilled
        ? { kind: 'DECLINE_TEST', orderId: row.pendingOrderId }
        : { kind: 'CANCEL_TEST', orderId: row.pendingOrderId },
    );
  }

  /**
   * Record that they never came.
   *
   * Outside the `attending` gate deliberately, because it is the one act that
   * makes sense for a patient who is not here: offered to somebody still
   * expected today, and to a past row the board has already inferred, where it
   * writes the status the inference stands in for.
   *
   * Never the primary action. A patient who is merely late must not be one
   * misplaced click away from being written off, and `NEVER_PRIMARY` in the
   * browser's rule module is what keeps it beside the row rather than on it.
   */
  if (row.appointmentId && (row.bucket === 'EXPECTED' || row.bucket === 'DID_NOT_COME')) {
    steps.push({ kind: 'MARK_NO_SHOW', appointmentId: row.appointmentId });
  }

  /**
   * A receipt, for somebody who has finished and paid.
   *
   * Last, and only on a finished visit: offering it beside a live step would
   * put "print something" in front of "see the patient". It is the one step
   * that still makes sense on a day long past, which is most of the point of
   * being able to look at one.
   *
   * BOTH FINISHED BUCKETS, since FULFILLED split in two. Ready-to-close is
   * where the receipt is most often wanted — the patient is standing at the
   * desk settling up on their way out, which is the moment somebody asks for
   * a printed one. Pushed after CLOSE_VISIT so the step that moves the patient
   * on still comes first.
   */
  if ((row.bucket === 'DONE' || row.bucket === 'READY_TO_CLOSE') && row.lastPaymentId) {
    steps.push({ kind: 'RECEIPT', paymentId: row.lastPaymentId });
  }

  return steps;
}

/**
 * Where one visit puts a patient.
 *
 * FULFILLED SPLITS IN TWO, which is the whole of the 22 Oct change. It used to
 * mean DONE, and that made "the doctor has finished" and "this person has left"
 * the same word on the one screen the front desk uses to tell them apart. A
 * fulfilled visit nobody has closed is still in the building.
 */
function bucketForAppointment(
  status: string,
  closedAt: Date | null,
  dayHasPassed: boolean,
): DayBucket {
  switch (status) {
    case 'BOOKED':
      /* Booked and not checked in. On the day itself that is somebody who has
         not arrived YET. On a day that has gone it is somebody who never came,
         and the board cannot still be expecting them. */
      return dayHasPassed ? 'DID_NOT_COME' : 'EXPECTED';
    case 'ARRIVED':
      return 'WAITING';
    case 'IN_PROGRESS':
      return 'WITH_DOCTOR';
    case 'AWAITING_TESTS':
      return 'AT_DEPARTMENT';
    case 'FULFILLED':
      return closedAt ? 'DONE' : 'READY_TO_CLOSE';
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
