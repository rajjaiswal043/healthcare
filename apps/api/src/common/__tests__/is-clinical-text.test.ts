/**
 * A clinical narrative has words in it.
 *
 * The accepting cases are the ones that matter: a rule against numerals would
 * have refused most of how a doctor actually writes.
 */

import { describe, expect, it } from 'vitest';
import { looksLikeClinicalText } from '../is-clinical-text.decorator.js';

describe('looksLikeClinicalText', () => {
  it.each([
    ['2 days of knee pain', 'the commonest shape of a chief complaint'],
    ['T2DM x 5y', 'abbreviated, numeric, and entirely normal'],
    ['BP 140/90 since January', 'a reading inside a sentence'],
    ['घुटने में दर्द', 'Devanagari — an Indian product that refused this would be broken'],
    ['Fever', 'one word'],
    ['', 'blank: clearing an optional field is a real edit, not nonsense'],
    ['   ', 'whitespace is the same as blank'],
  ])('accepts %j — %s', (value) => {
    expect(looksLikeClinicalText(value)).toBe(true);
  });

  it.each([
    ['123', 'a number typed into the complaint box — the reported defect'],
    ['9', 'a single digit'],
    ['1/2', 'punctuation and digits, still no word'],
    ['...', 'somebody filling the box to get past it'],
    ['@@', 'no letters at all'],
    ['A', 'one letter is not a word'],
  ])('refuses %j — %s', (value) => {
    expect(looksLikeClinicalText(value)).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    expect(looksLikeClinicalText(123)).toBe(false);
    expect(looksLikeClinicalText(null)).toBe(false);
    expect(looksLikeClinicalText(undefined)).toBe(false);
  });
});
