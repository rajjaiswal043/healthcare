/**
 * A person's name has letters in it.
 *
 * Mirrors `IsPersonName` in the API, which is the rule — this only stops the
 * form submitting something the server is going to refuse, so the desk finds
 * out while the cursor is still in the box rather than after a round trip.
 *
 * Two letters in any script, rather than "no digits": the failure being caught
 * is a mobile number or a patient ID typed into the name field, and those have
 * no letters at all. `\p{L}` rather than `[A-Za-z]`, because a name written in
 * Devanagari or Tamil is a name.
 */
export function looksLikeAPersonName(value: string): boolean {
  return (value.match(/\p{L}/gu) ?? []).length >= 2;
}
