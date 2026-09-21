/**
 * Which page numbers a pagination bar shows.
 *
 * All of them is fine for nine pages and impossible for a hundred, so the bar
 * shows a window: the first page, the last page, the current page with a few
 * either side, and a gap marker wherever pages are left out —
 *
 *     ‹  1  …  4  5  [6]  7  8  …  100  ›
 *
 * **The number of items is constant once there are enough pages**, and that is
 * a deliberate property rather than a side effect. The naive window — first,
 * last, current ± 2 — has fewer items near the ends than in the middle, so the
 * bar grows and shrinks as you page and the Next button walks sideways under
 * the pointer. Near either end this fills the missing slots with more real
 * pages instead, so every position in the bar holds still.
 *
 * A gap never stands in for a single page. "1 … 3" hides nothing a "2" would
 * not show in the same space; every gap here covers at least two pages.
 */

export type PageItem = number | 'gap';

/**
 * @param current  the page being shown, 1-based; clamped into range
 * @param total    how many pages there are
 * @param siblings pages shown either side of the current one
 */
export function pageWindow(current: number, total: number, siblings = 2): PageItem[] {
  if (total <= 0) return [];

  const page = Math.min(Math.max(Math.trunc(current), 1), total);

  // first + gap + siblings + current + siblings + gap + last
  const slots = siblings * 2 + 5;

  if (total <= slots) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  // Close to the start: fill the left with real pages rather than a gap.
  if (page <= siblings + 3) {
    return [...range(1, slots - 2), 'gap', total];
  }

  // Close to the end: the mirror image.
  if (page >= total - (siblings + 2)) {
    return [1, 'gap', ...range(total - (slots - 3), total)];
  }

  return [1, 'gap', ...range(page - siblings, page + siblings), 'gap', total];
}

/** How many pages `total` items fill at `pageSize` a page. Zero items is zero pages. */
export function pageCount(total: number, pageSize: number): number {
  if (total <= 0 || pageSize <= 0) return 0;
  return Math.ceil(total / pageSize);
}

/**
 * The page asked for in a URL, as a number the API will accept.
 *
 * Whatever the address bar says — `?page=abc`, `?page=0`, `?page=2.5`, nothing
 * at all — becomes a positive whole number. A malformed page is somebody's
 * typo, and showing them page 1 is a better answer than the API's 400.
 */
export function pageFromQuery(value: string | null | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}
