/**
 * The patients screen's search rules.
 *
 * Every case here is one of the ways the 27 Oct 2026 report reproduced, written
 * as the decision rather than as the screen: the term arriving from the header
 * box, from Back, from a pasted link, and the `?page=` that must survive
 * somebody who never typed.
 */

import { describe, expect, it } from 'vitest';
import { MIN_QUERY, adoptionFor, isSearchTerm, urlWriteFor } from './patient-search';

describe('isSearchTerm', () => {
  it('ignores somebody mid-word', () => {
    expect(isSearchTerm('')).toBe(false);
    expect(isSearchTerm('s')).toBe(false);
    expect(isSearchTerm('  s  ')).toBe(false);
  });

  it('accepts a term of the minimum length, trimmed', () => {
    expect(isSearchTerm('sh')).toBe(true);
    expect(isSearchTerm('  sh  ')).toBe(true);
    expect('sh'.length).toBe(MIN_QUERY);
  });
});

describe('adoptionFor', () => {
  it('adopts a term the screen did not write — the header box, or ⌘K', () => {
    expect(adoptionFor('sharma', null)).toEqual({ kind: 'ADOPT', query: 'sharma' });
  });

  it('adopts a different term while one is already being searched for', () => {
    // Somebody on ?q=sharma types a second name into the header box.
    expect(adoptionFor('rajesh', 'sharma')).toEqual({ kind: 'ADOPT', query: 'rajesh' });
  });

  it('empties the box when Back leaves no term on the URL', () => {
    expect(adoptionFor(null, 'sharma')).toEqual({ kind: 'ADOPT', query: '' });
  });

  it('leaves the box alone for a term the screen wrote itself', () => {
    // The write re-renders the screen with new params. Without this, every
    // keystroke would be adopted back over the person typing it.
    expect(adoptionFor('sharma', 'sharma')).toEqual({ kind: 'NONE' });
  });

  it('leaves the box alone when there is no term and none was written', () => {
    expect(adoptionFor(null, null)).toEqual({ kind: 'NONE' });
  });
});

describe('urlWriteFor', () => {
  it('writes the term when the URL does not have it yet', () => {
    expect(urlWriteFor('sharma', null)).toEqual({
      kind: 'WRITE',
      href: '/patients?q=sharma',
      term: 'sharma',
    });
  });

  it('writes the trimmed term, encoded', () => {
    expect(urlWriteFor('  a & b  ', null)).toEqual({
      kind: 'WRITE',
      href: '/patients?q=a%20%26%20b',
      term: 'a & b',
    });
  });

  it('writes nothing when the URL already says it', () => {
    expect(urlWriteFor('sharma', 'sharma')).toEqual({ kind: 'NONE' });
  });

  it('takes the search off the URL when the box is cleared', () => {
    expect(urlWriteFor('', 'sharma')).toEqual({ kind: 'WRITE', href: '/patients', term: null });
  });

  it('takes it off for a term shortened below the minimum', () => {
    expect(urlWriteFor('s', 'sharma')).toEqual({ kind: 'WRITE', href: '/patients', term: null });
  });

  it('leaves ?page= alone for somebody who never typed', () => {
    // The whole reason the clear is guarded: this is page four of the register,
    // not a search that was abandoned.
    expect(urlWriteFor('', null)).toEqual({ kind: 'NONE' });
  });
});
