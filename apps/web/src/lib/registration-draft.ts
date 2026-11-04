/**
 * The half-filled registration form, kept across a refresh.
 *
 * Reported 27 Oct 2026: a receptionist typing a patient's details loses all of
 * it to an accidental refresh or a closed tab, with the patient standing at the
 * desk. Nothing was persisted at all — the form was plain component state.
 *
 * IN THE BROWSER, NEVER ON THE SERVER. This is identifiable patient data for
 * somebody who has not consented to anything yet: they are not a patient of the
 * clinic until the form is submitted. Sending a draft anywhere would be
 * collecting their details before they agreed to it, so the draft lives in one
 * browser's own storage, reaches nobody else, and is deleted the moment the
 * registration goes through.
 *
 * THE CONSENT TICKS ARE NEVER STORED, which is the one deliberate hole in it.
 * Consent is an act somebody performed, and a tick that reappears by itself
 * after a refresh is a record of an act that may not have happened. The rest of
 * the typing comes back; the consent is given again.
 *
 * STORED AS A QUERY STRING, NOT JSON, which looks odd until you consider what
 * is being read back. Anything in local storage is editable by whoever sits at
 * the machine, so it is untrusted input — and this repo's lint rule says
 * untrusted JSON goes through a schema rather than `JSON.parse`. There is no
 * schema package in the web app to import, and pulling a validator in for one
 * draft is a lot of dependency for a text box. `URLSearchParams` sidesteps the
 * question: it never throws, every value it yields is a string, and a string is
 * exactly what every field of this form holds. The keys are whitelisted on the
 * way out regardless, so nothing a hand-edited draft invents can reach the form.
 */

/** One key, so a second draft cannot accumulate behind the first. */
const KEY = 'healthcloud.patient-registration-draft.v1';

/** Our own bookkeeping, not a form field. Whitelisted out on the way back. */
const SAVED_AT = 'draftSavedAt';

/**
 * How long a draft is worth keeping.
 *
 * A registration is a few minutes of work. A draft found the next morning is
 * far more likely to be a patient who walked away than one still waiting, and
 * restoring somebody else's half-typed details into a fresh form is worse than
 * an empty one.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Whether there is anything in here worth keeping. Blank forms are not. */
export function worthSaving(form: Record<string, unknown>, ignore: string[]): boolean {
  return Object.entries(form).some(
    ([key, value]) => !ignore.includes(key) && typeof value === 'string' && value.trim() !== '',
  );
}

/**
 * Write the draft, minus the fields named in `ignore`.
 *
 * Only string values are stored. The consent booleans are the only non-strings
 * on this form and they are in `ignore` anyway, so anything else that is not a
 * string is something new that has not been thought about — and silently
 * stringifying it would restore a field as the text "false".
 *
 * Every access is wrapped: storage throws in a private window, and a browser
 * that will not remember a draft must still let somebody register a patient.
 */
export function saveDraft(form: Record<string, unknown>, ignore: string[]): void {
  try {
    if (!worthSaving(form, ignore)) {
      window.localStorage.removeItem(KEY);
      return;
    }

    const encoded = new URLSearchParams();
    encoded.set(SAVED_AT, String(Date.now()));

    for (const [key, value] of Object.entries(form)) {
      if (ignore.includes(key) || key === SAVED_AT) continue;
      if (typeof value === 'string') encoded.set(key, value);
    }

    window.localStorage.setItem(KEY, encoded.toString());
  } catch {
    // No draft is a worse form, not a broken one.
  }
}

/**
 * The stored draft, or null if there is none, it is stale, or it is nonsense.
 *
 * `allow` is the whitelist: only fields the form actually has come back, so a
 * hand-edited draft cannot introduce a key the form never had.
 */
export function readDraft(allow: readonly string[]): Record<string, string> | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;

    const stored = new URLSearchParams(raw);

    const savedAt = Number(stored.get(SAVED_AT));
    if (!Number.isFinite(savedAt) || savedAt <= 0) return null;

    if (Date.now() - savedAt > MAX_AGE_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }

    const draft: Record<string, string> = {};
    for (const key of allow) {
      const value = stored.get(key);
      if (value !== null) draft[key] = value;
    }

    // An expiry stamp and nothing else is not a draft.
    return Object.keys(draft).length > 0 ? draft : null;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: the next save overwrites it, and it expires regardless.
  }
}
