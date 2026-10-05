'use client';

import type { Encounter } from '@/lib/api';
import { formatAge, genderInitial } from '@/lib/format';
import { ClinicLogo } from './clinic-logo';
import { PrintPortal } from './print-portal';
import { useAuth } from './auth-provider';

/**
 * The printed prescription.
 *
 * Hidden on screen and revealed by the print stylesheet, rather than rendered
 * into a new window. A popup is blocked by default in most browsers, loses the
 * session cookie in some, and means maintaining a second copy of this markup.
 *
 * Rendered through `PrintPortal`, so the sheet is a child of `<body>` and
 * nothing else on the page can print alongside it. This page used to be safe
 * only because it wrapped its own markup in `.no-print` — a convention every
 * future page would have had to remember, and the queue board did not.
 *
 * THE REGISTRATION NUMBER IS NOT DECORATION. The Drugs and Cosmetics Rules
 * require a prescription to carry the prescriber's registration number, so when
 * it is missing the sheet says so in place of printing a document that looks
 * valid and is not. Silently omitting it would be the worst option available:
 * the clinic would not find out until someone refused to dispense.
 */
export function PrescriptionPrint({ encounter }: { encounter: Encounter }) {
  const { patient, practitioner, prescriptions, diagnoses } = encounter;

  // The clinic whose letterhead this is. Taken from the session rather than the
  // encounter: a prescription is printed by somebody signed in to that clinic,
  // and the session is the one place the logo version is already known.
  const { session } = useAuth();
  const clinic = session?.tenant ?? null;

  const issued = encounter.signedAt ?? encounter.startedAt;

  return (
    <PrintPortal>
      <div className="text-ink">
        <header className="flex items-start justify-between border-b-2 border-ink pb-3">
          <div className="flex items-start gap-3">
            {/* The clinic's own mark, falling back to the bundled default for a
              clinic that has not uploaded one. */}
            <ClinicLogo clinic={clinic} size={52} className="mt-0.5 shrink-0" />

            <div>
              {clinic && (
                <p className="font-display text-[15px] font-bold uppercase leading-tight tracking-wide">
                  {clinic.name}
                </p>
              )}
              <p className="font-display text-[20px] font-bold leading-tight">
                {practitioner.fullName}
              </p>
              <p className="text-[12px]">{practitioner.qualification ?? ''}</p>
              {practitioner.specialty && <p className="text-[12px]">{practitioner.specialty}</p>}

              {practitioner.registrationNumber ? (
                <p className="mt-1 text-[11.5px]">Reg. No. {practitioner.registrationNumber}</p>
              ) : (
                <p className="mt-1 border border-black px-1 py-0.5 text-[11.5px] font-bold">
                  REGISTRATION NUMBER MISSING — this prescription is not valid for dispensing. Add
                  it to the doctor&rsquo;s record and print again.
                </p>
              )}
            </div>
          </div>

          <div className="text-right text-[11.5px]">
            <p>{new Date(issued).toLocaleDateString('en-IN', { dateStyle: 'long' })}</p>
            <p>{new Date(issued).toLocaleTimeString('en-IN', { timeStyle: 'short' })}</p>
          </div>
        </header>

        <section className="flex flex-wrap justify-between gap-x-8 gap-y-1 border-b border-ink/40 py-2.5 text-[12.5px]">
          <span>
            <strong>{patient.name}</strong> · {formatAge(patient)} {genderInitial(patient.gender)}
          </span>
          <span>UHID {patient.uhid}</span>
          <span>{patient.mobile}</span>
        </section>

        {diagnoses.length > 0 && (
          <section className="py-2.5 text-[12.5px]">
            <p className="font-bold uppercase tracking-wide">Diagnosis</p>
            <p>
              {diagnoses.map((d) => (d.code ? `${d.display} (${d.code})` : d.display)).join(', ')}
            </p>
          </section>
        )}

        {/* The Rx symbol is what a pharmacist looks for first. */}
        <section className="py-2">
          <p className="font-serif text-[26px] font-bold leading-none">℞</p>

          {prescriptions.length === 0 ? (
            <p className="mt-2 text-[12.5px] italic">No medication prescribed.</p>
          ) : (
            <ol className="mt-2 space-y-2.5">
              {prescriptions.map((p, i) => (
                <li key={p.id ?? i} className="text-[13px]">
                  <p className="font-bold">
                    {i + 1}. {p.drugName}
                    {p.strength ? ` ${p.strength}` : ''}
                    {p.form ? ` (${p.form.toLowerCase()})` : ''}
                  </p>
                  <p className="pl-4">
                    {p.dose} — <span className="font-mono">{p.frequency}</span>
                    {p.durationDays ? ` × ${p.durationDays} days` : ''}
                    {p.quantity ? ` · qty ${p.quantity}` : ''}
                    {p.instructions ? ` · ${p.instructions}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>

        {encounter.advice && (
          <section className="border-t border-ink/40 py-2.5 text-[12.5px]">
            <p className="font-bold uppercase tracking-wide">Advice</p>
            <p className="whitespace-pre-wrap">{encounter.advice}</p>
          </section>
        )}

        {/* FR-CON-11. Below Advice, because advice to the patient is what they act
          on first; this is the detail underneath it. Renders nothing when
          empty — an empty heading on a clinical document reads as something
          omitted rather than something absent. */}
        {/* Tests this centre does not perform (decision (b)).
            Above the pharmacy note and below advice, because it is something
            the patient has to go and DO — and plainly worded, because they
            will hand this sheet to somebody else. */}
        {encounter.appointment.externalTestNote && (
          <section className="border-t border-ink/40 py-2.5 text-[12.5px]">
            <p className="mb-1 font-semibold uppercase tracking-[0.08em]">
              Tests to be done elsewhere
            </p>
            <p className="whitespace-pre-wrap">{encounter.appointment.externalTestNote}</p>
            <p className="mt-1 italic">Not performed at this centre.</p>
          </section>
        )}

        {encounter.prescriptionNote && (
          <section className="border-t border-ink/40 py-2.5 text-[12.5px]">
            <p className="font-bold uppercase tracking-wide">Note</p>
            <p className="whitespace-pre-wrap">{encounter.prescriptionNote}</p>
          </section>
        )}

        {/* The next visit in a box of its own (docs/10). It is the one thing on
            this sheet the patient has to remember, and a line of body text is
            how it got missed. Outlined, not filled, so it survives a mono
            laser. */}
        {encounter.followUpDate && (
          <div className="my-2 inline-block rounded border-[1.5px] border-ink px-3 py-1.5 text-[12.5px]">
            <p className="text-[10px] font-bold uppercase tracking-[0.1em]">Next visit</p>
            <p className="text-[14px] font-bold">
              {new Date(encounter.followUpDate).toLocaleDateString('en-IN', {
                weekday: 'short',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </p>
            {encounter.followUpNote && <p>{encounter.followUpNote}</p>}
            {encounter.checkInIntervalDays && (
              <p className="text-[11px] italic">
                We will check on you on WhatsApp every {encounter.checkInIntervalDays} days until
                then.
              </p>
            )}
          </div>
        )}

        <footer className="mt-10 flex items-end justify-between">
          {/* Our name used to sit here, beside the clinic's own doctor's
            signature, on the clinic's own letterhead. Full white-label took it
            off: the document belongs to the clinic. The draft warning stays —
            it stops an unsigned prescription being dispensed against. */}
          {/* A line from the doctor rather than from the software. Addressed
              by first name, which is how the doctor spoke to them an hour ago. */}
          <p className="text-[12px]">
            {encounter.status === 'SIGNED' ? (
              <span className="font-semibold">
                Get well soon, {encounter.patient.name.trim().split(' ')[0]}.
              </span>
            ) : (
              <span className="text-[10.5px] italic">
                DRAFT — this consultation has not been signed.
              </span>
            )}
          </p>
          <div className="w-56 border-t border-ink pt-1 text-center text-[11px]">
            {practitioner.fullName}
          </div>
        </footer>
      </div>
    </PrintPortal>
  );
}
