import Link from 'next/link';
import { pageWindow } from '@/lib/pagination';
import { IconChevronRight } from './icons';

/**
 * Numbered page links with previous and next — the app's first pagination.
 *
 * LINKS, not buttons with click handlers. Each page is its own URL, so the
 * browser's Back walks from page 4 to page 3, a refresh stays on page 4, a page
 * can be opened in a new tab or sent to somebody, and a patient record opened
 * from page 4 comes back to page 4. The caller says how a page number becomes
 * a URL; this only draws them.
 *
 * Accessibility, in the conventional shape so a screen reader announces it the
 * way it announces every other site's pagination:
 *   - a `<nav>` with its own label, so it is a landmark distinct from the rail
 *   - `aria-current="page"` on the page being shown, which is text, not a link
 *     to itself
 *   - every link labelled with the page it goes to ("Page 5"), since a bare "5"
 *     means nothing out of context
 *   - previous and next at the ends are present but disabled, rather than
 *     removed — removing them would move every other item in the bar
 *   - the gaps are `aria-hidden`: "…" read aloud is noise
 *
 * Every item has a fixed minimum width with tabular digits, so "9" and "10"
 * occupy the same space and paging never shifts the bar — see `pageWindow` for
 * the other half of that.
 *
 * Renders nothing for a single page: one page is not a choice.
 */
export function Pagination({
  page,
  totalPages,
  hrefFor,
  label = 'Pages',
}: {
  page: number;
  totalPages: number;
  hrefFor: (page: number) => string;
  label?: string;
}) {
  if (totalPages <= 1) return null;

  const items = pageWindow(page, totalPages);
  const cell =
    'inline-flex h-9 min-w-9 items-center justify-center rounded-tiny px-2 text-[13.5px] font-semibold tabular-nums';
  const link = `${cell} border border-ink/10 bg-white text-ink transition-colors hover:border-ink/25 hover:bg-bg-soft`;
  const disabled = `${cell} border border-ink/8 bg-bg-soft text-ink-20`;

  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap items-center gap-1.5">
        <li>
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className={link} aria-label="Previous page">
              <span className="inline-flex rotate-180">
                <IconChevronRight size={14} />
              </span>
            </Link>
          ) : (
            <span className={disabled} aria-label="Previous page" aria-disabled="true">
              <span className="inline-flex rotate-180">
                <IconChevronRight size={14} />
              </span>
            </span>
          )}
        </li>

        {items.map((item, i) =>
          item === 'gap' ? (
            <li key={`gap-${i}`} aria-hidden="true" className={`${cell} text-ink-40`}>
              …
            </li>
          ) : (
            <li key={item}>
              {item === page ? (
                <span
                  aria-current="page"
                  aria-label={`Page ${item}`}
                  className={`${cell} bg-[var(--role)] text-white`}
                >
                  {item}
                </span>
              ) : (
                <Link href={hrefFor(item)} className={link} aria-label={`Page ${item}`}>
                  {item}
                </Link>
              )}
            </li>
          ),
        )}

        <li>
          {page < totalPages ? (
            <Link href={hrefFor(page + 1)} className={link} aria-label="Next page">
              <IconChevronRight size={14} />
            </Link>
          ) : (
            <span className={disabled} aria-label="Next page" aria-disabled="true">
              <IconChevronRight size={14} />
            </span>
          )}
        </li>
      </ul>
    </nav>
  );
}
