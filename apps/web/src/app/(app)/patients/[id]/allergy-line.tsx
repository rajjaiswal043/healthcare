import { IconAlert, IconCheck } from '@/components/icons';

/**
 * Allergies, in the highlights panel, above everything else about this patient.
 *
 * Four states, because a blank allergy field means two completely different
 * things and the failure is one-directional. A patient nobody asked, read as
 * "no allergies", gets prescribed on:
 *
 *   allergies present                red, and loud
 *   asked, none known                quiet, on the record
 *   never asked, patient is in       amber, and it asks
 *   never asked, nobody is in        the fact, quietly
 *
 * The amber is deliberate. "Not recorded" is not a neutral absence on a patient
 * record; it is a question somebody still has to put before prescribing, and
 * drawing it in the same grey as a missing email address hides that.
 *
 * BUT ONLY WHERE THERE IS SOMEBODY TO ASK, added 27 Oct 2026. The amber panel
 * and its instruction used to draw on every record: a patient who last came in
 * March, a patient registered an hour ago and never booked, anyone opened out
 * of curiosity. "Ask before prescribing" is an instruction to act now, and with
 * the patient not in the building there is nobody to ask and nothing being
 * prescribed, so it read as a fault in the record rather than a prompt. The
 * fact still shows, because the one-directional failure above does not go away
 * when the patient goes home; it is the imperative that was misplaced.
 */
export function AllergyLine({
  allergies,
  reviewedAt,
  hasLiveVisit,
}: {
  allergies: string | null;
  reviewedAt: string | null;
  /**
   * Whether this patient is in the clinic's hands right now — in for a visit,
   * or booked for one. Decides whether the third state instructs or merely
   * states; it has no bearing on the other two, because a recorded allergy is
   * worth the same shout whenever it is read.
   */
  hasLiveVisit: boolean;
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

  /* Nobody is in: the fact, in the register's own voice, with no panel around
     it and nothing asked of whoever is reading. */
  if (!hasLiveVisit) {
    return (
      <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-60">
        <span className="text-amber-text">
          <IconAlert size={13} />
        </span>
        Allergies not recorded
      </p>
    );
  }

  return (
    <p className="mt-2 flex items-center gap-2 rounded-panel border border-amber/40 bg-amber-soft/50 px-3 py-1.5 text-[13px] text-amber-text">
      <IconAlert size={13} />
      Allergies not recorded. Ask before prescribing.
    </p>
  );
}
