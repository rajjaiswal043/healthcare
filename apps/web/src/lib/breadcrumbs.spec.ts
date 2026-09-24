/**
 * The breadcrumb table must cover every route, and this is what enforces it.
 *
 * Five screens — Finance desk, Collections, Finance report, Prices, Promotions —
 * shipped with no entry and fell through to the clinic's own name, so the header
 * read "Ram Hospital › Ram Hospital". Nothing caught it: not the compiler, which
 * cannot know which strings are routes, and not a test, because there was none.
 * It survived for months because the fallback looked like a decision rather than
 * a gap.
 *
 * So the expectation is derived from the FILESYSTEM rather than restated here. A
 * list of routes written in a test is a second copy of the thing that drifted,
 * and it would drift the same way — silently, the next time somebody adds a
 * page. Walking the folders means a new route fails this test the moment it
 * exists, before anybody looks at the header.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BREADCRUMBS, breadcrumbFor } from './breadcrumbs.js';

const APP_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'app', '(app)');

/**
 * Every route under the signed-in shell, as the router sees it.
 *
 * Route GROUPS — a folder in brackets, like `(app)` — are organisational and do
 * not appear in the URL, so they are stepped through rather than added to the
 * path. Dynamic segments like `[id]` DO appear, and are kept verbatim: that is
 * exactly the key the table is expected to hold.
 */
function routesUnder(dir: string, prefix = ''): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'page.tsx') {
      found.push(prefix === '' ? '/' : prefix);
      continue;
    }
    if (!entry.isDirectory()) continue;

    const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
    found.push(...routesUnder(join(dir, entry.name), isGroup ? prefix : `${prefix}/${entry.name}`));
  }

  return found;
}

describe('the breadcrumb table', () => {
  const routes = routesUnder(APP_DIR);

  it('finds the routes it is meant to be checking', () => {
    // A walk that silently found nothing would make every assertion below pass
    // while checking nothing at all.
    expect(routes.length).toBeGreaterThan(15);
    expect(routes).toContain('/');
    expect(routes).toContain('/finance');
    expect(routes).toContain('/patients/[id]');
  });

  it('has an entry for every page under the app shell', () => {
    const missing = routes.filter((route) => BREADCRUMBS[route] === undefined).sort();

    expect(
      missing,
      `These routes have no breadcrumb, so the header will show the clinic's name twice. ` +
        `Add them to BREADCRUMBS in src/lib/breadcrumbs.ts, worded as the nav rail words them.`,
    ).toEqual([]);
  });

  it('has no entry for a route that no longer exists', () => {
    const stale = Object.keys(BREADCRUMBS)
      .filter((key) => !routes.includes(key))
      .sort();

    expect(stale, 'These breadcrumbs point at routes that are gone.').toEqual([]);
  });

  it('never answers with something that looks like a missing entry', () => {
    for (const [route, label] of Object.entries(BREADCRUMBS)) {
      expect(label.trim(), `${route} has an empty breadcrumb`).not.toBe('');
    }
  });
});

describe('resolving a pathname', () => {
  it('matches a static route exactly', () => {
    expect(breadcrumbFor('/finance')).toBe('Finance desk');
    expect(breadcrumbFor('/reports/collections')).toBe('Collections');
    expect(breadcrumbFor('/settings/promotions')).toBe('Promotions');
  });

  /** The five from the bug report, named so a regression is unmistakable. */
  it('no longer falls through on the five billing and settings screens', () => {
    for (const route of [
      '/finance',
      '/reports/finance',
      '/reports/collections',
      '/settings/prices',
      '/settings/promotions',
    ]) {
      expect(breadcrumbFor(route)).not.toBeNull();
    }
  });

  it('matches a dynamic route by shape', () => {
    expect(breadcrumbFor('/patients/019329f0-0000-7000-8000-000000000001')).toBe('Patient record');
    expect(breadcrumbFor('/consultations/019329f0-0000-7000-8000-000000000002')).toBe(
      'Consultation',
    );
  });

  /**
   * The reason this is not a prefix match. `/patients/register` is a real route
   * with its own entry, and it must not be answered by `/patients/[id]` just
   * because it happens to sit one segment below `/patients`.
   */
  it('prefers the literal route over a dynamic one of the same shape', () => {
    expect(breadcrumbFor('/patients/register')).toBe('Register a patient');
    // The newest literal under /patients — also exactly the shape of
    // /patients/[id], and must not be read as a patient record.
    expect(breadcrumbFor('/patients/all')).toBe('All patients');
  });

  it('does not match across a different number of segments', () => {
    expect(breadcrumbFor('/patients/019329f0/tests')).toBeNull();
    expect(breadcrumbFor('/patients')).toBe('Patients');
  });

  it('returns null for a route it has never heard of', () => {
    expect(breadcrumbFor('/nothing-here')).toBeNull();
  });
});
