import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { invoiceSettlement } from '../../billing/billing.service.js';
import { PERMISSIONS } from '../../platform/auth/permissions.js';

/** One thing that happened to this patient, whatever table it came from. */
export interface TimelineEvent {
  /** The source row's id — unique within its kind, enough to key a list. */
  id: string;
  kind:
    | 'REGISTERED'
    | 'APPOINTMENT'
    | 'CONSULTATION'
    | 'TEST'
    | 'DOCUMENT'
    | 'INVOICE'
    | 'PAYMENT'
    | 'CORRECTION';
  at: Date;
  summary: string;
  detail: string | null;
}

export interface PatientBilling {
  outstandingPaise: number;
  invoices: Array<{
    id: string;
    number: string;
    status: string;
    totalPaise: number;
    balancePaise: number;
    createdAt: Date;
  }>;
}

/**
 * The patient record, seen from every direction at once.
 *
 * The detail page used to show demographics, consent and a list of visits. The
 * questions it could not answer were the ones people actually had: does this
 * patient owe us anything, what tests have they had, what happened to them and
 * when. Asked for on 7 Oct 2026, modelled on the Salesforce Customer 360 shape
 * Narveer named — a compact highlights panel, a chronological activity feed,
 * and related lists hanging off the record.
 *
 * Three reads rather than one, matching the tabs, so a receptionist who wants a
 * phone number does not pay for a year of billing history.
 *
 * **Everything here is permission-gated at the source.** A doctor without
 * `invoice:read` does not get payments filtered out of their timeline in the
 * browser — those rows are never selected. The alternative is financial data
 * crossing the wire to a client that has been told not to draw it.
 */
@Injectable()
export class Patient360Service {
  constructor(private readonly prisma: PrismaService) {}

  /** What this patient owes, and the bills it came from. Needs `invoice:read`. */
  async billing(tenantId: string, patientId: string): Promise<PatientBilling> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      await assertPatientExists(tx, patientId);

      const invoices = await tx.invoice.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          number: true,
          status: true,
          totalPaise: true,
          createdAt: true,
          payments: { select: { direction: true, amountPaise: true } },
        },
      });

      let outstandingPaise = 0;

      const rows = invoices.map((invoice) => {
        // The same settlement rule the check-in gate and the day board use, so
        // a patient the desk is told is clear cannot then be blocked at the
        // gate. See `invoiceSettlement`.
        const state = invoiceSettlement(invoice);
        const balancePaise = state.status === 'UNPAID' ? state.balancePaise : 0;
        outstandingPaise += balancePaise;

        return {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          totalPaise: invoice.totalPaise,
          balancePaise,
          createdAt: invoice.createdAt,
        };
      });

      return { outstandingPaise, invoices: rows };
    });
  }

  /** Every test this patient has had. Needs `diagnostic:read`. */
  async diagnostics(tenantId: string, patientId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      await assertPatientExists(tx, patientId);

      const orders = await tx.diagnosticOrder.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          description: true,
          status: true,
          createdAt: true,
          completedAt: true,
          handedOverAt: true,
          resultNote: true,
          referralSource: true,
          referrerName: true,
          department: { select: { name: true } },
          documents: { select: { id: true, fileName: true, contentType: true } },
        },
      });

      return { orders };
    });
  }

  /**
   * Everything that has happened to this patient, newest first.
   *
   * One UNION rather than six queries merged in the application: merging in
   * memory means fetching enough of every source to be sure of the first
   * twenty, which for a patient of five years' standing is most of their
   * history. The database can answer "the twenty most recent things" directly.
   *
   * Keyset paging on `(at, id)` rather than OFFSET — an event arriving while
   * somebody reads page two would otherwise shift a row onto page three and
   * they would never see it.
   */
  async timeline(
    tenantId: string,
    patientId: string,
    user: { permissions: string[] },
    cursor?: { at: Date; id: string },
    limit = 20,
  ): Promise<{ events: TimelineEvent[]; nextCursor: { at: Date; id: string } | null }> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      await assertPatientExists(tx, patientId);

      const may = (p: string) => user.permissions.includes(p);
      const parts: string[] = [];

      // Registration is the one event every reader sees: it is the record
      // coming into existence, and it carries nothing clinical or financial.
      parts.push(`
        SELECT 'REGISTERED' AS kind, p.id::text AS id, p.created_at AS at,
               'Registered' AS summary, p.uhid AS detail
          FROM patient p WHERE p.id = $1::uuid`);

      if (may(PERMISSIONS.APPOINTMENT_READ)) {
        parts.push(`
          SELECT 'APPOINTMENT', a.id::text, a.start_at,
                 CASE a.status
                   WHEN 'CANCELLED' THEN 'Appointment cancelled'
                   WHEN 'NO_SHOW'   THEN 'Did not attend'
                   WHEN 'FULFILLED' THEN 'Visit completed'
                   ELSE 'Appointment booked'
                 END,
                 coalesce(pr.full_name, '') ||
                 coalesce(' · ' || a.reason_for_visit, '')
            FROM appointment a
            LEFT JOIN practitioner pr ON pr.id = a.practitioner_id
           WHERE a.patient_id = $1::uuid`);
      }

      if (may(PERMISSIONS.CONSULTATION_READ)) {
        parts.push(`
          SELECT 'CONSULTATION', e.id::text, e.signed_at,
                 'Consultation signed',
                 (SELECT string_agg(d.display, ', ')
                    FROM diagnosis d WHERE d.encounter_id = e.id)
            FROM encounter e
           WHERE e.patient_id = $1::uuid AND e.signed_at IS NOT NULL`);
      }

      if (may(PERMISSIONS.DIAGNOSTIC_READ)) {
        parts.push(`
          SELECT 'TEST', o.id::text, o.created_at,
                 CASE o.status
                   WHEN 'COMPLETED' THEN 'Test completed'
                   WHEN 'CANCELLED' THEN 'Test cancelled'
                   WHEN 'DECLINED'  THEN 'Test declined by the patient'
                   ELSE 'Test requested'
                 END,
                 o.description || ' · ' || dep.name
            FROM diagnostic_order o
            JOIN department dep ON dep.id = o.department_id
           WHERE o.patient_id = $1::uuid`);
      }

      if (may(PERMISSIONS.DOCUMENT_READ)) {
        parts.push(`
          SELECT 'DOCUMENT', c.id::text, c.created_at,
                 'File added', c.file_name
            FROM clinical_document c
           WHERE c.patient_id = $1::uuid`);
      }

      if (may(PERMISSIONS.INVOICE_READ)) {
        parts.push(`
          SELECT 'INVOICE', i.id::text, i.created_at,
                 'Bill raised', i.number
            FROM invoice i
           WHERE i.patient_id = $1::uuid`);

        parts.push(`
          SELECT 'PAYMENT', pay.id::text, pay.collected_at,
                 CASE pay.direction WHEN 'REFUND' THEN 'Refunded' ELSE 'Payment taken' END,
                 pay.mode::text
            FROM payment pay
            JOIN invoice i2 ON i2.id = pay.invoice_id
           WHERE i2.patient_id = $1::uuid`);
      }

      if (may(PERMISSIONS.AUDIT_READ)) {
        parts.push(`
          SELECT 'CORRECTION', pc.id::text, pc.created_at,
                 'Details corrected', pc.field
            FROM patient_correction pc
           WHERE pc.patient_id = $1::uuid`);
      }

      // One extra row, so "is there more" is answered without a second count.
      const take = limit + 1;
      const keyset = cursor ? `WHERE (at, id) < ($2::timestamptz, $3::text)` : '';
      const params: unknown[] = cursor
        ? [patientId, cursor.at, cursor.id, take]
        : [patientId, take];
      const limitParam = cursor ? '$4' : '$2';

      const rows = await tx.$queryRawUnsafe<
        Array<{
          kind: TimelineEvent['kind'];
          id: string;
          at: Date;
          summary: string;
          detail: string | null;
        }>
      >(
        `SELECT * FROM (${parts.join(' UNION ALL ')}) AS feed
          ${keyset}
          ORDER BY at DESC, id DESC
          LIMIT ${limitParam}`,
        ...params,
      );

      const events = rows.slice(0, limit).map((r) => ({
        ...r,
        // An unsigned consultation or an appointment with no reason yields an
        // empty string from the concatenation above, which is not the same as
        // "nothing to say" to a renderer.
        detail: r.detail?.trim() ? r.detail.trim() : null,
      }));

      const last = events.at(-1);
      const nextCursor = rows.length > limit && last ? { at: last.at, id: last.id } : null;

      return { events, nextCursor };
    });
  }
}

/**
 * The patient exists and belongs to this clinic.
 *
 * Checked before every read here. Without it a caller probing ids would get an
 * empty timeline for somebody else's patient and an empty one for a patient who
 * does not exist — indistinguishable, and the first is a quiet confirmation
 * that the id is real.
 */
async function assertPatientExists(tx: TenantClient, patientId: string): Promise<void> {
  const found = await tx.patient.findUnique({ where: { id: patientId }, select: { id: true } });
  if (!found) throw new NotFoundException('Patient not found');
}
