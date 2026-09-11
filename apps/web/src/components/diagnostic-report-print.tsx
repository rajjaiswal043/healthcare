'use client';

import type { ClinicalDocument, DiagnosticOrder } from '@/lib/api';
import { genderInitial } from '@/lib/format';
import { ClinicLogo } from './clinic-logo';
import { PrintPortal } from './print-portal';
import { useAuth } from './auth-provider';

/**
 * The printed diagnostic report (FR-DIA-13).
 *
 * The document a walk-in patient takes away. Until now nothing printed a test
 * result at all: a doctor-ordered film ends up on a consultation screen, and
 * that was the only place a result had to go. A patient who paid for a chest
 * X-ray and never saw a doctor leaves with nothing unless this sheet exists.
 *
 * Same construction as the prescription and the receipt — hidden markup
 * revealed by the print stylesheet, through `PrintPortal` so nothing else on
 * the page prints alongside it. No popup: blocked by default in most browsers,
 * loses the session cookie in some, and means a second copy of this markup.
 *
 * Everything here is already on screen when the button is pressed, so there is
 * no fetch and nothing to log. The record that matters — that the patient was
 * actually handed this — is the handover, which is its own act and its own
 * columns. Printing a sheet is not the same as giving it to somebody.
 */
export function DiagnosticReportPrint({
  order,
  documents,
}: {
  order: DiagnosticOrder;
  documents: ClinicalDocument[];
}) {
  const { session } = useAuth();
  const clinic = session?.tenant ?? null;

  const { patient } = order;
  const reportedAt = order.completedAt ?? order.createdAt;

  /**
   * Whose question this answers.
   *
   * Indian practice addresses the report back to the doctor who sent the
   * patient, by name (FR-DIA-14) — and for a walk-in there may be no doctor at
   * all, which the sheet says rather than leaving a blank line.
   */
  const referredBy =
    order.referralSource === 'EXTERNAL_DOCTOR'
      ? [order.referrerName, order.referrerClinic].filter(Boolean).join(', ')
      : order.referralSource === 'SELF'
        ? 'Patient, self-referred'
        : null;

  return (
    <PrintPortal>
      <div className="text-ink">
        <header className="flex items-start justify-between border-b-2 border-ink pb-3">
          <div className="flex items-start gap-3">
            <ClinicLogo clinic={clinic} size={52} className="mt-0.5 shrink-0" />
            <div>
              {clinic && (
                <p className="font-display text-[15px] font-bold uppercase leading-tight tracking-wide">
                  {clinic.name}
                </p>
              )}
              <p className="font-display text-[20px] font-bold leading-tight">Diagnostic report</p>
              <p className="text-[12px]">{order.department.name}</p>
            </div>
          </div>

          <div className="text-right text-[11.5px]">
            <p>{new Date(reportedAt).toLocaleDateString('en-IN', { dateStyle: 'long' })}</p>
            <p>{new Date(reportedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}</p>
          </div>
        </header>

        <section className="flex flex-wrap justify-between gap-x-8 gap-y-1 border-b border-ink/40 py-2.5 text-[12.5px]">
          <span>
            <strong>{patient.name}</strong>
            {patient.ageYears !== null ? ` · ${patient.ageYears}y` : ''}{' '}
            {genderInitial(patient.gender)}
          </span>
          <span>UHID {patient.uhid}</span>
        </section>

        {referredBy && (
          <section className="border-b border-ink/40 py-2.5 text-[12.5px]">
            <span className="mr-2 font-semibold uppercase tracking-[0.08em]">Referred by</span>
            {referredBy}
            {order.referrerPhone ? ` · ${order.referrerPhone}` : ''}
          </section>
        )}

        <section className="py-2.5">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em]">Test</p>
          <p className="font-display text-[16px] font-bold">{order.description}</p>
        </section>

        <section className="border-t border-ink/40 py-2.5">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em]">Findings</p>
          {order.resultNote ? (
            <p className="whitespace-pre-wrap text-[13px]">{order.resultNote}</p>
          ) : (
            <p className="text-[13px] italic">
              Reported by image only — see the films listed below.
            </p>
          )}
        </section>

        {/* Named, not attached. The films do not come out of a printer, and a
            patient handed a sheet listing two images knows to ask for two. */}
        {documents.length > 0 && (
          <section className="border-t border-ink/40 py-2.5 text-[12.5px]">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em]">
              Images and files issued
            </p>
            <ol className="list-inside list-decimal">
              {documents.map((d) => (
                <li key={d.id}>{d.fileName}</li>
              ))}
            </ol>
          </section>
        )}

        {/*
          FR-DIA decision 3, 11 Sep 2026.

          On a self-referred or externally referred report only, and that is
          deliberate rather than an omission. Nobody here interprets a test the
          patient asked for: the clinic sold a film and a technical report, and
          the patient may well read it as a diagnosis. On a test OUR OWN doctor
          ordered the sentence would be false — they are about to read it — and
          a false statement on a clinical document is worse than none.

          Fixed in the template, with no toggle: it is not a judgement the
          person at the counter should be making one report at a time.
        */}
        {order.referralSource !== 'INTERNAL' && (
          <section className="mt-3 border border-ink px-3 py-2 text-[11.5px]">
            <p className="font-bold uppercase tracking-[0.06em]">Please read</p>
            <p className="mt-0.5">
              No clinician at this centre has reviewed or interpreted this result. This is a
              technical report of the test performed, not a diagnosis. Please show it to a doctor.
            </p>
          </section>
        )}

        <footer className="mt-10 flex items-end justify-between">
          <p className="text-[10.5px] italic">
            {order.status === 'COMPLETED' ? '' : 'DRAFT — this test has not been reported.'}
          </p>
          <div className="w-56 border-t border-ink pt-1 text-center text-[11px]">
            {order.completedBy?.fullName ?? order.department.name}
          </div>
        </footer>
      </div>
    </PrintPortal>
  );
}
