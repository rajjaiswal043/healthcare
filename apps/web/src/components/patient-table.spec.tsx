/**
 * The patient table, and the promise that there is only one of it.
 *
 * "Find a patient" and "All patients" must show a patient the same way and
 * open the same record when one is chosen. The second half of this file is what
 * keeps that true: it reads both screens' source and fails if either grows a
 * table of its own, which is how two copies would start.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PatientSummary } from '@/lib/api';
import { PatientTable } from './patient-table';

function patient(over: Partial<PatientSummary> = {}): PatientSummary {
  return {
    id: '019329f0-0000-7000-8000-000000000001',
    uhid: 'RH00042',
    name: 'Asha Kulkarni',
    mobile: '9876543210',
    gender: 'FEMALE',
    ageYears: 34,
    birthDate: null,
    city: 'Pune',
    abhaNumber: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

describe('a patient row', () => {
  it('links the name to the patient record', () => {
    const html = renderToStaticMarkup(<PatientTable patients={[patient()]} />);

    expect(html).toContain('href="/patients/019329f0-0000-7000-8000-000000000001"');
    expect(html).toContain('Asha Kulkarni');
    expect(html).toContain('RH00042');
  });

  it('draws one row per patient, in the order given', () => {
    const html = renderToStaticMarkup(
      <PatientTable
        patients={[
          patient({ id: 'p-newest', name: 'Newest' }),
          patient({ id: 'p-middle', name: 'Middle' }),
          patient({ id: 'p-oldest', name: 'Oldest' }),
        ]}
      />,
    );

    // The table does not re-sort. The order is the server's, which is the only
    // place "newest first" is decided.
    const order = ['Newest', 'Middle', 'Oldest'].map((n) => html.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html.match(/<tbody>.*<\/tbody>/s)?.[0].match(/<tr/g)).toHaveLength(3);
  });

  it('says whether ABHA is linked, and marks a missing city', () => {
    const html = renderToStaticMarkup(
      <PatientTable
        patients={[
          patient({ id: 'with', abhaNumber: '12-3456-7890-1234' }),
          patient({ id: 'without', abhaNumber: null, city: null }),
        ]}
      />,
    );

    expect(html).toContain('>linked<');
    expect(html).toContain('>not linked<');
    expect(html).toContain('—');
  });
});

describe('one table, two screens', () => {
  const read = (route: string) =>
    readFileSync(
      fileURLToPath(new URL(`../app/(app)/${route}/page.tsx`, import.meta.url)),
      'utf-8',
    );

  const screens = {
    'Find a patient': read('patients'),
    'All patients': read('patients/all'),
  };

  for (const [name, source] of Object.entries(screens)) {
    it(`${name} renders patients through PatientTable`, () => {
      expect(source).toMatch(/PatientTable/);
    });

    it(`${name} has no patient table of its own`, () => {
      // A second <table> on either screen is a second definition of what a
      // patient row is — the thing this component exists to prevent.
      expect(source).not.toMatch(/<table[\s>]/);
    });
  }
});
