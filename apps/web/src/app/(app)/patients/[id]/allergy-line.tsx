import { IconAlert, IconCheck } from '@/components/icons';

/**
 * Allergies, in the highlights panel, above everything else about this patient.
 *
 * Three states, because a blank allergy field means two completely different
 * things and the failure is one-directional — a patient nobody asked, read as
 * "no allergies", gets prescribed on:
 *
 *   never asked        amber, and it asks
 *   asked, none known  quiet, on the record
 *   allergies present  red, and loud
 *
 * The amber is deliberate. "Not recorded" is not a neutral absence on a patient
 * record; it is a question somebody still has to put before prescribing, and
 * drawing it in the same grey as a missing email address hides that.
 */
export function AllergyLine({
  allergies,
  reviewedAt,
}: {
  allergies: string | null;
  reviewedAt: string | null;
}) {
  if (allergies) {
    return (
      <p className="mt-2 flex items-start gap-2 rounded-panel border border-coral/40 bg-coral/8 px-3 py-2 text-[13.5px] font-semibold text-coral-text">
        <span className="mt-0.5 shrink-0">
          <IconAlert size={14} />
        </span>
        <span>
          <span className="mono-label !text-coral-text">Allergies</span>
          <span className="block">{allergies}</span>
        </span>
      </p>
    );
  }

  if (reviewedAt) {
    return (
      <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-60">
        <IconCheck size={13} />
        No known allergies
        <span className="text-ink-20">
          · asked {new Date(reviewedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
        </span>
      </p>
    );
  }

  return (
    <p className="mt-2 flex items-center gap-2 rounded-panel border border-amber/40 bg-amber-soft/50 px-3 py-1.5 text-[13px] text-amber-text">
      <IconAlert size={13} />
      Allergies not recorded — ask before prescribing
    </p>
  );
}
