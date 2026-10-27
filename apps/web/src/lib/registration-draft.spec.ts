/**
 * The registration draft.
 *
 * Tests run on `environment: 'node'`, so there is no real `localStorage` — a
 * stand-in is installed on `globalThis.window`, which is also how the last
 * describe checks the case that matters most: a browser that refuses to store
 * anything must not break the form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, readDraft, saveDraft, worthSaving } from './registration-draft';

const IGNORE = ['consentCareDelivery', 'consentMarketing'];
const ALLOW = ['name', 'mobile', 'city', 'ageYears', 'state'] as const;

function installStorage(impl?: Partial<Storage>) {
  const store = new Map<string, string>();

  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    ...impl,
  };

  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return store;
}

beforeEach(() => installStorage());
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

describe('worthSaving', () => {
  it('is false for an untouched form', () => {
    expect(worthSaving({ name: '', mobile: '   ' }, IGNORE)).toBe(false);
  });

  it('is false when the only thing done is ticking consent', () => {
    // Otherwise opening the form and ticking a box would leave a draft behind
    // for the next patient.
    expect(worthSaving({ name: '', consentCareDelivery: true }, IGNORE)).toBe(false);
  });

  it('is true once anything has been typed', () => {
    expect(worthSaving({ name: 'Sunita', mobile: '' }, IGNORE)).toBe(true);
  });
});

describe('a draft that was typed', () => {
  it('comes back', () => {
    saveDraft({ name: 'Sunita Rao', mobile: '9876543210' }, IGNORE);

    expect(readDraft(ALLOW)).toEqual({ name: 'Sunita Rao', mobile: '9876543210' });
  });

  it('survives the characters a name and an address actually contain', () => {
    // The store is a query string, so ampersands, plus signs and non-Latin
    // scripts are the cases that would betray a naive encoding.
    saveDraft({ name: 'नरवीर & सुनीता', mobile: '+91 98765 43210', city: 'Panjim, Goa' }, IGNORE);

    expect(readDraft(ALLOW)).toEqual({
      name: 'नरवीर & सुनीता',
      mobile: '+91 98765 43210',
      city: 'Panjim, Goa',
    });
  });

  it('never brings the consent ticks back with it', () => {
    // Consent is an act somebody performed. A tick that reappears by itself is
    // a record of something that may not have happened.
    saveDraft({ name: 'Sunita Rao', consentCareDelivery: true, consentMarketing: true }, IGNORE);

    const draft = readDraft([...ALLOW, 'consentCareDelivery', 'consentMarketing']);

    expect(draft).toEqual({ name: 'Sunita Rao' });
    expect(draft).not.toHaveProperty('consentCareDelivery');
  });

  it('only gives back fields the form actually has', () => {
    // A hand-edited draft must not be able to introduce a key.
    installStorage().set(
      'healthcloud.patient-registration-draft.v1',
      `draftSavedAt=${Date.now()}&name=Sunita&isAdmin=true`,
    );

    expect(readDraft(ALLOW)).toEqual({ name: 'Sunita' });
  });

  it('is gone once the patient is registered', () => {
    saveDraft({ name: 'Sunita Rao' }, IGNORE);
    clearDraft();

    expect(readDraft(ALLOW)).toBeNull();
  });

  it('is dropped when the form is emptied again', () => {
    saveDraft({ name: 'Sunita Rao' }, IGNORE);
    saveDraft({ name: '' }, IGNORE);

    expect(readDraft(ALLOW)).toBeNull();
  });
});

describe('a draft nobody came back for', () => {
  it('expires, rather than greeting the next patient with it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T09:00:00.000Z'));
    saveDraft({ name: 'Sunita Rao' }, IGNORE);

    vi.setSystemTime(new Date('2026-10-27T20:00:00.000Z'));
    expect(readDraft(ALLOW)).toEqual({ name: 'Sunita Rao' });

    vi.setSystemTime(new Date('2026-10-28T09:30:00.000Z'));
    expect(readDraft(ALLOW)).toBeNull();
  });
});

describe('a browser that will not store anything', () => {
  it('does not break saving', () => {
    installStorage({
      setItem: () => {
        throw new Error('private window');
      },
    });

    expect(() => saveDraft({ name: 'Sunita Rao' }, IGNORE)).not.toThrow();
  });

  it('does not break reading', () => {
    installStorage({
      getItem: () => {
        throw new Error('private window');
      },
    });

    expect(readDraft(ALLOW)).toBeNull();
  });

  it('treats contents with no timestamp as no draft', () => {
    installStorage().set('healthcloud.patient-registration-draft.v1', 'not a draft at all');

    expect(readDraft(ALLOW)).toBeNull();
  });
});
