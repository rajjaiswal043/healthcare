/**
 * Which page numbers the bar shows.
 *
 * Every expected window below is written out by hand. The property worth the
 * most is the constant width: a bar whose item count changes as you page moves
 * the Next button out from under the pointer.
 */

import { describe, expect, it } from 'vitest';
import { pageCount, pageFromQuery, pageWindow } from './pagination.js';

describe('the page window', () => {
  it('shows every page when there are few enough', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(4, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('shows nothing when there are no pages', () => {
    expect(pageWindow(1, 0)).toEqual([]);
  });

  it('puts the current page in the middle, with gaps either side', () => {
    expect(pageWindow(6, 100)).toEqual([1, 'gap', 4, 5, 6, 7, 8, 'gap', 100]);
    expect(pageWindow(50, 100)).toEqual([1, 'gap', 48, 49, 50, 51, 52, 'gap', 100]);
  });

  it('fills the start with real pages instead of a gap', () => {
    expect(pageWindow(1, 100)).toEqual([1, 2, 3, 4, 5, 6, 7, 'gap', 100]);
    expect(pageWindow(5, 100)).toEqual([1, 2, 3, 4, 5, 6, 7, 'gap', 100]);
  });

  it('fills the end the same way', () => {
    expect(pageWindow(100, 100)).toEqual([1, 'gap', 94, 95, 96, 97, 98, 99, 100]);
    expect(pageWindow(96, 100)).toEqual([1, 'gap', 94, 95, 96, 97, 98, 99, 100]);
  });

  /** The property the fill exists for. */
  it('keeps the same number of items on every page, so nothing shifts', () => {
    for (const total of [10, 11, 25, 100, 1234]) {
      const widths = new Set(
        Array.from({ length: total }, (_, i) => pageWindow(i + 1, total).length),
      );
      expect([...widths], `total ${total}`).toEqual([9]);
    }
  });

  it('always includes the first page, the last page and the current one', () => {
    for (let current = 1; current <= 60; current++) {
      const items = pageWindow(current, 60);
      expect(items[0]).toBe(1);
      expect(items[items.length - 1]).toBe(60);
      expect(items).toContain(current);
    }
  });

  it('never uses a gap to hide a single page', () => {
    for (const total of [10, 11, 12, 100]) {
      for (let current = 1; current <= total; current++) {
        const items = pageWindow(current, total);
        items.forEach((item, i) => {
          if (item !== 'gap') return;
          const before = items[i - 1] as number;
          const after = items[i + 1] as number;
          expect(after - before, `page ${current} of ${total}`).toBeGreaterThan(2);
        });
      }
    }
  });

  it('clamps a current page outside the range', () => {
    expect(pageWindow(0, 5)).toEqual(pageWindow(1, 5));
    expect(pageWindow(99, 5)).toEqual(pageWindow(5, 5));
  });
});

describe('page counts', () => {
  it('rounds up, and zero patients is zero pages', () => {
    expect(pageCount(0, 30)).toBe(0);
    expect(pageCount(1, 30)).toBe(1);
    expect(pageCount(30, 30)).toBe(1);
    expect(pageCount(31, 30)).toBe(2);
    expect(pageCount(242, 30)).toBe(9);
  });
});

describe('reading the page from the URL', () => {
  it('reads a positive whole number', () => {
    expect(pageFromQuery('1')).toBe(1);
    expect(pageFromQuery('4')).toBe(4);
  });

  /** A typo in the address bar gets page 1, not the API's 400. */
  it('turns anything else into page 1', () => {
    for (const value of [null, undefined, '', '0', '-2', 'abc', '2.5', '1e3', ' 3']) {
      expect(pageFromQuery(value), String(value)).toBe(1);
    }
  });
});
