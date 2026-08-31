import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { RegisterPatientDto } from './dto/register-patient.dto.js';

export interface DuplicateCandidate {
  id: string;
  uhid: string;
  name: string;
  mobile: string;
  gender: string;
  ageYears: number | null;
  birthDate: Date | null;
  createdAt: Date;
  /** Why this row surfaced — shown to the receptionist so the warning is actionable. */
  matchReason: 'SAME_MOBILE' | 'SIMILAR_NAME';
  nameSimilarity: number;
  /**
   * STRONG blocks registration until explicitly confirmed. WEAK is advisory
   * only — shown, never blocking. See findDuplicates for why the distinction
   * matters more than it might appear.
   */
  confidence: 'STRONG' | 'WEAK';
}

export interface PatientSummary {
  id: string;
  uhid: string;
  name: string;
  mobile: string;
  gender: string;
  ageYears: number | null;
  birthDate: Date | null;
  city: string | null;
  abhaNumber: string | null;
  createdAt: Date;
}

/**
 * The whole record, for the patient detail screen.
 *
 * Separate from `PatientSummary` on purpose. A search result is a list row and
 * should stay cheap — widening it would mean every keystroke of a live search
 * pulling addresses, consents and visit history for twenty patients nobody has
 * opened yet.
 */
export interface PatientDetail extends PatientSummary {
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  addressLine: string | null;
  state: string | null;
  postalCode: string | null;
  bloodGroup: string;
  emergencyContactName: string | null;
  emergencyContactMobile: string | null;
  abhaAddress: string | null;
  isActive: boolean;
  updatedAt: Date;
  /** Current decision per purpose — see the note in `detail` on why latest wins. */
  consents: Array<{
    purpose: string;
    granted: boolean;
    noticeVersion: string;
    grantedAt: Date;
    withdrawnAt: Date | null;
  }>;
  appointments: Array<{
    id: string;
    startAt: Date;
    status: string;
    visitType: string;
    source: string;
    tokenNumber: number | null;
    reasonForVisit: string | null;
    practitioner: { id: string; fullName: string; prefix: string | null };
    /** Null when the visit produced no clinical note. */
    encounterId: string | null;
  }>;
  stats: {
    totalVisits: number;
    completedVisits: number;
    lastVisitAt: Date | null;
  };
}

export interface RequestMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  /** From the verified session. Never from the client. */
  actorUserId?: string;
}

/** Below this, names are too different to be worth showing at all. */
const NAME_SIMILARITY_SHOW = 0.4;

/** Name similarity alone is only convincing when it is this close. */
const NAME_SIMILARITY_STRONG = 0.72;

/** Ages within this many years are consistent with being the same person. */
const AGE_TOLERANCE_YEARS = 3;

@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Duplicate detection (FR-P36-03).
   *
   * The hard part is not finding candidates — it is deciding which ones are
   * worth interrupting someone over.
   *
   * Trigram similarity on Indian names produces a lot of surname noise:
   * "Ramesh Kulkarni" and "Radha Kulkarni" score 0.55 while being unrelated
   * people. Blocking on that means the front desk sees a duplicate warning on
   * most registrations, learns it is usually wrong, and clicks through it every
   * time — including the one time it was right. An over-eager check is worse
   * than none, because it trains people to ignore it.
   *
   * So candidates are graded:
   *
   *   STRONG (blocks, must be confirmed)
   *     - same mobile number, or
   *     - very close name AND same gender AND age within a few years
   *
   *   WEAK (shown, never blocks)
   *     - anything else above the display threshold
   *
   * Same mobile is the strongest single signal of a repeat registration. It is
   * not conclusive — families share numbers, particularly for children and
   * elderly parents — which is exactly why it prompts rather than refuses.
   */
  async findDuplicates(
    tenantId: string,
    input: { name: string; mobile: string; gender?: string; ageYears?: number; birthDate?: string },
  ): Promise<DuplicateCandidate[]> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          uhid: string;
          name: string;
          mobile: string;
          gender: string;
          age_years: number | null;
          birth_date: Date | null;
          created_at: Date;
          name_similarity: number;
          same_mobile: boolean;
        }>
      >`
        SELECT id, uhid, name, mobile, gender::text AS gender,
               age_years, birth_date, created_at,
               similarity(name, ${input.name})       AS name_similarity,
               (mobile = ${input.mobile})            AS same_mobile
          FROM patient
         WHERE is_active = true
           AND (mobile = ${input.mobile}
                OR similarity(name, ${input.name}) >= ${NAME_SIMILARITY_SHOW})
         ORDER BY (mobile = ${input.mobile}) DESC, similarity(name, ${input.name}) DESC
         LIMIT 10
      `;

      const incomingAge = ageOf(input.ageYears, input.birthDate);

      return rows.map((r) => {
        const similarity = Number(r.name_similarity);
        const candidateAge = ageOf(r.age_years, r.birth_date);

        const agesAgree =
          incomingAge !== null &&
          candidateAge !== null &&
          Math.abs(incomingAge - candidateAge) <= AGE_TOLERANCE_YEARS;

        const genderAgrees = input.gender !== undefined && input.gender === r.gender;

        const strong =
          r.same_mobile || (similarity >= NAME_SIMILARITY_STRONG && genderAgrees && agesAgree);

        return {
          id: r.id,
          uhid: r.uhid,
          name: r.name,
          mobile: r.mobile,
          gender: r.gender,
          ageYears: r.age_years,
          birthDate: r.birth_date,
          createdAt: r.created_at,
          matchReason: r.same_mobile ? ('SAME_MOBILE' as const) : ('SIMILAR_NAME' as const),
          nameSimilarity: similarity,
          confidence: strong ? ('STRONG' as const) : ('WEAK' as const),
        };
      });
    });
  }

  /**
   * Register a patient (FR-P36-01, -02, -03) with consent capture (FR-CON-01).
   *
   * Everything — UHID allocation, the patient row, consent records and the audit
   * entry — happens in one transaction with tenant context set. A patient that
   * exists without their consent record, or without an audit trail, is a
   * compliance problem rather than merely a bug.
   */
  /**
   * Correct a patient registered earlier — FR-P36-20 to FR-P36-22.
   *
   * Three things worth knowing before changing anything here.
   *
   * **The diff decides what is recorded.** Only fields whose value actually
   * moved produce a `patient_correction` row, so re-saving a form without
   * touching it writes nothing. The database has the same rule as a CHECK.
   *
   * **Date of birth and age are kept from contradicting each other.** Setting a
   * birth date clears any stored age, because an age recorded two years ago
   * beside a newly known birth date is worse than no age at all. Setting an age
   * clears the birth date for the same reason, and registration already treats
   * them as alternatives.
   *
   * **A correction can create a duplicate, and that does not block it.**
   * Changing a mobile to one another patient already has is exactly how two
   * records of the same person are noticed — refusing the correction would leave
   * the clinic with the typo AND the duplicate. Matches are returned as a
   * warning; merging (FR-P36-16) remains the fix.
   */
  async correct(
    tenantId: string,
    patientId: string,
    input: Record<string, unknown>,
    meta: RequestMeta,
  ): Promise<{ patient: PatientSummary; duplicatesWarned: DuplicateCandidate[] }> {
    if (!meta.actorUserId) {
      throw new BadRequestException('A correction must be attributable to a user.');
    }

    return this.prisma.forTenant(tenantId, async (tx) => {
      const before = await tx.patient.findUnique({ where: { id: patientId } });
      if (!before) throw new NotFoundException('Patient not found');

      const data: Record<string, unknown> = {};
      const corrections: Array<{
        field: string;
        oldValue: string | null;
        newValue: string | null;
      }> = [];

      for (const [field, raw] of Object.entries(input)) {
        if (raw === undefined) continue;

        const next = field === 'birthDate' && raw !== null ? new Date(String(raw)) : raw;
        const previous = (before as Record<string, unknown>)[field];

        if (asText(previous) === asText(next)) continue;

        data[field] = next;
        corrections.push({ field, oldValue: asText(previous), newValue: asText(next) });
      }

      // Keep the two age representations from disagreeing. Whichever the caller
      // supplied wins, and the other is cleared.
      if (data['birthDate'] !== undefined && input['ageYears'] === undefined) {
        if (before.ageYears !== null) {
          corrections.push({
            field: 'ageYears',
            oldValue: asText(before.ageYears),
            newValue: null,
          });
        }
        data['ageYears'] = null;
      } else if (data['ageYears'] !== undefined && input['birthDate'] === undefined) {
        if (before.birthDate !== null) {
          corrections.push({
            field: 'birthDate',
            oldValue: asText(before.birthDate),
            newValue: null,
          });
        }
        data['birthDate'] = null;
      }

      if (corrections.length === 0) {
        return { patient: toSummary(before), duplicatesWarned: [] };
      }

      const updated = await tx.patient.update({ where: { id: patientId }, data });

      await tx.patientCorrection.createMany({
        data: corrections.map((c) => ({
          tenantId,
          patientId,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          correctedByUserId: meta.actorUserId as string,
        })),
      });

      await this.audit.record(tx, tenantId, {
        action: 'patient.correct',
        resourceType: 'Patient',
        resourceId: patientId,
        patientId,
        // Names only here, as everywhere. The VALUES live in
        // `patient_correction`, which is the deliberate exception — see that
        // table's migration for why it exists and what it costs.
        changedFields: corrections.map((c) => c.field),
        ...meta,
      });

      const duplicates =
        data['mobile'] !== undefined || data['name'] !== undefined
          ? (
              await this.findDuplicates(tenantId, {
                name: updated.name,
                mobile: updated.mobile,
                gender: updated.gender,
                ...(updated.ageYears !== null ? { ageYears: updated.ageYears } : {}),
              })
            ).filter((d) => d.id !== patientId)
          : [];

      return { patient: toSummary(updated), duplicatesWarned: duplicates };
    });
  }

  /** What this record used to say. Behind `audit:read`. */
  async corrections(tenantId: string, patientId: string) {
    const corrections = await this.prisma.forTenant(tenantId, (tx) =>
      tx.patientCorrection.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          field: true,
          oldValue: true,
          newValue: true,
          createdAt: true,
          correctedBy: { select: { id: true, fullName: true } },
        },
      }),
    );
    return { corrections };
  }

  async register(
    tenantId: string,
    dto: RegisterPatientDto,
    meta: RequestMeta = {},
  ): Promise<{ patient: PatientSummary; duplicatesWarned: DuplicateCandidate[] }> {
    const duplicates = await this.findDuplicates(tenantId, {
      name: dto.name,
      mobile: dto.mobile,
      ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
      ...(dto.ageYears !== undefined ? { ageYears: dto.ageYears } : {}),
      ...(dto.birthDate !== undefined ? { birthDate: dto.birthDate } : {}),
    });

    const strong = duplicates.filter((d) => d.confidence === 'STRONG');

    // Only STRONG matches stop the flow. Weak ones ride along in the response so
    // the UI can show them without standing in the way.
    if (strong.length > 0 && !dto.confirmedNotDuplicate) {
      throw new ConflictException({
        message:
          'Possible duplicate patient. Review the matches, then resubmit with confirmedNotDuplicate.',
        code: 'POSSIBLE_DUPLICATE',
        duplicates: strong,
      });
    }

    return this.prisma.forTenant(tenantId, async (tx) => {
      // Atomic UHID allocation — see next_uhid() in the migration. Doing this as
      // read-then-write in application code hands two simultaneous registrations
      // the same number.
      const uhidRows = await tx.$queryRaw<Array<{ next_uhid: string }>>`
        SELECT next_uhid(${tenantId}::uuid) AS next_uhid
      `;

      const uhid = uhidRows[0]?.next_uhid;
      if (!uhid) {
        // next_uhid() raises on an unknown tenant, so an empty result means the
        // function is missing or the migration did not run. Fail loudly rather
        // than writing a patient with a blank identifier.
        throw new Error('UHID allocation returned no result — is the patient migration applied?');
      }

      const patient = await tx.patient.create({
        data: {
          tenantId,
          uhid,
          name: dto.name,
          gender: dto.gender,
          birthDate: dto.birthDate ? new Date(dto.birthDate) : null,
          ageYears: dto.ageYears ?? null,
          mobile: dto.mobile,
          email: dto.email ?? null,
          addressLine: dto.addressLine ?? null,
          city: dto.city ?? null,
          state: dto.state ?? null,
          postalCode: dto.postalCode ?? null,
          bloodGroup: dto.bloodGroup ?? 'UNKNOWN',
          emergencyContactName: dto.emergencyContactName ?? null,
          emergencyContactMobile: dto.emergencyContactMobile ?? null,
        },
      });

      await this.recordConsents(tx, tenantId, patient.id, dto);

      await this.audit.record(tx, tenantId, {
        action: 'patient.register',
        resourceType: 'Patient',
        resourceId: patient.id,
        patientId: patient.id,
        changedFields: ['uhid', 'name', 'gender', 'mobile'],
        ...meta,
      });

      return { patient: toSummary(patient), duplicatesWarned: duplicates };
    });
  }

  /**
   * Global patient search (FR-P36-05).
   *
   * One box, four things a receptionist might type: UHID, mobile, name, ABHA
   * number. Asking them to pick a field first is how you lose the sub-two-minute
   * registration target.
   */
  async search(tenantId: string, query: string, meta: RequestMeta = {}): Promise<PatientSummary[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const digits = trimmed.replace(/\D/g, '');

    return this.prisma.forTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          uhid: string;
          name: string;
          mobile: string;
          gender: string;
          age_years: number | null;
          birth_date: Date | null;
          city: string | null;
          abha_number: string | null;
          created_at: Date;
        }>
      >`
        SELECT id, uhid, name, mobile, gender::text AS gender,
               age_years, birth_date, city, abha_number, created_at
          FROM patient
         WHERE is_active = true
           AND (
                 uhid ILIKE ${'%' + trimmed + '%'}
              OR (${digits.length >= 4}::boolean AND mobile LIKE ${'%' + digits + '%'})
              OR similarity(name, ${trimmed}) >= 0.3
              OR name ILIKE ${trimmed + '%'}
              OR abha_number = ${trimmed}
           )
         ORDER BY similarity(name, ${trimmed}) DESC, created_at DESC
         LIMIT 25
      `;

      // Searching for a patient is a read of patient-identifiable data, so it is
      // audited. "Who went looking for whom" is a question that gets asked.
      await this.audit.record(tx, tenantId, {
        action: 'patient.search',
        resourceType: 'Patient',
        changedFields: [],
        ...meta,
      });

      return rows.map((r) => ({
        id: r.id,
        uhid: r.uhid,
        name: r.name,
        mobile: r.mobile,
        gender: r.gender,
        ageYears: r.age_years,
        birthDate: r.birth_date,
        city: r.city,
        abhaNumber: r.abha_number,
        createdAt: r.created_at,
      }));
    });
  }

  async findOne(tenantId: string, id: string, meta: RequestMeta = {}): Promise<PatientSummary> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const patient = await tx.patient.findUnique({ where: { id } });

      // RLS makes this a genuine 404 for another tenant's patient, not a 403:
      // the row is simply not visible, and we must not confirm it exists.
      if (!patient) {
        throw new NotFoundException('Patient not found');
      }

      await this.audit.record(tx, tenantId, {
        action: 'patient.view',
        resourceType: 'Patient',
        resourceId: patient.id,
        patientId: patient.id,
        changedFields: [],
        ...meta,
      });

      return toSummary(patient);
    });
  }

  /**
   * The full record for the patient detail screen.
   *
   * One round trip's worth of related data rather than four endpoints the client
   * would have to stitch together: a screen that assembles a patient from four
   * requests shows four different loading states and can render a half-patient
   * if one of them fails.
   *
   * Visits are capped. A patient with a decade of monthly follow-ups would
   * otherwise send several hundred rows to draw a list nobody scrolls; the count
   * in `stats` stays accurate regardless, so the page can say "showing 20 of
   * 137" rather than quietly implying there were only 20.
   */
  async detail(tenantId: string, id: string, meta: RequestMeta = {}): Promise<PatientDetail> {
    const VISIT_LIMIT = 20;

    return this.prisma.forTenant(tenantId, async (tx) => {
      const patient = await tx.patient.findUnique({ where: { id } });

      // RLS makes this a genuine 404 for another tenant's patient, not a 403:
      // the row is simply not visible, and we must not confirm it exists.
      if (!patient) throw new NotFoundException('Patient not found');

      const [consentRows, appointments, totalVisits, completedVisits] = await Promise.all([
        tx.consentRecord.findMany({
          where: { patientId: id },
          orderBy: { grantedAt: 'desc' },
        }),
        tx.appointment.findMany({
          where: { patientId: id },
          orderBy: { startAt: 'desc' },
          take: VISIT_LIMIT,
          select: {
            id: true,
            startAt: true,
            status: true,
            visitType: true,
            source: true,
            tokenNumber: true,
            reasonForVisit: true,
            practitioner: { select: { id: true, fullName: true, prefix: true } },
            encounter: { select: { id: true } },
          },
        }),
        tx.appointment.count({ where: { patientId: id } }),
        tx.appointment.count({ where: { patientId: id, status: 'FULFILLED' } }),
      ]);

      /**
       * Latest decision per purpose.
       *
       * Consent records are append-only — withdrawing writes a new row rather
       * than deleting the old one, because proving what was consented to and
       * when is the entire point. So the CURRENT position is the most recent row
       * for each purpose, and the history stays intact underneath it.
       */
      const latestByPurpose = new Map<string, (typeof consentRows)[number]>();
      for (const row of consentRows) {
        if (!latestByPurpose.has(row.purpose)) latestByPurpose.set(row.purpose, row);
      }

      const lastCompleted = appointments.find((a) => a.status === 'FULFILLED');

      await this.audit.record(tx, tenantId, {
        action: 'patient.view',
        resourceType: 'Patient',
        resourceId: patient.id,
        patientId: patient.id,
        changedFields: [],
        ...meta,
      });

      return {
        ...toSummary(patient),
        givenName: patient.givenName,
        familyName: patient.familyName,
        email: patient.email,
        addressLine: patient.addressLine,
        state: patient.state,
        postalCode: patient.postalCode,
        bloodGroup: patient.bloodGroup,
        emergencyContactName: patient.emergencyContactName,
        emergencyContactMobile: patient.emergencyContactMobile,
        abhaAddress: patient.abhaAddress,
        isActive: patient.isActive,
        updatedAt: patient.updatedAt,

        consents: [...latestByPurpose.values()].map((c) => ({
          purpose: c.purpose,
          granted: c.granted,
          noticeVersion: c.noticeVersion,
          grantedAt: c.grantedAt,
          withdrawnAt: c.withdrawnAt,
        })),

        appointments: appointments.map((a) => ({
          id: a.id,
          startAt: a.startAt,
          status: a.status,
          visitType: a.visitType,
          source: a.source,
          tokenNumber: a.tokenNumber,
          reasonForVisit: a.reasonForVisit,
          practitioner: a.practitioner,
          encounterId: a.encounter?.id ?? null,
        })),

        stats: {
          totalVisits,
          completedVisits,
          lastVisitAt: lastCompleted?.startAt ?? null,
        },
      };
    });
  }

  private async recordConsents(
    tx: TenantClient,
    tenantId: string,
    patientId: string,
    dto: RegisterPatientDto,
  ): Promise<void> {
    const NOTICE_VERSION = '2026-08-v1';

    await tx.consentRecord.create({
      data: {
        tenantId,
        patientId,
        purpose: 'CARE_DELIVERY',
        granted: dto.consentCareDelivery,
        noticeVersion: NOTICE_VERSION,
      },
    });

    // Marketing consent is recorded either way. A recorded "no" is materially
    // different from an absent record: it proves they were asked and declined.
    await tx.consentRecord.create({
      data: {
        tenantId,
        patientId,
        purpose: 'MARKETING',
        granted: dto.consentMarketing ?? false,
        noticeVersion: NOTICE_VERSION,
      },
    });
  }
}

/**
 * Best available age, in years.
 *
 * Patients have a date of birth OR an age, rarely both — a large share of
 * Indian OPD patients simply do not know their DOB. Duplicate matching needs a
 * single comparable number, so derive it from whichever is present.
 */
function ageOf(
  ageYears: number | null | undefined,
  birthDate: Date | string | null | undefined,
): number | null {
  if (ageYears !== null && ageYears !== undefined) return ageYears;
  if (!birthDate) return null;

  const dob = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return null;

  const ms = Date.now() - dob.getTime();
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

function toSummary(p: {
  id: string;
  uhid: string;
  name: string;
  mobile: string;
  gender: string;
  ageYears: number | null;
  birthDate: Date | null;
  city: string | null;
  abhaNumber: string | null;
  createdAt: Date;
}): PatientSummary {
  return {
    id: p.id,
    uhid: p.uhid,
    name: p.name,
    mobile: p.mobile,
    gender: p.gender,
    ageYears: p.ageYears,
    birthDate: p.birthDate,
    city: p.city,
    abhaNumber: p.abhaNumber,
    createdAt: p.createdAt,
  };
}

/**
 * One field's value as text, for comparison and for the history row.
 *
 * Comparison and storage use the same function on purpose: a diff that decided
 * "changed" by one rule and recorded the value by another would eventually
 * record a change that did not happen. Dates are reduced to YYYY-MM-DD because
 * `birth_date` is a DATE and the time half is noise that would make every save
 * look like a correction.
 */
function asText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
