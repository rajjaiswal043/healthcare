import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type {
  AddendumDto,
  DiagnosisInputDto,
  PrescriptionInputDto,
  RecordVitalsDto,
  UpdateEncounterDto,
} from './dto.js';

export interface RequestMeta {
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
  actorLabel?: string;
}

/**
 * The clinical note.
 *
 * One rule governs this whole file: **a signed encounter is immutable**. Every
 * mutating method routes through `loadDraft`, which refuses anything already
 * signed. That check lives here rather than in the UI because a lock enforced by
 * a disabled button is not a lock — see docs/02-consultation-plan.md section 2.1
 * for why this matters more than the inconvenience it causes.
 *
 * Corrections after signing go to `addAddendum`, which appends. The database
 * grants the application only SELECT and INSERT on that table, so even a bug
 * here cannot rewrite one.
 */
/**
 * Who is asking for a draft encounter.
 *
 * Two standings, because two jobs meet on the same row.
 *
 * `treating-doctor` is the note: the complaint, the diagnoses, the
 * prescriptions, the signature. Those are the clinical judgement of the doctor
 * the patient is booked with, and another doctor holding `consultation:write`
 * is not a reason to let them write it — a permission says what KIND of work
 * someone does, never whose patient it is.
 *
 * `clinical-support` is vitals: height, weight, BP, recorded by whichever nurse
 * is free. Gating those on the practitioner link would break the nurse, who is
 * not a practitioner at all and never will be.
 */
type DraftAccess =
  { as: 'treating-doctor'; userId: string | undefined } | { as: 'clinical-support' };

/**
 * Only the doctor this visit is booked with.
 *
 * The same shape as the gate on a patient's test history, and deliberately so:
 * resolve the caller to a `practitioner` row, and compare it to the one on the
 * record. Absence fails — a user account never linked to a practitioner is not
 * "unrestricted", it is nobody, and treating it as unrestricted is what let a
 * doctor whose Doctors-and-hours setup was never done open any colleague's
 * consultation in the clinic.
 *
 * `user:manage` buys no exemption. An administrator who also consults has a
 * practitioner row and their own patients like any other doctor; one who does
 * not has no clinical business inside somebody's note, and holding every
 * permission in the tenant is exactly the situation this refuses.
 */
async function assertIsTreatingDoctor(
  tx: TenantClient,
  encounterPractitionerId: string,
  userId: string | undefined,
): Promise<void> {
  const self = userId
    ? await tx.practitioner.findFirst({ where: { userId }, select: { id: true } })
    : null;

  if (!self || self.id !== encounterPractitionerId) {
    throw new ForbiddenException(
      'This consultation belongs to another doctor. Only the doctor the patient is booked with can open, write or sign it.',
    );
  }
}

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Open the consultation for an appointment, or resume the draft if one exists.
   *
   * Idempotent by design. `appointment_id` is unique on `encounter`, so a
   * double-click resumes rather than starting a second parallel note — which
   * otherwise leaves two half-written records with no way to tell which is real.
   *
   * Opening for a patient who has arrived also CALLS them in. That is what the
   * act means: the doctor has the patient in the room. Making the doctor press
   * "call" on one screen and "open" on another is bookkeeping the software
   * should be doing.
   */
  async open(tenantId: string, appointmentId: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const appointment = await tx.appointment.findUnique({
        where: { id: appointmentId },
        select: { id: true, status: true, patientId: true, practitionerId: true },
      });
      if (!appointment) throw new NotFoundException('Appointment not found');

      /**
       * Before anything else, including before reporting whether the visit is
       * consultable: a doctor who may not open this note has no business
       * learning its state either.
       *
       * `open` does not go through `loadDraft` — it runs BEFORE an encounter
       * exists — so the check is written here rather than inherited. This is
       * the door the bug report came through: opening also calls the patient
       * in, so a doctor opening a colleague's appointment moved a real patient
       * into a room they were not booked for.
       */
      await assertIsTreatingDoctor(tx, appointment.practitionerId, meta.actorUserId);

      if (appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW') {
        throw new ConflictException({
          code: 'NOT_CONSULTABLE',
          message: `This appointment is ${appointment.status.toLowerCase().replace('_', ' ')}.`,
        });
      }

      const existing = await tx.encounter.findUnique({ where: { appointmentId } });

      // A finished visit can still be OPENED — that is how you read back what was
      // recorded. It just cannot be changed, which every write path enforces.
      if (existing) {
        /**
         * Resuming the note for a patient who is waiting calls them in.
         *
         * This is the second leg of the X-ray round trip: they were sent out,
         * they came back, the desk put them in the queue, and the doctor is now
         * opening the note they started an hour ago. Without this the board
         * would still show them waiting while they sit in the room — and the
         * next patient would never be called, because "now serving" was empty.
         */
        if (appointment.status === 'ARRIVED') {
          await tx.appointment.update({
            where: { id: appointmentId },
            data: { status: 'IN_PROGRESS', calledAt: new Date() },
          });
        }

        return this.view(tx, existing.id);
      }

      if (appointment.status === 'BOOKED') {
        throw new ConflictException({
          code: 'NOT_ARRIVED',
          message: 'Check the patient in before starting the consultation.',
        });
      }

      const created = await tx.encounter.create({
        data: {
          tenantId,
          appointmentId,
          patientId: appointment.patientId,
          practitionerId: appointment.practitionerId,
        },
        select: { id: true },
      });

      if (appointment.status === 'ARRIVED') {
        await tx.appointment.update({
          where: { id: appointmentId },
          data: { status: 'IN_PROGRESS', calledAt: new Date() },
        });
      }

      await this.audit.record(tx, tenantId, {
        action: 'encounter.open',
        resourceType: 'Encounter',
        resourceId: created.id,
        patientId: appointment.patientId,
        changedFields: [],
        ...meta,
      });

      return this.view(tx, created.id);
    });
  }

  async get(tenantId: string, id: string, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const encounter = await this.view(tx, id);

      // Reading a clinical note is itself auditable — FR-P36-19 asks for reads,
      // not only writes, and "who opened this record" is the question that
      // actually gets asked.
      await this.audit.record(tx, tenantId, {
        action: 'encounter.read',
        resourceType: 'Encounter',
        resourceId: id,
        patientId: encounter.patient.id,
        changedFields: [],
        ...meta,
      });

      return encounter;
    });
  }

  async updateNarrative(
    tenantId: string,
    id: string,
    input: UpdateEncounterDto,
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const draft = await this.loadDraft(tx, id, {
        as: 'treating-doctor',
        userId: meta.actorUserId,
      });

      const data = {
        ...defined('chiefComplaint', input.chiefComplaint),
        ...defined('historyOfPresentIllness', input.historyOfPresentIllness),
        ...defined('examinationFindings', input.examinationFindings),
        ...defined('advice', input.advice),
        ...defined('prescriptionNote', input.prescriptionNote),
        ...defined('followUpNote', input.followUpNote),
        ...(input.followUpDate === undefined
          ? {}
          : { followUpDate: input.followUpDate === '' ? null : new Date(input.followUpDate) }),
      };

      await tx.encounter.update({ where: { id }, data });

      await this.audit.record(tx, tenantId, {
        action: 'encounter.update',
        resourceType: 'Encounter',
        resourceId: id,
        patientId: draft.patientId,
        changedFields: Object.keys(data),
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  async recordVitals(tenantId: string, id: string, input: RecordVitalsDto, meta: RequestMeta) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      // Vitals, not the note. A nurse is not a practitioner, so this one
      // cannot ask for the treating doctor — see DraftAccess.
      const draft = await this.loadDraft(tx, id, { as: 'clinical-support' });

      const values = Object.entries(input).filter(([, v]) => v !== undefined && v !== '');
      if (values.length === 0) {
        throw new BadRequestException('Record at least one reading.');
      }

      await tx.vitalsObservation.create({
        data: {
          tenantId,
          encounterId: id,
          patientId: draft.patientId,
          recordedByUserId: meta.actorUserId ?? null,
          ...input,
        },
      });

      await this.audit.record(tx, tenantId, {
        action: 'encounter.vitals',
        resourceType: 'Encounter',
        resourceId: id,
        patientId: draft.patientId,
        changedFields: values.map(([k]) => k),
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /**
   * Replace the diagnosis list.
   *
   * Replace rather than patch: the UI edits a list and saves it, and reconciling
   * a partial update against rows the client may not have seen is a race with no
   * upside on a record only one doctor is editing.
   */
  async setDiagnoses(
    tenantId: string,
    id: string,
    diagnoses: DiagnosisInputDto[],
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const draft = await this.loadDraft(tx, id, {
        as: 'treating-doctor',
        userId: meta.actorUserId,
      });

      /**
       * Exactly one primary: the first entry explicitly marked, or entry zero if
       * none is. Every downstream report groups by it, so leaving it unset just
       * moves the problem, and two silently double-counts.
       *
       * Resolved as an INDEX before the map rather than decided per row. The
       * per-row version read `!taken && (wantsPrimary || index === 0)`, which
       * looks equivalent and is not: promoting the second diagnosis handed the
       * flag straight back to the first, because index 0 claimed it before the
       * loop ever reached the row the doctor had chosen. "Set primary" appeared
       * to do nothing at all.
       */
      const explicit = diagnoses.findIndex((d) => d.isPrimary === true);
      const primaryIndex = explicit >= 0 ? explicit : 0;

      const rows = diagnoses.map((d, index) => ({
        tenantId,
        encounterId: id,
        codeSystem: d.codeSystem ?? 'ICD-10',
        code: d.code ?? null,
        display: d.display,
        isPrimary: index === primaryIndex,
        notes: d.notes ?? null,
      }));

      await tx.diagnosis.deleteMany({ where: { encounterId: id } });
      if (rows.length > 0) await tx.diagnosis.createMany({ data: rows });

      await this.audit.record(tx, tenantId, {
        action: 'encounter.diagnoses',
        resourceType: 'Encounter',
        resourceId: id,
        patientId: draft.patientId,
        changedFields: ['diagnoses'],
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /**
   * Replace the prescription list.
   *
   * A drug the doctor typed rather than picked is added to the tenant's
   * formulary, flagged `isCustom`. That is how the list grows into what the
   * clinic actually prescribes, instead of staying whatever we seeded.
   */
  async setPrescriptions(
    tenantId: string,
    id: string,
    prescriptions: PrescriptionInputDto[],
    meta: RequestMeta,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const draft = await this.loadDraft(tx, id, {
        as: 'treating-doctor',
        userId: meta.actorUserId,
      });

      const rows = [];
      for (const [index, p] of prescriptions.entries()) {
        if (p.durationDays === undefined && p.quantity === undefined) {
          throw new BadRequestException(
            `${p.drugName}: give a duration in days or a quantity, so the pharmacist knows how much.`,
          );
        }

        rows.push({
          tenantId,
          encounterId: id,
          formularyItemId:
            p.formularyItemId ?? (await this.promoteToFormulary(tx, tenantId, p))?.id ?? null,
          // Denormalised on purpose: this must read the same in ten years even if
          // the formulary row is renamed or retired.
          drugName: p.drugName,
          strength: p.strength ?? null,
          form: (p.form ?? null) as never,
          dose: p.dose,
          frequency: p.frequency,
          route: (p.route ?? 'ORAL') as never,
          durationDays: p.durationDays ?? null,
          quantity: p.quantity ?? null,
          instructions: p.instructions ?? null,
          displayOrder: index,
        });
      }

      await tx.prescription.deleteMany({ where: { encounterId: id } });
      if (rows.length > 0) await tx.prescription.createMany({ data: rows });

      await this.audit.record(tx, tenantId, {
        action: 'encounter.prescriptions',
        resourceType: 'Encounter',
        resourceId: id,
        patientId: draft.patientId,
        changedFields: ['prescriptions'],
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /**
   * Sign the note. This is the point of no return.
   *
   * Signing also completes the appointment: the visit is over, and asking the
   * doctor to close it separately is how queues end the day full of patients who
   * were seen an hour ago.
   */
  async sign(tenantId: string, id: string, meta: RequestMeta) {
    // Captured before the closure: the narrowing from the guard does not survive
    // into the callback, and a signature whose author is `undefined` is exactly
    // what the encounter_signature_complete constraint exists to reject.
    const signedByUserId = meta.actorUserId;
    if (!signedByUserId) {
      throw new BadRequestException('A signature needs an author.');
    }

    return this.prisma.forTenant(tenantId, async (tx) => {
      const draft = await this.loadDraft(tx, id, {
        as: 'treating-doctor',
        userId: meta.actorUserId,
      });

      const diagnosisCount = await tx.diagnosis.count({ where: { encounterId: id } });

      // The minimum that makes a note worth keeping. Not a diagnosis — plenty of
      // legitimate visits end without one — but a signed record with nothing in
      // it at all is a row that says a consultation happened and nothing about
      // what did.
      if (!draft.chiefComplaint?.trim() && diagnosisCount === 0) {
        throw new ConflictException({
          code: 'NOTHING_TO_SIGN',
          message: 'Record a complaint or a diagnosis before signing.',
        });
      }

      await tx.encounter.update({
        where: { id },
        data: { status: 'SIGNED', signedAt: new Date(), signedByUserId },
      });

      const appointment = await tx.appointment.findUnique({
        where: { id: draft.appointmentId },
        select: { status: true },
      });

      /**
       * Signing ends the visit, whatever state it was left in.
       *
       * `AWAITING_TESTS` is included deliberately: it is how the doctor closes
       * out a patient who was sent for an X-ray and went home instead. Without
       * it, that visit sits open forever, quietly inflating the day's counts and
       * holding a note nobody can finish. The doctor signs what they have, and
       * anything the report later adds goes in as an addendum.
       */
      if (
        appointment?.status === 'IN_PROGRESS' ||
        appointment?.status === 'ARRIVED' ||
        appointment?.status === 'AWAITING_TESTS'
      ) {
        await tx.appointment.update({
          where: { id: draft.appointmentId },
          data: { status: 'FULFILLED', completedAt: new Date() },
        });
      }

      await this.audit.record(tx, tenantId, {
        action: 'encounter.sign',
        resourceType: 'Encounter',
        resourceId: id,
        patientId: draft.patientId,
        changedFields: ['status', 'signedAt', 'signedByUserId'],
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /** A correction to a signed note. Appended, never merged into the original. */
  async addAddendum(tenantId: string, id: string, input: AddendumDto, meta: RequestMeta) {
    if (!meta.actorUserId) throw new BadRequestException('An addendum needs an author.');

    return this.prisma.forTenant(tenantId, async (tx) => {
      const encounter = await tx.encounter.findUnique({
        where: { id },
        select: { id: true, status: true, patientId: true, practitionerId: true },
      });
      if (!encounter) throw new NotFoundException('Consultation not found');

      // A signed note never passes through `loadDraft`, so this path needs the
      // check spelled out. An addendum is a correction to somebody's clinical
      // record, signed in their name — if anything it is MORE theirs than the
      // draft was.
      await assertIsTreatingDoctor(tx, encounter.practitionerId, meta.actorUserId);

      if (encounter.status !== 'SIGNED') {
        throw new ConflictException({
          code: 'NOT_SIGNED',
          message: 'This consultation is still a draft — edit it directly instead.',
        });
      }

      await tx.encounterAddendum.create({
        data: {
          tenantId,
          encounterId: id,
          text: input.text,
          authorUserId: meta.actorUserId as string,
          // Captured now: the user's name may change, but who wrote this did not.
          authorLabel: meta.actorLabel ?? 'Unknown',
        },
      });

      await this.audit.record(tx, tenantId, {
        action: 'encounter.addendum',
        resourceType: 'Encounter',
        resourceId: id,
        patientId: encounter.patientId,
        changedFields: ['addenda'],
        ...meta,
      });

      return this.view(tx, id);
    });
  }

  /** Past consultations for Patient 360. */
  /**
   * What happened last time, for the doctor sitting in front of the patient now.
   *
   * FR-P36-23, from the orthopaedic clinic demo: the question a doctor asks
   * mid-consultation is "what did I give her last time", and until now answering
   * it meant leaving the consultation and losing the place. So this returns the
   * previous SIGNED visits — not a list of dates, but the things that get acted
   * on: diagnoses, medicines WITH THEIR DOSE, the vitals of the day, and any
   * test results that came back.
   *
   * Signed only. A draft note from a visit somebody abandoned half-written is
   * not history; showing it would put unfinished thinking in front of a doctor
   * as though it were a record.
   *
   * Three, not twenty. This is a panel inside a consultation, and a doctor who
   * needs the fourth visit back is better served by the patient's full record.
   */
  async previousVisits(tenantId: string, encounterId: string, limit = 3) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const current = await tx.encounter.findUnique({
        where: { id: encounterId },
        select: { id: true, patientId: true, startedAt: true },
      });
      if (!current) throw new NotFoundException('Encounter not found');

      const rows = await tx.encounter.findMany({
        where: {
          patientId: current.patientId,
          id: { not: current.id },
          status: 'SIGNED',
          startedAt: { lt: current.startedAt },
        },
        orderBy: { startedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          startedAt: true,
          signedAt: true,
          chiefComplaint: true,
          advice: true,
          prescriptionNote: true,
          practitioner: { select: { id: true, fullName: true } },
          diagnoses: {
            select: { code: true, display: true, isPrimary: true },
            orderBy: { isPrimary: 'desc' },
          },
          // The dose is the point. "3 medicines" is what the Patient 360 list
          // already says, and it is not something a doctor can act on.
          prescriptions: {
            select: {
              drugName: true,
              strength: true,
              form: true,
              dose: true,
              frequency: true,
              durationDays: true,
            },
          },
          vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
          appointment: { select: { id: true } },
        },
      });

      /**
       * Test results, fetched per visit rather than joined.
       *
       * Diagnostic orders hang off the APPOINTMENT, not the encounter, because a
       * patient sent for an X-ray and brought back is one visit with one
       * appointment (docs/05). Three extra queries at most, on a panel that
       * opens once per consultation.
       */
      const visits = [];
      for (const row of rows) {
        const orders = await tx.diagnosticOrder.findMany({
          where: { appointmentId: row.appointment.id, status: 'COMPLETED' },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            description: true,
            resultNote: true,
            department: { select: { name: true } },
            documents: { select: { id: true, fileName: true }, orderBy: { createdAt: 'asc' } },
          },
        });

        const latestVitals = row.vitals[0];

        visits.push({
          id: row.id,
          startedAt: row.startedAt,
          signedAt: row.signedAt,
          chiefComplaint: row.chiefComplaint,
          advice: row.advice,
          prescriptionNote: row.prescriptionNote,
          practitioner: row.practitioner,
          diagnoses: row.diagnoses,
          prescriptions: row.prescriptions,
          vitals: latestVitals ? vitalsView(latestVitals) : null,
          tests: orders,
        });
      }

      return { visits };
    });
  }

  async historyForPatient(tenantId: string, patientId: string, limit = 20) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const rows = await tx.encounter.findMany({
        where: { patientId },
        orderBy: { startedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          status: true,
          startedAt: true,
          signedAt: true,
          chiefComplaint: true,
          practitioner: { select: { id: true, fullName: true, prefix: true } },
          diagnoses: {
            select: { code: true, display: true, isPrimary: true },
            orderBy: { isPrimary: 'desc' },
          },
          _count: { select: { prescriptions: true } },
        },
      });

      return {
        encounters: rows.map((r) => ({
          id: r.id,
          status: r.status,
          startedAt: r.startedAt,
          signedAt: r.signedAt,
          chiefComplaint: r.chiefComplaint,
          practitioner: r.practitioner,
          diagnoses: r.diagnoses,
          prescriptionCount: r._count.prescriptions,
        })),
      };
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * Load an encounter that may still be edited, as somebody in particular.
   *
   * Every mutating method starts here. Centralising it means adding a new write
   * endpoint cannot accidentally omit the check — the only way to get the row is
   * through the function that refuses signed ones.
   *
   * `as` is REQUIRED, and has no default, for the same reason. The note and the
   * vitals on one encounter belong to two different people: the note is the
   * treating doctor's and nobody else's, while vitals are the nurse's job on
   * whoever's patient is in front of them. A single check here would have been
   * wrong for one of them whichever way it was written, and an optional
   * parameter would have let a new endpoint pick the lax one by saying nothing.
   * Naming the caller's standing is now part of asking for the row.
   */
  private async loadDraft(tx: TenantClient, id: string, as: DraftAccess) {
    const encounter = await tx.encounter.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        patientId: true,
        practitionerId: true,
        appointmentId: true,
        chiefComplaint: true,
      },
    });

    if (!encounter) throw new NotFoundException('Consultation not found');

    if (as.as === 'treating-doctor') {
      await assertIsTreatingDoctor(tx, encounter.practitionerId, as.userId);
    }

    if (encounter.status === 'SIGNED') {
      throw new ConflictException({
        code: 'ALREADY_SIGNED',
        message: 'This consultation is signed. Add an addendum to correct it.',
      });
    }

    return encounter;
  }

  /** Add a typed-in drug to the tenant's list, or return the row already there. */
  private async promoteToFormulary(
    tx: TenantClient,
    tenantId: string,
    p: PrescriptionInputDto,
  ): Promise<{ id: string } | null> {
    const name = p.drugName.trim();
    if (name.length === 0) return null;

    // The unique key is (tenant, name, strength), so a drug prescribed at two
    // strengths is two rows — which is how a formulary is actually used.
    const existing = await tx.formularyItem.findFirst({
      where: { name, strength: p.strength ?? null },
      select: { id: true },
    });
    if (existing) return existing;

    return tx.formularyItem.create({
      data: {
        tenantId,
        name,
        strength: p.strength ?? null,
        form: (p.form ?? null) as never,
        isCustom: true,
      },
      select: { id: true },
    });
  }

  /** The whole record, in the shape the consultation screen and print both use. */
  private async view(tx: TenantClient, id: string) {
    const e = await tx.encounter.findUnique({
      where: { id },
      include: {
        patient: {
          select: {
            id: true,
            uhid: true,
            name: true,
            mobile: true,
            gender: true,
            ageYears: true,
            birthDate: true,
            bloodGroup: true,
          },
        },
        practitioner: {
          select: {
            id: true,
            fullName: true,
            prefix: true,
            qualification: true,
            specialty: true,
            registrationNumber: true,
          },
        },
        appointment: {
          select: {
            id: true,
            startAt: true,
            tokenNumber: true,
            status: true,
            visitType: true,
            // Tests this centre does not do, for the printed slip (decision (b)).
            externalTestNote: true,
          },
        },
        vitals: { orderBy: { recordedAt: 'desc' } },
        diagnoses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        prescriptions: { orderBy: { displayOrder: 'asc' } },
        addenda: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!e) throw new NotFoundException('Consultation not found');

    const latest = e.vitals[0] ?? null;

    return {
      id: e.id,
      status: e.status,
      startedAt: e.startedAt,
      signedAt: e.signedAt,
      signedByUserId: e.signedByUserId,
      chiefComplaint: e.chiefComplaint,
      historyOfPresentIllness: e.historyOfPresentIllness,
      examinationFindings: e.examinationFindings,
      advice: e.advice,
      prescriptionNote: e.prescriptionNote,
      followUpDate: e.followUpDate,
      followUpNote: e.followUpNote,
      patient: e.patient,
      practitioner: e.practitioner,
      appointment: e.appointment,
      vitals: e.vitals.map(vitalsView),
      latestVitals: latest ? vitalsView(latest) : null,
      diagnoses: e.diagnoses,
      prescriptions: e.prescriptions,
      addenda: e.addenda,
    };
  }
}

/** Prisma returns Decimal objects; the wire format is a number. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function vitalsView(v: {
  id: string;
  recordedAt: Date;
  recordedByUserId: string | null;
  heightCm: unknown;
  weightKg: unknown;
  systolicMmHg: number | null;
  diastolicMmHg: number | null;
  pulseBpm: number | null;
  temperatureC: unknown;
  spo2Percent: number | null;
  respiratoryRate: number | null;
  notes: string | null;
}) {
  const heightCm = num(v.heightCm);
  const weightKg = num(v.weightKg);

  return {
    id: v.id,
    recordedAt: v.recordedAt,
    recordedByUserId: v.recordedByUserId,
    heightCm,
    weightKg,
    systolicMmHg: v.systolicMmHg,
    diastolicMmHg: v.diastolicMmHg,
    pulseBpm: v.pulseBpm,
    temperatureC: num(v.temperatureC),
    spo2Percent: v.spo2Percent,
    respiratoryRate: v.respiratoryRate,
    notes: v.notes,

    /**
     * Derived here, never stored. A stored BMI disagrees with its own height and
     * weight the moment either is corrected, and then two numbers both claim to
     * be true.
     */
    bmi:
      heightCm && weightKg && heightCm > 0
        ? Math.round((weightKg / (heightCm / 100) ** 2) * 10) / 10
        : null,
  };
}

/** Include a key only when the caller actually sent it. */
function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}
