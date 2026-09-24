import { describe, expect, it } from 'vitest';
import { publicPatientName } from '../public-name.js';

/**
 * The masking rule, on its own.
 *
 * A unit test rather than only an integration one, because this function is the
 * privacy boundary of the waiting-room screen: everything downstream of it
 * assumes the surname is already gone.
 */
describe('publicPatientName', () => {
  it('keeps the first name and the initial of the last', () => {
    expect(publicPatientName('Kavita Sharma')).toBe('Kavita S.');
  });

  it('takes the LAST word, not the second', () => {
    // She would be addressed as Farida K. Taking "Sheikh" would be wrong in a
    // way nobody reports — they just stop trusting the board.
    expect(publicPatientName('Farida Sheikh Khan')).toBe('Farida K.');
  });

  it('leaves a single-word name alone rather than inventing an initial', () => {
    expect(publicPatientName('Lakshmi')).toBe('Lakshmi');
  });

  it('survives the messy input a front desk actually types', () => {
    expect(publicPatientName('  Sanjay   gupta  ')).toBe('Sanjay G.');
    expect(publicPatientName('')).toBe('');
    expect(publicPatientName('   ')).toBe('');
  });

  it('never returns the surname in full', () => {
    for (const name of ['Kavita Sharma', 'Farida Sheikh Khan', 'A B']) {
      const surname = name.trim().split(/\s+/).slice(1).join(' ');
      if (surname.length > 1) expect(publicPatientName(name)).not.toContain(surname);
    }
  });
});
