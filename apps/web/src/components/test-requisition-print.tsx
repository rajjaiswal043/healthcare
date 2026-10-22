'use client';

import type { DiagnosticOrder } from '@/lib/api';
import { formatAge, formatPaise, genderInitial } from '@/lib/format';
import { ClinicLogo } from './clinic-logo';
import { PrintPortal } from './print-portal';
import { useAuth } from './auth-provider';

/**
 * The slip a patient carries to the department.
 *
 * WHAT IT IS FOR. Three people read this sheet and each needs a different line
 * off it: the patient, who is being sent somewhere and told what it costs; the
 * desk, which takes the money before the test is done; and the department,
 * which has to know exactly what was asked for. Before this existed the test
 * travelled in the patient's head between the consulting room and the X-ray
 * door, and "the doctor said something about my knee" is not a requisition.
 *
 * THE DESCRIPTION IS THE POINT, not the catalogue name. "X-ray, knee" is what
 * the clinic prices; "X-ray, left knee — AP and lateral" is what the
 * radiographer needs, and printing the first where the second was meant is how
 * the wrong knee gets filmed.
 *
 * THE AMOUNT IS WHAT WAS CHARGED, not the list price. An order priced by hand
 * at the moment of sending — a repeat film, a concession — must print the
 * number the patient will actually be asked for at the desk, or the slip starts
 * an argument it was meant to prevent.
 *
 * NOT A RECEIPT, and it says so. A receipt is a financial document with a
 * serial number from its own counter; this is a request. Money has been added
 * to the bill, not taken.
 *
 * Rendered through `PrintPortal` for the same reason as the prescription: the
 * sheet becomes a sibling of the app rather than a descendant, so printing it
 * cannot drag the dialog it was opened from onto the page.
 */
export function TestRequisitionPrint({ order }: { order: DiagnosticOrder }) {
  // The clinic whose letterhead this is, from the session rather than the order:
  // a slip is printed by somebody signed in to that clinic, and the session is
  // where the logo version already is.
  const { session } = useAuth();
  const clinic = session?.tenant ?? null;

  const { patient, department } = order;
  const raised = new Date(order.createdAt);

  /**
   * Who sent them, in the words the department cares about.
   *
   * An internal order names the clinic's own doctor; an outside referral names
   * the doctor who wrote it, because that is who the report goes back to. A
   * self-referred walk-in names nobody, and saying "self" is more honest than
   * printing the clerk who keyed it in as though they had ordered the test.
   */
  const referredBy =
    order.referralSource === 'EXTERNAL_DOCTOR'
      ? [order.referrerName, order.referrerClinic].filter(Boolean).join(', ')
      : order.referralSource === 'SELF'
        ? 'Self-referred'
        : order.orderedBy.fullName;

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
              <p className="font-display text-[20px] font-bold leading-tight">Test requisition</p>
              <p className="text-[12px]">Referred by {referredBy}</p>
            </div>
          </div>

          <div className="text-right text-[11.5px]">
            <p>{raised.toLocaleDateString('en-IN', { dateStyle: 'long' })}</p>
            <p>{raised.toLocaleTimeString('en-IN', { timeStyle: 'short' })}</p>
            {/* The token is how the desk and the department find this visit on
                their own screens. Absent on a walk-in, which has no visit. */}
            {order.appointment?.tokenNumber != null && (
              <p className="mt-1 font-bold">Token {order.appointment.tokenNumber}</p>
            )}
          </div>
        </header>

        <section className="flex flex-wrap justify-between gap-x-8 gap-y-1 border-b border-ink/40 py-2.5 text-[12.5px]">
          <span>
            <strong>{patient.name}</strong> ·{' '}
            {/* The order carries the age already worked out and no birth date,
                so the second argument is genuinely absent rather than unknown. */}
            {formatAge({ ageYears: patient.ageYears, birthDate: null })}{' '}
            {genderInitial(patient.gender)}
          </span>
          <span>UHID {patient.uhid}</span>
          <span>{patient.mobile}</span>
        </section>

        <section className="py-3">
          <p className="text-[11.5px] font-bold uppercase tracking-[0.08em]">
            Please report to {department.name}
          </p>

          <div className="mt-2 flex items-start justify-between gap-6 border-y border-ink/40 py-3">
            <div className="min-w-0">
              {/* What was actually asked for. The catalogue name sits under it
                  rather than replacing it — the department bills against the
                  code and reads the description. */}
              <p className="text-[15px] font-bold leading-snug">{order.description}</p>
              {order.service && (
                <p className="mt-0.5 text-[11.5px]">
                  {order.service.name} · <span className="font-mono">{order.service.code}</span>
                </p>
              )}
            </div>

            {order.chargedPaise !== null && (
              <p className="shrink-0 font-mono text-[17px] font-bold tabular-nums">
                {formatPaise(order.chargedPaise)}
              </p>
            )}
          </div>

          {/* The one instruction that changes what happens next. The result is
              withheld until the charge clears, so a patient who walks to the
              department first is walking to a locked door. */}
          <p className="mt-3 text-[12.5px]">
            {order.chargedPaise === null
              ? 'No charge has been raised for this test.'
              : 'Payable at the desk. The department cannot release the result until it is paid.'}
          </p>

          {/* Asked for the radiographer about to give contrast, so it is on the
              sheet that reaches them. Only when there is something to say:
              "Allergies: —" invites nobody to ask. */}
          {patient.allergies && (
            <p className="mt-2 border border-ink px-2 py-1 text-[12px] font-bold">
              Allergies: {patient.allergies}
            </p>
          )}
        </section>

        <footer className="mt-8 flex items-end justify-between border-t border-ink/40 pt-2 text-[11px]">
          <span>This is a request for a test, not a receipt.</span>
          <span className="font-mono">{order.id.slice(0, 8).toUpperCase()}</span>
        </footer>
      </div>
    </PrintPortal>
  );
}
