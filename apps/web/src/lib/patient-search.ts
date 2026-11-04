/**
 * The rules the patients screen follows about its search box and the URL.
 *
 * A rule module rather than a piece of a component, for the same reason the
 * board's rules live in `next-step.ts`: web tests here run on
 * `environment: 'node'` with no jsdom, deliberately, so a component's effects
 * cannot be exercised — and these two decisions are exactly the part that was
 * wrong.
 *
 * WHAT WENT WRONG, reported 27 Oct 2026 as "search works in Register but
 * intermittently fails in Patients". The screen wrote `?q=` and never read it
 * back. But the header box — present on every screen, and what ⌘K focuses —
 * answers a search by pushing `/patients?q=…`, which is a navigation from
 * anywhere else and a bare query-string change when the patients screen is
 * already open. Next.js re-renders rather than remounts, so the term never
 * reached the input; and the screen then replaced the URL with `/patients`,
 * because its own box was still empty, which deleted the term outright. The
 * name sat in the header, the whole register sat underneath, and nothing said a
 * search had been attempted. The same keystrokes from the register screen
 * always worked, because from there it navigates. Browser Back and a pasted
 * `?q=` link failed the same way, which is where the "intermittently" came
 * from: it depended on which box was used and which screen they were on.
 *
 * So the URL is the one source of truth now, and these are the two questions
 * that makes it ask: what should the box show, and what should the URL say.
 */

/** Below this, the box is not a search — it is somebody mid-word. */
export const MIN_QUERY = 2;

/**
 * The most matches the server will ever return for one search.
 *
 * Mirrors the `LIMIT 25` in `patients.service.ts`. Named here because three
 * screens need to know it to be honest about a capped list, and a list that
 * silently stops is how somebody concludes a patient was never registered.
 */
export const SEARCH_CAP = 25;

/** Whether what is in the box is worth sending to the server. */
export function isSearchTerm(value: string): boolean {
  return value.trim().length >= MIN_QUERY;
}

/** Take the term on the URL into the box, or leave the box alone. */
export type Adoption = { kind: 'ADOPT'; query: string } | { kind: 'NONE' };

/**
 * Whether the box should adopt the term now on the URL.
 *
 * `lastWritten` is what the screen itself last put there — `null` meaning it
 * last took the term off. Anything else arrived from outside: the header box,
 * ⌘K, Back, Forward, a link somebody was sent. Comparing against it rather
 * than against the box is what stops this fighting a person mid-word, which was
 * the original and good reason for never reading the URL back.
 */
export function adoptionFor(queryOnUrl: string | null, lastWritten: string | null): Adoption {
  if (queryOnUrl === lastWritten) return { kind: 'NONE' };
  return { kind: 'ADOPT', query: queryOnUrl ?? '' };
}

/**
 * What the URL should say, given the box.
 *
 * `term` is what to remember as written — the string for a search, `null` for
 * taking the search off — so the caller records the same value this decided on
 * rather than deriving it a second time and getting it wrong.
 */
export type UrlWrite = { kind: 'WRITE'; href: string; term: string | null } | { kind: 'NONE' };

export function urlWriteFor(query: string, queryOnUrl: string | null): UrlWrite {
  const trimmed = query.trim();

  if (isSearchTerm(trimmed)) {
    if (queryOnUrl === trimmed) return { kind: 'NONE' };
    return { kind: 'WRITE', href: `/patients?q=${encodeURIComponent(trimmed)}`, term: trimmed };
  }

  /**
   * Nothing worth searching for — but only clear the URL if a search is on it.
   *
   * The guard is what keeps `?page=4` alive: somebody who lands on page four
   * and never types must not have the page rewritten out from under them by a
   * search they did not make.
   */
  if (queryOnUrl === null) return { kind: 'NONE' };
  return { kind: 'WRITE', href: '/patients', term: null };
}
