'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Puts a printable document directly under `<body>`, so printing it can hide
 * literally everything else.
 *
 * WHY A PORTAL RATHER THAN JUST CSS
 *
 * The print stylesheet used to hide `nav`, `aside`, `header[data-app-shell]` and
 * `.no-print`, then reveal `.print-only`. That is a list, and a list is wrong
 * the moment a page renders something not on it — which is exactly what
 * happened: a page's own content lives inside `<main>`, which was on no list, so
 * the queue board printed straight through the receipt on the same sheet. The
 * prescription escaped only because that one page happened to wrap its own
 * markup in `.no-print`, which is a convention every future page would have had
 * to remember.
 *
 * Hiding by CSS alone is also awkward when the document is nested: `display:
 * none` on an ancestor cannot be undone by a descendant, and the
 * `visibility: hidden` trick that can leaves the document sitting wherever it
 * happened to be in the flow — inside a `fixed` modal, in the payment dialog's
 * case — which prints blank pages before it.
 *
 * Moving the document to `<body>` removes both problems. It becomes a sibling of
 * the app rather than a descendant, so the rule is `hide every body child except
 * this one` — no enumeration, no positioning, and nothing for a new page to
 * remember.
 *
 * Mounted-guarded because `document` does not exist while Next renders on the
 * server; the first client paint fills it in.
 */
export function PrintPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return createPortal(
    // `hidden` keeps it off the screen; the print stylesheet is the only thing
    // that reveals it. `data-print-document` is what that stylesheet keys on.
    <div data-print-document className="print-only hidden">
      {children}
    </div>,
    document.body,
  );
}
