/**
 * What counts as a person's name.
 *
 * The rule exists because `@MinLength(2)` accepted "12345" as a member of
 * staff — reported by the front desk on 28 Sep 2026. The thing it guards
 * against is a mobile number or a patient ID typed into the name box, which
 * produces a record nobody can search for, greet or merge.
 *
 * The cases below are the argument for the rule being "two letters" rather than
 * "no digits", and for `\p{L}` rather than `[A-Za-z]`. Each row is a name a real
 * clinic could be asked to record, or a mistake a real desk could make.
 */

import { describe, expect, it } from 'vitest';
import { looksLikeAPersonName } from '../is-person-name.decorator.js';

describe('a person’s name', () => {
  it.each([
    ['Ram', 'the shortest real name we expect'],
    ['Jo', 'two letters is the floor, and it is a name'],
    ['D’Souza', 'apostrophe, and a typographic one at that'],
    ["D'Souza", 'apostrophe, the keyboard kind'],
    ['Anne-Marie', 'hyphen'],
    ['Dr. A.P.J. Abdul Kalam', 'initials and full stops'],
    ['नरवीर सिंह', 'Devanagari — an Indian product that refused this would be broken'],
    ['சுப்ரமணியன்', 'Tamil'],
    ['Ram 2nd', 'a digit inside a real name is still a real name'],
    ['Seán Ó Briain', 'accents'],
  ])('accepts %j — %s', (value) => {
    expect(looksLikeAPersonName(value)).toBe(true);
  });

  it.each([
    ['12345', 'the reported bug: a number typed into the name box'],
    ['9876543210', 'a mobile number, the likeliest mistake of all'],
    ['999', 'short numbers too'],
    ['...', 'punctuation is not a name'],
    ['@@', 'nor are symbols'],
    ['7', 'one character, no letters'],
    ['A', 'one letter is not two'],
    ['A1', 'a letter and a digit is still one letter'],
    ['   ', 'whitespace'],
    ['', 'empty'],
  ])('refuses %j — %s', (value) => {
    expect(looksLikeAPersonName(value)).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    // The decorator runs before any transform is guaranteed to have, so it
    // cannot assume it was handed text.
    for (const value of [undefined, null, 12345, {}, [], true]) {
      expect(looksLikeAPersonName(value)).toBe(false);
    }
  });
});
