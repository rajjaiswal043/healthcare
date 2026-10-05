import type { TenantClient } from '@healthcloud/db';

/**
 * Recovery check-ins: when they go out, and when an answer needs a person.
 *
 * The rule that matters most is not in this file, because it is an absence:
 * **a check-in never advises.** It collects a number, a yes/no and the
 * patient's own words. A rising score is flagged to the clinic, and the only
 * thing the patient is told is that somebody will call. Anything that sounds
 * like "take another tablet" belongs to a doctor, not to a schedule.
 */

/** Pain at or above this is flagged whatever came before it. */
export const SEVERE_PAIN = 8;

/** A rise of this much since the previous answer is flagged. */
export const RISING_BY = 2;

/** No more than this many rows per consultation, whatever the dates say. */
const MAX_CHECKINS = 30;

/**
 * Why this answer needs a person to look at it, or null if it does not.
 *
 * Deliberately crude. A clinic can argue for a better rule; it cannot argue
 * with one it can read in two lines.
 */
export function flagFor(painScore: number, previousPainScore: number | null): string | null {
  if (painScore >= SEVERE_PAIN) return `Severe pain reported (${painScore}/10)`;
  if (previousPainScore !== null && painScore - previousPainScore >= RISING_BY) {
    return `Pain rising, ${previousPainScore} → ${painScore}`;
  }
  return null;
}

/**
 * The dates check-ins are due: every `intervalDays` from the day of the visit,
 * stopping BEFORE the review. On the review day itself the patient is in the
 * room, and a message asking how they are would be asking the wrong person.
 *
 * Dates are clinic-local `YYYY-MM-DD` strings throughout.
 */
export function checkinDates(
  visitDate: string,
  reviewDate: string,
  intervalDays: number,
): string[] {
  const out: string[] = [];
  const start = Date.parse(`${visitDate}T00:00:00Z`);
  const end = Date.parse(`${reviewDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || intervalDays < 1) return out;

  for (let t = start + intervalDays * 86400000; t < end; t += intervalDays * 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length >= MAX_CHECKINS) break;
  }
  return out;
}

/**
 * Write the schedule for a consultation that has just been signed.
 *
 * Runs inside the signing transaction, so a signed note and its schedule
 * appear together or not at all. Idempotent on (encounter, date), because the
 * unique index is.
 */
export async function scheduleRecoveryCheckins(
  tx: TenantClient,
  input: {
    tenantId: string;
    encounterId: string;
    patientId: string;
    visitDate: string;
    reviewDate: string | null;
    intervalDays: number | null;
  },
): Promise<number> {
  if (!input.reviewDate || !input.intervalDays) return 0;

  const dates = checkinDates(input.visitDate, input.reviewDate, input.intervalDays);
  if (dates.length === 0) return 0;

  const created = await tx.recoveryCheckin.createMany({
    data: dates.map((d) => ({
      tenantId: input.tenantId,
      encounterId: input.encounterId,
      patientId: input.patientId,
      dueOn: new Date(`${d}T00:00:00Z`),
    })),
    skipDuplicates: true,
  });

  return created.count;
}
