'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './auth-provider';
import { ClinicLogo } from './clinic-logo';
import { initialsOf } from '@/lib/role-signature';
import { breadcrumbFor } from '@/lib/breadcrumbs';
import { recordNavigation } from '@/lib/navigation-history';
import {
  IconCalendar,
  IconChevronRight,
  IconClock,
  IconIdCard,
  IconStethoscope,
  IconHome,
  IconKey,
  IconLogout,
  IconMenu,
  IconPanelLeft,
  IconPulse,
  IconReceipt,
  IconSearch,
  IconShield,
  IconUserPlus,
  IconUsers,
  IconX,
} from './icons';

interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  /** Hidden entirely when the signed-in user lacks this. */
  permission?: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    title: 'Front desk',
    items: [
      { key: 'home', label: 'Home', href: '/', icon: <IconHome size={16} /> },
      {
        key: 'queue',
        label: "Today's queue",
        href: '/queue',
        icon: <IconClock size={16} />,
        permission: 'appointment:read',
      },
      {
        key: 'book',
        label: 'Book',
        href: '/appointments/new',
        icon: <IconCalendar size={16} />,
        permission: 'appointment:write',
      },
      {
        // docs/10. Who is due back, who came back, whose pain is rising.
        key: 'follow-ups',
        label: 'Follow-ups',
        href: '/follow-ups',
        icon: <IconPulse size={16} />,
        permission: 'followup:read',
      },
    ],
  },
  {
    title: 'Patients',
    items: [
      {
        key: 'patients',
        label: 'Find a patient',
        href: '/patients',
        icon: <IconUsers size={16} />,
        permission: 'patient:read',
      },
      {
        key: 'all-patients',
        label: 'All patients',
        href: '/patients/all',
        icon: <IconClock size={16} />,
        // Same permission as search: both are reads of the patient list, and a
        // role that may search it may page through it.
        permission: 'patient:read',
      },
      {
        key: 'register',
        label: 'Register',
        href: '/patients/register',
        icon: <IconUserPlus size={16} />,
        permission: 'patient:write',
      },
    ],
  },
  {
    title: 'Billing',
    items: [
      {
        key: 'finance',
        label: 'Finance desk',
        href: '/finance',
        icon: <IconReceipt size={16} />,
        // Whoever takes the money. Finance holds this; so does the front desk in
        // a clinic where one person still does both, which is the point of the
        // roles screen.
        permission: 'payment:collect',
      },
      {
        key: 'finance-report',
        label: 'Finance report',
        href: '/reports/finance',
        icon: <IconReceipt size={16} />,
        // Same permission as the collections page, and the same reason: this
        // is the screen that says what the clinic earned.
        permission: 'report:revenue',
      },
      {
        key: 'collections',
        label: 'Collections',
        href: '/reports/collections',
        icon: <IconReceipt size={16} />,
        // Owners and administrators only. The front desk takes the money; it
        // does not need the day's revenue on a screen anyone can walk past.
        permission: 'report:revenue',
      },
    ],
  },
  {
    title: 'Diagnostics',
    items: [
      {
        key: 'diagnostics',
        label: 'Tests to do',
        href: '/diagnostics',
        icon: <IconStethoscope size={16} />,
        // Everyone clinical can read the list; only Diagnostics and the
        // administrator can attach a result, and the screen adapts.
        permission: 'diagnostic:read',
      },
    ],
  },
  {
    title: 'Settings',
    items: [
      {
        key: 'staff',
        label: 'Staff',
        href: '/settings/users',
        icon: <IconUsers size={16} />,
        permission: 'user:manage',
      },
      {
        key: 'roles',
        label: 'Roles and permissions',
        icon: <IconShield size={16} />,
        href: '/settings/roles',
        // Sits next to Staff on purpose: adding someone and deciding what they
        // may do are the same job, two screens apart.
        permission: 'role:manage',
      },
      {
        key: 'prices',
        label: 'Prices',
        href: '/settings/prices',
        icon: <IconReceipt size={16} />,
        // The administrator owns what things cost. Finance applies the prices;
        // it does not set them.
        permission: 'tenant:configure',
      },
      {
        key: 'promotions',
        label: 'Promotions',
        href: '/settings/promotions',
        icon: <IconReceipt size={16} />,
        // The administrator DEFINES a discount; the finance desk and the front
        // desk APPLY one. Gated on the defining half, so neither desk sees
        // this screen.
        permission: 'promotion:manage',
      },
      {
        key: 'doctors',
        label: 'Doctors and hours',
        href: '/settings/doctors',
        icon: <IconCalendar size={16} />,
        // A doctor's hours and fees are a clinic setting, not a booking action.
        permission: 'schedule:manage',
      },
      {
        key: 'displays',
        label: 'Waiting-room screens',
        href: '/settings/displays',
        icon: <IconClock size={16} />,
        // Pairing mints a credential that works without a login.
        permission: 'display:manage',
      },
      {
        key: 'patient-ids',
        label: 'Patient IDs',
        href: '/settings/patient-ids',
        icon: <IconIdCard size={16} />,
        // FR-UID-02. Read-only here: changing the format is the platform's job
        // (decision D3), so this answers "what do our patient numbers look
        // like?" without offering a control the clinic cannot use.
        permission: 'tenant:configure',
      },
      {
        key: 'branding',
        label: 'Branding',
        href: '/settings/branding',
        icon: <IconIdCard size={16} />,
        // The clinic's identity across the whole console — same permission as
        // the rest of "what this clinic is", not a separate one.
        permission: 'tenant:configure',
      },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { session, loading, can, signOut, signature } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const [collapsed, setCollapsed] = useState(false);
  /**
   * Collapsed rail, temporarily opened because the pointer (or keyboard focus)
   * is inside it. Only ever true while `collapsed` is — expanding the rail for
   * real clears it, so the two can never disagree about what the user sees.
   */
  const [peeking, setPeeking] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Ctrl/Cmd-K to search — muscle memory for anyone who has used a CRM.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setMobileOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  useEffect(() => setMobileOpen(false), [pathname]);

  // Every route the shell renders, so a Back button can tell "there is an
  // in-app page behind this one" from "this tab was opened here directly".
  // See navigation-history.ts.
  useEffect(() => recordNavigation(pathname), [pathname]);

  // The auth provider redirects to /login; render nothing rather than a flash of
  // empty chrome.
  if (loading || !session) return null;

  const visible = SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((i) => !i.permission || can(i.permission)),
  })).filter((s) => s.items.length > 0);

  /**
   * Which nav item is lit, resolved once for the whole rail.
   *
   * It was `pathname.startsWith(item.href)` evaluated per item, which lights
   * every ANCESTOR route as well as the current one: on /patients/register both
   * "Register" and "Find a patient" matched, so the rail claimed you were in two
   * places at once. A prefix test also matched a route that merely begins with
   * the same characters, so /patients-archive would have lit /patients too.
   *
   * The rule is: only routes that contain this path count — the same path, or a
   * path below it at a `/` boundary — and among those, the MOST SPECIFIC wins.
   * "/" is exempt from the boundary rule because every path is below it; it
   * matches only itself.
   */
  const activeHref = mostSpecificMatch(
    pathname,
    visible.flatMap((s) => s.items.map((i) => i.href)),
  );

  /**
   * The rail's VISUAL state, as against `collapsed`, which is the user's
   * setting. Everything inside the rail asks this one — labels, section
   * headings, the Collapse button's own text — so a peek looks exactly like an
   * expanded rail rather than a third, half-dressed state.
   *
   * What does NOT ask this is anything that reserves space: the footprint in
   * the flex row and the header's offset both follow `collapsed`, which is why
   * a peek flies out OVER the page instead of shoving it 204px sideways.
   */
  const railOpen = !collapsed || peeking;

  const initials = initialsOf(session.fullName);
  /**
   * The clinic's name is the last resort, and `breadcrumbs.spec.ts` is what
   * makes sure it is never reached: every route folder must have an entry. It
   * used to be reached by five screens, which read as "Ram Hospital › Ram
   * Hospital" and looked deliberate enough that nobody reported it for months.
   */
  const crumb = breadcrumbFor(pathname) ?? session.tenant.name;

  return (
    /**
     * `data-role` is the whole mechanism: it selects the --role custom
     * properties in globals.css, and everything below asks for those rather than
     * knowing anything about personas. An unrecognised role sets no attribute
     * and inherits the house teal.
     */
    <div
      className="flex min-h-screen bg-bg"
      {...(signature.key ? { 'data-role': signature.key } : {})}
    >
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      {/* The rail's FOOTPRINT, and nothing else — no background, no content.
          The rail proper is `fixed`, so without this the flex row would not
          know it is there and the page would run underneath it.

          Splitting the footprint from the rail is what makes the hover peek
          possible: this follows `collapsed`, the rail follows `railOpen`, and
          the 204px difference between them is the flyout. Were the rail itself
          holding the column, every peek would shove the page sideways. */}
      <div
        aria-hidden="true"
        className={[
          'hidden shrink-0 transition-[width] duration-200 lg:block',
          collapsed ? 'lg:w-[76px]' : 'lg:w-[280px]',
        ].join(' ')}
      />

      {/* The rail is where the persona lives: white at the top fading into the
          role's palest tint, so the colour is present without the nav becoming a
          block of it.

          Three parts, each `shrink-0` except the middle: the mark, the nav, and
          the Collapse button. Only the nav scrolls — which is the whole point,
          because a scroll container that also holds the mark and the button
          cannot pin either of them. */}
      <aside
        onMouseEnter={() => collapsed && setPeeking(true)}
        onMouseLeave={() => setPeeking(false)}
        // The keyboard half. Tabbing into a collapsed rail opens it for the
        // same reason hovering does — otherwise the labels are unreachable to
        // anyone not using a pointer. `relatedTarget` is where focus is GOING;
        // if that is still inside the rail the peek must survive.
        onFocus={() => collapsed && setPeeking(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPeeking(false);
        }}
        className={[
          // No padding and no `overflow` here: each of the three parts owns its
          // own padding, and scrolling belongs to the nav alone.
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-ink/8 bg-gradient-to-b from-white to-[var(--role-tint)] shadow-rail transition-[width,transform] duration-200 lg:translate-x-0',
          // Below lg the rail is a drawer over the page; on lg it is pinned to
          // the viewport. `fixed` rather than the `sticky` this used to be,
          // because sticky only works for an element that holds its own column
          // — and the whole flyout depends on the rail NOT holding one. The
          // spacer above does that instead.
          'lg:top-0 lg:h-screen',
          // `railOpen`, not `collapsed`: this is the only width in the file
          // that reflects a peek, and the difference between it and the
          // spacer's width is what overhangs the page.
          railOpen ? 'lg:w-[280px]' : 'lg:w-[76px]',
          // Mobile keeps 236: the drawer sits OVER the page, so its width is
          // bounded by the phone rather than by how much room the labels want.
          mobileOpen ? 'w-[236px] translate-x-0' : 'w-[236px] -translate-x-full',
        ].join(' ')}
      >
        {/* Part 1 of 3: the mark. `shrink-0` and outside the scroll container,
            so it holds the top of the rail however far the nav is scrolled —
            the same arrangement as the Collapse button at the other end.

            Centred, and the close button taken out of the flow to keep it that
            way: with `justify-between` the mark sat wherever the button's
            presence left it, which moved it between the mobile drawer and the
            desktop rail. Absolute positioning is what makes "centred" mean
            centred in the rail rather than centred in whatever is left.

            `border-b` is the separator between the pinned mark and the
            scrolling list, matching the one above Collapse. Between them they
            say which part of the rail moves. */}
        <div className="relative flex shrink-0 items-center justify-center border-b border-ink/8 px-3 py-4">
          <Link href="/" className="flex items-center" aria-label="Home">
            {/* The mark only. The name is written once, in the header, where
                there is room for it — a real hospital name ("Dr Vivek Swarnkar
                Ortho Clinic") truncates in a 280px rail no matter what, and at
                76px there is no rail to write it in at all. */}
            <ClinicLogo clinic={session.tenant} size={32} alt={session.tenant.name} />
          </Link>
          <button
            type="button"
            className="btn-ghost absolute right-3 !px-1.5 !py-1.5 lg:hidden"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
          >
            <IconX size={17} />
          </button>
        </div>

        {/* The only scrolling part of the rail.
            `min-h-0` is not decoration — a flex child defaults to
            `min-height: auto`, which means it refuses to shrink below its
            content. Without it this nav would grow to its natural height, push
            the Collapse footer off the bottom of the rail, and never scroll.
            `flex-1` then takes exactly the space the two fixed rows leave. */}
        <nav
          // `overflow-x-hidden` is explicit because it would not otherwise be
          // what it looks like: a box with `overflow-y: auto` and `overflow-x:
          // visible` computes the visible axis to `auto` as well, so the nav
          // would quietly gain a horizontal scrollbar the moment a nowrap
          // label overhung the collapsed rail.
          //
          // `overscroll-contain` stops the wheel from chaining to the page when
          // the list hits either end — which is what made scrolling over the
          // rail feel like it picked a target at random.
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-quiet px-3 py-4"
          aria-label="Main"
        >
          {visible.map((section) => (
            <div key={section.title} className="flex flex-col gap-1">
              {/* Always rendered, and only ever made invisible.
                  Dropping it from the tree when collapsed took its height with
                  it, so every section below moved the instant the rail
                  collapsed and moved back on expand — items jumped under the
                  cursor. `invisible` is `visibility: hidden`: it keeps the box,
                  and takes the text out of the accessibility tree too, which is
                  right when the rail is showing no labels.

                  `truncate` is the other half, and keeping the box was not
                  enough without it: at 76px "Waiting-room screens" wrapped to
                  two lines, so the invisible heading was 16px TALLER than the
                  visible one and the jump survived in the other direction. One
                  line in both states is what actually makes the two identical. */}
              <p
                className={['mono-label truncate px-2.5 pb-1', railOpen ? '' : 'invisible'].join(
                  ' ',
                )}
              >
                {section.title}
              </p>
              {section.items.map((item) => {
                const active = item.href === activeHref;
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    // Only while the label is genuinely absent. During a peek
                    // the label is right there, and a tooltip repeating it is
                    // what made the hover state look doubled up.
                    title={railOpen ? undefined : item.label}
                    className={[
                      'group relative flex items-center gap-2.5 rounded-panel border px-2.5 py-2 transition-all',
                      // Closed, the row IS the icon: a 51px-wide tinted box
                      // drawn around a 32px tinted tile is a box inside a box,
                      // and the 3px marker has nowhere to sit but on top of the
                      // tile's own corner. With a label beside it there is a row
                      // to fill and the tint reads as one; without one there is
                      // nothing for it to fill.
                      //
                      // The same is true of hover, and that is the other half of
                      // this: `hover:bg-white` drew a white card around the tile
                      // and the tile's own `group-hover` tint drew a second
                      // shape inside it, so a hover on a closed rail rendered as
                      // two mismatched rectangles. Closed, the tile alone does
                      // both jobs; open, the row does.
                      !railOpen
                        ? 'border-transparent ' +
                          (active ? 'text-[var(--role-text)]' : 'text-ink-60')
                        : active
                          ? 'border-[color-mix(in_srgb,var(--role)_20%,transparent)] bg-[var(--role-soft)] text-[var(--role-text)]'
                          : 'border-transparent text-ink-60 hover:border-ink/10 hover:bg-white',
                    ].join(' ')}
                  >
                    {active && railOpen && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1/2 h-[55%] w-[3px] -translate-y-1/2 rounded-pill bg-[var(--role)]"
                      />
                    )}
                    <span
                      className={[
                        'grid h-8 w-8 shrink-0 place-items-center rounded-tiny transition-colors',
                        active
                          ? 'bg-[var(--role)] text-white'
                          : 'bg-ink/5 text-ink-40 group-hover:bg-[var(--role-soft)] group-hover:text-[var(--role-text)]',
                      ].join(' ')}
                    >
                      {item.icon}
                    </span>
                    {railOpen && (
                      <span className="whitespace-nowrap text-[13.5px] font-semibold">
                        {item.label}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Outside the scroll container, so it holds the bottom of the rail
            whatever the nav is doing. `border-t` is the second of the two
            separators: it marks where scrolling content ends and the fixed
            control begins, which is the only cue that the list above can move
            at all once the scrollbar has faded out. `mt-auto` is gone — the nav
            above is `flex-1` and already takes the slack. */}
        <div className="hidden shrink-0 border-t border-ink/8 px-3 py-3 lg:block">
          <button
            type="button"
            className="btn-ghost w-full !justify-start !px-2.5 text-[12.5px]"
            onClick={() => {
              setCollapsed((c) => !c);
              setPeeking(false);
            }}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={railOpen ? undefined : 'Expand sidebar'}
          >
            <IconPanelLeft size={16} />
            {railOpen && <span className="whitespace-nowrap">Collapse</span>}
          </button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      {/* `pt-[61px]` is the 3px role strip plus the 58px header, both `fixed`
          and therefore out of the flow. It is the padding that keeps the first
          line of every page below the header instead of behind it. */}
      <div className="flex min-w-0 flex-1 flex-col pt-[61px]">
        {/* The peripheral signal. Three pixels, full width, directly above the
            content — the thing you register from across a desk without reading
            anything on the screen. */}
        <div
          aria-hidden="true"
          className={[
            'no-print fixed inset-x-0 top-0 z-30 h-[3px] bg-[var(--role)] transition-[left] duration-200',
            // Follows `collapsed`, never `railOpen`: the chrome holds still
            // while the rail peeks out over it, which is what makes a peek read
            // as a flyout rather than as the whole layout twitching.
            collapsed ? 'lg:left-[76px]' : 'lg:left-[280px]',
          ].join(' ')}
        />

        {/* `data-app-shell` is what the print stylesheet hides. It cannot key
            on the tag alone: the printed prescription has its own <header>
            carrying the clinic letterhead, and a bare `header` rule would
            hide that too. The attribute went missing from this element at
            some point, so the selector matched nothing and the search box and
            account menu printed at the top of every prescription. */}
        <header
          data-app-shell
          className={[
            /* Fixed, not sticky: the header holds the viewport's top edge for
               the life of the page rather than only once the page has scrolled
               to it. `top-[3px]` sits it directly under the role strip.

               z-30 is deliberate and sits BELOW the mobile drawer's backdrop
               (z-40) and the rail itself (z-50), so opening the menu on a phone
               dims the header instead of leaving it lit above the scrim — and
               on a desktop peek, the rail flies out OVER the header's left
               edge rather than under it. Dialogs are z-[60] and clear all. */
            'fixed inset-x-0 top-[3px] z-30 flex h-[58px] items-center gap-3 border-b border-ink/8 bg-white/85 px-4 backdrop-blur-md transition-[left] duration-200 sm:px-6',
            collapsed ? 'lg:left-[76px]' : 'lg:left-[280px]',
          ].join(' ')}
        >
          <button
            type="button"
            className="btn-ghost !px-1.5 !py-1.5 lg:hidden"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
          >
            <IconMenu size={18} />
          </button>

          {/* The clinic's name gets the space it needs, and the crumb after it
              yields first.

              It used to be capped at 22 characters with the search box centred
              beside it, which cut "Sunrise Multispeciality Hospital" in half —
              and the one thing this header exists to say, after
              white-labelling, is whose clinic this is. So: the name does not
              shrink, the crumb does, and the search box has moved off centre to
              sit beside the account menu. The 40ch cap is a backstop for a
              genuinely absurd name, not the normal case.

              Set in the display face at 17px extrabold — the weight the nav
              rail's wordmark used to carry. As a 10.5px mono label it was
              technically present and practically invisible, which is not what
              a clinic's own name should be on their own console.

              The mark sits in its own cell over the rail, not against this, so
              this line's position is unchanged from before the logo moved. */}
          <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 sm:flex">
            <Link
              href="/"
              title={session.tenant.name}
              className="max-w-[40ch] shrink-0 truncate font-display text-[17px] font-extrabold tracking-display text-ink transition-colors hover:text-clinical-text"
            >
              {session.tenant.name}
            </Link>
            <span className="shrink-0 text-ink-20" aria-hidden="true">
              <IconChevronRight size={13} />
            </span>
            {/* Stepped back to ink-40 now that the clinic's name is the heavy
                thing beside it. Two bold items at the same weight is not a
                hierarchy, and the name is the one that should win. */}
            <span className="truncate text-[13.5px] font-semibold text-ink-40">{crumb}</span>
          </nav>

          <div className="ml-auto w-full min-w-[150px] max-w-[300px]">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const q = query.trim();
                if (q) router.push(`/patients?q=${encodeURIComponent(q)}`);
              }}
              className="relative flex items-center"
              role="search"
            >
              <span className="pointer-events-none absolute left-3 text-ink-20">
                <IconSearch size={15} />
              </span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search patients…"
                aria-label="Search patients"
                className="w-full rounded-pill border-[1.5px] border-ink/10 bg-bg-soft py-1.5 pl-9 pr-14 text-[13.5px] transition-colors placeholder:text-ink-20 focus:border-clinical/40 focus:bg-white focus:outline-none focus:ring-4 focus:ring-clinical/10"
              />
              <kbd className="pointer-events-none absolute right-2.5 hidden rounded border border-ink/12 bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink-40 sm:block">
                ⌘K
              </kbd>
            </form>
          </div>

          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 rounded-pill border border-ink/10 bg-white py-1 pl-1 pr-2.5 transition-colors hover:border-ink/20"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--role)] font-mono text-[11px] font-bold text-white">
                {initials}
              </span>
              {/* The role is written, not just coloured. Five personas is more
                  than colour can carry on its own, and this is the text the
                  colour confirms. */}
              <span className="hidden text-left leading-tight sm:block">
                <span className="block text-[12.5px] font-semibold text-ink">
                  {session.fullName}
                </span>
                <span className="block text-[10.5px] font-semibold text-[var(--role-text)]">
                  {signature.label}
                </span>
              </span>
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+8px)] w-60 overflow-hidden rounded-card border border-ink/10 bg-white shadow-lg"
              >
                <div className="border-b border-ink/8 bg-[var(--role-tint)] px-4 py-3">
                  <p className="mono-label">Signed in as</p>
                  <p className="mt-1 text-[13.5px] font-semibold text-ink">{session.fullName}</p>
                  <p className="text-[12px] font-semibold text-[var(--role-text)]">
                    {signature.label}
                  </p>
                  {/* The raw permission slugs used to be listed here — "10
                      permissions", then `appointment:read`, `consent:read` and
                      the rest as chips. That was debugging output that shipped:
                      it meant something while the RBAC was being built and
                      nothing at all to a receptionist, who cannot act on it and
                      did not ask. The role name above is the answer to "what am
                      I allowed to do", in the clinic's own words. */}
                </div>
                <Link
                  href="/change-password"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13.5px] transition-colors hover:bg-bg-soft"
                  onClick={() => setMenuOpen(false)}
                >
                  <IconKey size={15} />
                  Change my password
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void signOut()}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13.5px] font-semibold text-coral-text transition-colors hover:bg-coral/6"
                >
                  <IconLogout size={16} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-7 sm:px-6">{children}</main>

        {/* No footer. It used to read "Confidential patient data · Access is
            logged" on every screen — true, and still true, but a standing
            reminder to staff about our own auditing is commentary, not
            chrome. Removed 25 Aug 2026 with the rest of it. */}
      </div>
    </div>
  );
}

/**
 * The longest nav route that contains `pathname`, or null.
 *
 * Exported nowhere and deliberately dependency-free, so it can be reasoned
 * about on its own: given /patients/register and ['/', '/patients',
 * '/patients/register'], the answer is '/patients/register'.
 */
function mostSpecificMatch(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;

  for (const href of hrefs) {
    const contains =
      href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

    if (contains && (best === null || href.length > best.length)) best = href;
  }

  return best;
}
