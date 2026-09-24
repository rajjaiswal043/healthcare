/**
 * Where the patient record's Back button goes.
 *
 * The decision is tested here rather than through a click, because it is the
 * part that can be wrong: `router.back()` itself is the router's, and the
 * button only chooses between calling it and going to a fixed page.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  backTarget,
  hasInAppHistory,
  recordNavigation,
  resetNavigationHistory,
} from './navigation-history.js';

beforeEach(() => resetNavigationHistory());

describe('whether there is an in-app page to go back to', () => {
  it('is no for the first page a tab opens', () => {
    // A record opened from a pasted link or a bookmark.
    recordNavigation('/patients/abc');
    expect(hasInAppHistory()).toBe(false);
  });

  it('is yes once the app has shown another page first', () => {
    recordNavigation('/patients/all');
    recordNavigation('/patients/abc');
    expect(hasInAppHistory()).toBe(true);
  });

  it('does not count the same page rendering twice', () => {
    // A re-render, or a query-string change the shell reports again, is not a
    // page behind this one.
    recordNavigation('/patients/abc');
    recordNavigation('/patients/abc');
    expect(hasInAppHistory()).toBe(false);
  });
});

describe('where Back goes', () => {
  it('walks history when there is in-app history — from search or the all-patients list', () => {
    // The shell records the pathname, so /patients/all?page=4 arrives as
    // /patients/all — the page number is the browser's to restore, in the URL.
    for (const cameFrom of ['/patients', '/patients/all']) {
      resetNavigationHistory();
      recordNavigation(cameFrom);
      recordNavigation('/patients/abc');

      expect(backTarget(hasInAppHistory(), '/patients')).toEqual({ kind: 'history' });
    }
  });

  it('goes to the fallback when the record was opened directly', () => {
    recordNavigation('/patients/abc');

    expect(backTarget(hasInAppHistory(), '/patients')).toEqual({
      kind: 'push',
      href: '/patients',
    });
  });
});
