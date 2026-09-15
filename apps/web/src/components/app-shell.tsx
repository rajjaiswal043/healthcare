'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './auth-provider';
import { ClinicLogo } from './clinic-logo';
import { initialsOf } from '@/lib/role-signature';
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
        // The administrator DEFINES a discount; the finance desk APPLIES one.
        // Gated on the defining half, so finance never sees this screen.
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

const BREADCRUMBS: Record<string, string> = {
  '/': 'Home',
  '/patients': 'Patients',
  '/patients/register': 'Register a patient',
  '/queue': "Today's queue",
  '/appointments/new': 'Book an appointment',
  '/settings/displays': 'Waiting-room screens',
  '/settings/users': 'Staff',
  '/settings/roles': 'Roles and permissions',
  '/settings/doctors': 'Doctors and hours',
  '/settings/branding': 'Branding',
  '/diagnostics': 'Tests to do',
  '/change-password': 'Choose a password',
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const { session, loading, can, signOut, signature } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const [collapsed, setCollapsed] = useState(false);
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

  const initials = initialsOf(session.fullName);
  const crumb = BREADCRUMBS[pathname] ?? session.tenant.name;

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
      {/* The rail is where the persona lives: white at the top fading into the
          role's palest tint, so the colour is present without the nav becoming a
          block of it. */}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 flex flex-col gap-5 border-r border-ink/8 bg-gradient-to-b from-white to-[var(--role-tint)] px-3 py-4 shadow-rail transition-[width,transform] duration-200 lg:static lg:translate-x-0',
          collapsed ? 'lg:w-[76px]' : 'lg:w-[236px]',
          mobileOpen ? 'w-[236px] translate-x-0' : 'w-[236px] -translate-x-full',
        ].join(' ')}
      >
        {/* Centred, and the close button taken out of the flow to keep it
            that way — with `justify-between` the mark sat wherever the button's
            presence left it, which meant it moved between the mobile drawer and
            the desktop rail. Absolute positioning is what makes "centred" mean
            centred in the rail rather than centred in whatever is left. */}
        <div className="relative flex items-center justify-center px-1.5">
          <Link href="/" className="flex items-center" aria-label="Home">
            {/* The mark only. The name is written once, in the header, where
                there is room for it — this rail is 236px and a real hospital
                name ("Dr Vivek Swarnkar Ortho Clinic") truncates here no matter
                what. Both carried it briefly after white-labelling and the
                repetition read as a bug rather than as branding. */}
            <ClinicLogo clinic={session.tenant} size={32} alt={session.tenant.name} />
          </Link>
          <button
            type="button"
            className="btn-ghost absolute right-0 !px-1.5 !py-1.5 lg:hidden"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
          >
            <IconX size={17} />
          </button>
        </div>

        <nav className="flex flex-col gap-5" aria-label="Main">
          {visible.map((section) => (
            <div key={section.title} className="flex flex-col gap-1">
              {!collapsed && <p className="mono-label px-2.5 pb-1">{section.title}</p>}
              {section.items.map((item) => {
                const active = item.href === activeHref;
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    className={[
                      'group relative flex items-center gap-2.5 rounded-panel border px-2.5 py-2 transition-all',
                      active
                        ? 'border-[color-mix(in_srgb,var(--role)_20%,transparent)] bg-[var(--role-soft)] text-[var(--role-text)]'
                        : 'border-transparent text-ink-60 hover:border-ink/10 hover:bg-white',
                    ].join(' ')}
                  >
                    {active && (
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
                    {!collapsed && (
                      <span className="text-[13.5px] font-semibold">{item.label}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto hidden lg:block">
          <button
            type="button"
            className="btn-ghost w-full !justify-start !px-2.5 text-[12.5px]"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <IconPanelLeft size={16} />
            {!collapsed && 'Collapse'}
          </button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The peripheral signal. Three pixels, full width, directly above the
            content — the thing you register from across a desk without reading
            anything on the screen. */}
        <div
          aria-hidden="true"
          className="no-print sticky top-0 z-30 h-[3px] shrink-0 bg-[var(--role)]"
        />

        {/* `data-app-shell` is what the print stylesheet hides. It cannot key
            on the tag alone: the printed prescription has its own <header>
            carrying the clinic letterhead, and a bare `header` rule would
            hide that too. The attribute went missing from this element at
            some point, so the selector matched nothing and the search box and
            account menu printed at the top of every prescription. */}
        <header
          data-app-shell
          className="sticky top-[3px] z-30 flex h-[58px] items-center gap-3 border-b border-ink/8 bg-white/85 px-4 backdrop-blur-md sm:px-6"
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
              a clinic's own name should be on their own console. */}
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
