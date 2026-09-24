'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A scene fixed behind the whole page, that the page scrolls over.
 *
 * Content sits on translucent panels, so this shows through as you move down:
 * two soft fields of the clinical palette drift at a slower speed than the
 * page (parallax), and a single long pulse trace draws itself across the
 * screen in step with how far you have read. Scroll back up and it undraws.
 *
 * Calm on purpose. It is used on a hospital's front page, so there is no loop
 * and nothing moves unless the reader does. Scroll progress is written to one
 * CSS variable on this element (never React state), so scrolling never
 * re-renders anything. With reduced motion the trace is simply drawn and the
 * fields stay put.
 */
export function ScrollScene() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.style.setProperty('--p', '1');
      return;
    }

    let raf = 0;
    const update = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      el.style.setProperty('--p', p.toFixed(4));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-20 overflow-hidden bg-bg"
      style={{ ['--p' as string]: 0 }}
    >
      {/* Colour fields, drifting slower than the page. */}
      <div
        className="absolute -right-[12%] -top-[18%] h-[70vh] w-[62vw] rounded-full bg-clinical-soft/80 blur-[90px]"
        style={{ transform: 'translate3d(0, calc(var(--p) * 38vh), 0)' }}
      />
      <div
        className="absolute -left-[14%] top-[40%] h-[60vh] w-[50vw] rounded-full bg-amber-soft/70 blur-[100px]"
        style={{ transform: 'translate3d(calc(var(--p) * 16vw), calc(var(--p) * -30vh), 0)' }}
      />
      <div
        className="absolute bottom-[-30%] right-[8%] h-[55vh] w-[44vw] rounded-full bg-coral-soft/50 blur-[110px]"
        style={{ opacity: 'calc(var(--p) * 1.2)' }}
      />

      {/* The pulse: one long ECG trace, drawn as far as you have scrolled. */}
      <svg
        className="absolute inset-x-0 top-[56%] h-[26vh] w-full"
        viewBox="0 0 1600 200"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          d="M0 120h260l22-36 26 78 30-150 30 170 22-62h180l14-22 16 22h240l22-36 26 78 30-150 30 170 22-62h180l14-22 16 22h340"
          stroke="#0F766E"
          strokeOpacity="0.16"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          style={{ strokeDasharray: 1, strokeDashoffset: 'calc(1 - var(--p))' }}
        />
      </svg>

      {/* Paper grain, so the flat colour reads as a surface and not a screen. */}
      <div
        className="absolute inset-0 opacity-[0.35] mix-blend-multiply"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .35 0 0 0 0 .3 0 0 0 0 .22 0 0 0 .09 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  );
}

/**
 * A rail of dashes on the right edge, one per section: the current one is
 * long and teal, the rest short. Each is a real link, so it is also a way to
 * jump around — with the section's name as a label on hover and to screen
 * readers. Hidden below `lg`, where the right edge belongs to the content.
 */
export function SectionRail({
  sections,
}: {
  sections: ReadonlyArray<{ id: string; label: string }>;
}) {
  const [active, setActive] = useState(sections[0]?.id ?? '');

  useEffect(() => {
    // The current section is the last one whose top has passed the middle of
    // the screen. Worked out from positions on every (rAF-throttled) scroll
    // rather than with an IntersectionObserver: a jump — a rail click, Page
    // Down, the End key — can skip a section entirely, and an observer only
    // ever hears about the ones it saw cross.
    let raf = 0;
    const update = () => {
      raf = 0;
      const mid = window.innerHeight / 2;
      let current = sections[0]?.id ?? '';
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= mid) current = s.id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [sections]);

  const index = sections.findIndex((s) => s.id === active);

  return (
    <nav
      aria-label="Sections"
      className="fixed right-5 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-end gap-1 lg:flex"
    >
      <span className="mb-2 font-mono text-[10.5px] font-semibold tracking-label text-ink-40">
        {String(index + 1).padStart(2, '0')}
        <span className="text-ink-20"> / {String(sections.length).padStart(2, '0')}</span>
      </span>
      {sections.map((s) => {
        const on = s.id === active;
        return (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-label={s.label}
            aria-current={on ? 'true' : undefined}
            className="group flex h-5 items-center gap-3"
          >
            <span className="whitespace-nowrap rounded-pill bg-ink px-2 py-0.5 text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              {s.label}
            </span>
            <span
              className={`h-[2px] rounded-full transition-all duration-300 ${
                on ? 'w-7 bg-clinical' : 'w-3.5 bg-ink/25 group-hover:w-5 group-hover:bg-ink/50'
              }`}
            />
          </a>
        );
      })}
    </nav>
  );
}
