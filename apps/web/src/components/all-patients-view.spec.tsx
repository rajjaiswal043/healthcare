/**
 * What the all-patients screen shows, state by state.
 *
 * Rendered to a string: the page reads the URL and fetches, this view draws, so
 * each state can be handed in directly and checked without a browser or a
 * server.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PatientSummary } from '@/lib/api';
import { AllPatientsView, allPatientsHref, type AllPatientsState } from './all-patients-view';

function patients(count: number, from = 0): PatientSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p-${from + i}`,
    uhid: `RH${String(from + i).padStart(5, '0')}`,
    name: `Patient ${from + i}`,
    mobile: '9876543210',
    gender: 'MALE',
    ageYears: 40,
    birthDate: null,
    city: null,
    abhaNumber: null,
    createdAt: '2026-09-20T10:00:00.000Z',
  }));
}

const render = (state: AllPatientsState, canRegister = true) =>
  renderToStaticMarkup(<AllPatientsView state={state} canRegister={canRegister} />);

const loaded = (page: number, rows: PatientSummary[], total: number): AllPatientsState => ({
  kind: 'loaded',
  patients: rows,
  page,
  pageSize: 30,
  total,
});

describe('the all-patients screen', () => {
  it('shows a placeholder while loading', () => {
    expect(render({ kind: 'loading' })).toContain('skeleton');
  });

  it('shows the server’s own message when loading fails', () => {
    const html = render({ kind: 'error', message: 'Not signed in' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Not signed in');
  });

  it('says which slice of the list is on screen', () => {
    expect(render(loaded(1, patients(30), 242))).toContain('Showing 1–30 of 242');
    expect(render(loaded(2, patients(30, 30), 242))).toContain('Showing 31–60 of 242');
  });

  it('counts the last page by what is actually on it', () => {
    // 242 patients: page 9 holds 241–242, not 241–270.
    expect(render(loaded(9, patients(2, 240), 242))).toContain('Showing 241–242 of 242');
  });

  it('writes large totals the way an Indian clinic reads them', () => {
    expect(render(loaded(1, patients(30), 123_456))).toContain('of 1,23,456');
  });

  it('opens a patient exactly where search does', () => {
    const html = render(loaded(1, patients(2), 2));
    expect(html).toContain('href="/patients/p-0"');
    expect(html).toContain('href="/patients/p-1"');
  });

  it('draws page numbers once there is more than one page', () => {
    const html = render(loaded(2, patients(30, 30), 242));
    expect(html).toContain('aria-label="Patient list pages"');
    expect(html).toContain('aria-current="page"');
  });

  it('draws no page numbers for a single page', () => {
    expect(render(loaded(1, patients(12), 12))).not.toContain('aria-label="Patient list pages"');
  });

  /**
   * Decision (d). A page past the end is not an error and not a dead end: it
   * says which page is last and links to it.
   */
  it('points at the last page when asked for one past the end', () => {
    const html = render(loaded(99, [], 242));

    expect(html).toContain('There is no page 99');
    expect(html).toContain('The last page is 9');
    expect(html).toContain('href="/patients/all?page=9"');
    // Not a table of nothing, and not an error.
    expect(html).not.toContain('<table');
    expect(html).not.toContain('role="alert"');
  });

  it('says so when a clinic has nobody yet, and offers registration to those who may', () => {
    const allowed = render(loaded(1, [], 0), true);
    expect(allowed).toContain('No patients yet');
    expect(allowed).toContain('href="/patients/register"');

    const notAllowed = render(loaded(1, [], 0), false);
    expect(notAllowed).toContain('No patients yet');
    expect(notAllowed).not.toContain('href="/patients/register"');
  });
});

describe('where each page lives', () => {
  it('is the bare route for page 1 and ?page=N after it', () => {
    expect(allPatientsHref(1)).toBe('/patients/all');
    expect(allPatientsHref(2)).toBe('/patients/all?page=2');
    expect(allPatientsHref(40)).toBe('/patients/all?page=40');
  });
});
