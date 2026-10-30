/**
 * What counts as the name of a test, service or price.
 *
 * The rule exists because `@MinLength(2)` accepted "12" and "@@" as the name of
 * a test — reported from the clinic on 30 Oct 2026, from two screens that write
 * the same column: Settings → Departments → add a test, and Settings → Prices.
 * What it produces is a line on a patient's bill, a row on the department's
 * worklist and an entry in a dropdown, none of which anybody can read.
 *
 * The cases below are the argument for the rule being "two letters" rather than
 * "no digits". A catalogue name carries digits constantly and must go on doing
 * so — banning numerals would refuse half a real price list to catch "999".
 */

import { describe, expect, it } from 'vitest';
import { looksLikeAThingName } from '../is-catalogue-name.decorator.js';

describe('the name of something in the catalogue', () => {
  it.each([
    ['2D Echo', 'a real test whose name opens with a digit'],
    ['12-lead ECG', 'and another'],
    ['X-Ray Chest PA', 'the commonest thing a department does'],
    ['Vitamin B12', 'a digit at the end, not the start'],
    ['CBC', 'three letters and nothing else'],
    ['CAMP50', 'a promotion-style code, which is still a name'],
    ['रक्त जाँच', 'Devanagari — an Indian product cannot refuse this'],
    ['CT', 'two letters is the floor, and it is a name'],
  ])('accepts %j — %s', (value) => {
    expect(looksLikeAThingName(value)).toBe(true);
  });

  it.each([
    ['12', 'what was actually typed and accepted'],
    ['999', 'a price in the name box'],
    ['0', 'a single digit'],
    ['...', 'punctuation is not a name'],
    ['@@', 'nor is a symbol'],
    ['--', 'nor a pair of hyphens'],
    ['   ', 'whitespace'],
    ['', 'nothing at all'],
    ['X', 'one letter: real codes are at least two'],
  ])('refuses %j — %s', (value) => {
    expect(looksLikeAThingName(value)).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    // The decorator runs before any coercion, so a number really can arrive.
    expect(looksLikeAThingName(12)).toBe(false);
    expect(looksLikeAThingName(null)).toBe(false);
    expect(looksLikeAThingName(undefined)).toBe(false);
    expect(looksLikeAThingName({})).toBe(false);
  });
});
