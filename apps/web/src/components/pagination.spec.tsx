/**
 * The pagination bar — what it renders, and what a screen reader hears.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Pagination } from './pagination';

const hrefFor = (page: number) => `/list?page=${page}`;

/**
 * Where the link with this accessible label goes, or null if there is no such
 * LINK (a disabled control is a span, and has no href).
 *
 * Reads each opening `<a>` tag whole rather than matching attributes in a fixed
 * order: React writes them in whatever order it likes, and a pattern that
 * assumed `href` came first silently matched nothing — which made every
 * "is not a link" assertion pass whether or not it was true.
 */
function linkFor(html: string, label: string): string | null {
  for (const tag of html.match(/<a\b[^>]*>/g) ?? []) {
    if (tag.includes(`aria-label="${label}"`)) return tag.match(/href="([^"]*)"/)?.[1] ?? null;
  }
  return null;
}
const render = (page: number, totalPages: number) =>
  renderToStaticMarkup(
    <Pagination page={page} totalPages={totalPages} hrefFor={hrefFor} label="Test pages" />,
  );

describe('the pagination bar', () => {
  it('is a labelled navigation landmark', () => {
    expect(render(2, 5)).toMatch(/<nav aria-label="Test pages">/);
  });

  it('renders nothing for a single page', () => {
    expect(render(1, 1)).toBe('');
    expect(render(1, 0)).toBe('');
  });

  /**
   * The current page is announced as current and is NOT a link — a link to the
   * page you are already on is a click that does nothing.
   */
  it('marks the current page, and does not link to it', () => {
    const html = render(3, 5);

    expect(html).toMatch(/<span aria-current="page" aria-label="Page 3"[^>]*>3<\/span>/);
    expect(html).not.toContain('href="/list?page=3"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('labels every page link with the page it goes to', () => {
    const html = render(3, 5);
    for (const n of [1, 2, 4, 5]) {
      expect(linkFor(html, `Page ${n}`)).toBe(`/list?page=${n}`);
    }
    expect(linkFor(html, 'Page 3')).toBeNull();
  });

  it('links previous and next to the neighbouring pages', () => {
    const html = render(3, 5);
    expect(linkFor(html, 'Previous page')).toBe('/list?page=2');
    expect(linkFor(html, 'Next page')).toBe('/list?page=4');
  });

  /**
   * Disabled rather than removed at the ends. Removing them would move every
   * other item in the bar, and a disabled control still tells a screen reader
   * where the edges are.
   */
  it('keeps previous and next at the ends, disabled rather than gone', () => {
    const first = render(1, 5);
    expect(first).toMatch(/aria-label="Previous page" aria-disabled="true"/);
    expect(linkFor(first, 'Previous page')).toBeNull();
    expect(linkFor(first, 'Next page')).toBe('/list?page=2');

    const last = render(5, 5);
    expect(last).toMatch(/aria-label="Next page" aria-disabled="true"/);
    expect(linkFor(last, 'Next page')).toBeNull();
    expect(linkFor(last, 'Previous page')).toBe('/list?page=4');
  });

  it('hides the gaps from screen readers', () => {
    const html = render(50, 100);
    const gaps = html.match(/<li aria-hidden="true"[^>]*>…<\/li>/g);
    expect(gaps).toHaveLength(2);
  });

  it('shows the windowed page numbers, not all of them', () => {
    const html = render(50, 100);
    for (const n of [1, 48, 49, 51, 52, 100]) expect(html).toContain(`aria-label="Page ${n}"`);
    for (const n of [2, 47, 53, 99]) expect(html).not.toContain(`aria-label="Page ${n}"`);
  });
});
