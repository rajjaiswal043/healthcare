/**
 * Whether the page on screen was reached by navigating INSIDE the app.
 *
 * A back button that calls `router.back()` unconditionally is only right when
 * there is an in-app page behind it. A patient record opened from a link pasted
 * into a new tab, or from a bookmark, has nothing behind it — or worse, has the
 * page the user was on before they came to the app, and "Back" would quietly
 * take them out of it.
 *
 * `window.history.length` cannot answer this: it counts entries from other
 * sites too, and it is 2 for a tab that visited a search engine and then
 * opened the app. So the shell records each route it renders, here, and the
 * question becomes "has this app session rendered a page before this one".
 *
 * Module state rather than React state on purpose. It has to survive client
 * navigations — which it does, the module is loaded once per tab — and has to
 * be forgotten on a full reload, which is exactly when the browser's own back
 * stack stops being ours to rely on.
 *
 * The one case it cannot see: land on a record directly, click through to
 * another page, then use the BROWSER's back button to return. The shell has now
 * rendered two pages, so the record's Back button walks history — out of the
 * app, as the browser's own button would at that point. Distinguishing that
 * needs to know a navigation was a pop rather than a push, which the router
 * does not expose.
 */

let current: string | null = null;
let previous: string | null = null;

/** Called by the shell whenever the route changes. */
export function recordNavigation(pathname: string): void {
  if (pathname === current) return;
  previous = current;
  current = pathname;
}

/** True once any in-app page has been rendered before the current one. */
export function hasInAppHistory(): boolean {
  return previous !== null;
}

export type BackTarget = { kind: 'history' } | { kind: 'push'; href: string };

/**
 * Where "Back" should go.
 *
 * Pure, so the decision can be tested without a browser: walk the history when
 * there is in-app history to walk, otherwise go to a fixed page that makes
 * sense to return to from here.
 */
export function backTarget(inAppHistory: boolean, fallback: string): BackTarget {
  return inAppHistory ? { kind: 'history' } : { kind: 'push', href: fallback };
}

/** Tests only: start a fresh "tab". */
export function resetNavigationHistory(): void {
  current = null;
  previous = null;
}
