/**
 * What the header says you are looking at, per route.
 *
 * A table rather than a prop each page passes, because the header is rendered by
 * `AppShell` — above every page and outside all of them — and threading a title
 * up through the tree would mean every page owning a piece of chrome it does not
 * render.
 *
 * The cost of a table is that it has to be kept in step with the routes, and it
 * was not: five screens shipped without an entry and fell through to the clinic's
 * own name, so Finance desk read "Ram Hospital › Ram Hospital" for months. That
 * fallback is why nobody noticed — a breadcrumb showing the clinic name looks
 * deliberate, not broken.
 *
 * `breadcrumbs.spec.ts` is what keeps it honest now: it walks the route folders
 * and fails if any of them is missing from here. The fallback below is no longer
 * load-bearing, and a new page cannot quietly acquire the old bug.
 *
 * **Keys are route patterns, spelled exactly as the folders are** — `[id]` and
 * all. That is what lets the test derive the expected keys from the filesystem
 * instead of listing them a second time, and it is why a dynamic route gets a
 * real entry here rather than a special case in the matcher.
 *
 * The wording follows the NAV RAIL, not each page's own headline. A breadcrumb
 * answers "where am I in the menu", so `/finance` is "Finance desk" as the rail
 * calls it, not "Take the payment" as the page's h1 reads. Where the rail is
 * terse and the crumb has room, the crumb says the fuller form — "Register" in
 * the rail, "Register a patient" here.
 */
export const BREADCRUMBS: Record<string, string> = {
  '/': 'Home',
  '/patients': 'Patients',
  '/patients/register': 'Register a patient',
  '/patients/all': 'All patients',
  '/patients/[id]': 'Patient record',
  '/queue': "Today's queue",
  '/appointments/new': 'Book an appointment',
  '/consultations/[id]': 'Consultation',
  '/diagnostics': 'Tests to do',
  '/finance': 'Finance desk',
  '/reports/finance': 'Finance report',
  '/reports/collections': 'Collections',
  '/settings/displays': 'Waiting-room screens',
  '/settings/users': 'Staff',
  '/settings/roles': 'Roles and permissions',
  '/settings/doctors': 'Doctors and hours',
  '/settings/prices': 'Prices',
  '/settings/promotions': 'Promotions',
  '/settings/branding': 'Branding',
  '/settings/patient-ids': 'Patient IDs',
  '/change-password': 'Choose a password',
};

/**
 * The crumb for a live pathname, or null when the table has no answer.
 *
 * Exact match first, then one pass for dynamic routes: same number of segments,
 * every literal segment equal, and `[id]`-style segments matching anything. A
 * `/patients/018f…` is a `/patients/[id]`.
 *
 * Deliberately NOT a prefix match, which is the tempting shortcut and the wrong
 * one — `mostSpecificMatch` in the shell wants prefixes because a nav item stays
 * lit for everything beneath it, whereas a breadcrumb names one screen. Under a
 * prefix rule `/patients/register` would answer to `/patients` as readily as to
 * itself, and which one won would come down to iteration order.
 *
 * Returns null rather than a fallback so the caller decides what an unknown
 * route looks like, and so a test can tell "no entry" from "an entry that reads
 * like the clinic's name".
 */
export function breadcrumbFor(pathname: string): string | null {
  const exact = BREADCRUMBS[pathname];
  if (exact !== undefined) return exact;

  const actual = pathname.split('/').filter(Boolean);

  for (const [pattern, label] of Object.entries(BREADCRUMBS)) {
    const expected = pattern.split('/').filter(Boolean);
    if (expected.length !== actual.length) continue;

    const matches = expected.every(
      (segment, i) => (segment.startsWith('[') && segment.endsWith(']')) || segment === actual[i],
    );
    if (matches) return label;
  }

  return null;
}
