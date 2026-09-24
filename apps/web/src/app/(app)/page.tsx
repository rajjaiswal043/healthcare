'use client';

import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import {
  IconCalendar,
  IconChevronRight,
  IconClock,
  IconSearch,
  IconUserPlus,
} from '@/components/icons';

/**
 * The landing screen: four doors.
 *
 * It used to end with a "How your data is protected" section — RLS isolation,
 * DPDP consent, audit logging — written for the clinic owner reading over a
 * receptionist's shoulder. Narveer had it removed on 25 Aug 2026. The
 * guarantees are real and enforced in the database; a staff console is just not
 * where they get argued, and a receptionist opening this screen forty times a
 * day does not need telling each time that her keystrokes are logged.
 */
export default function HomePage() {
  const { can } = useAuth();

  const actions = [
    {
      href: '/queue',
      permission: 'appointment:read',
      icon: <IconClock size={20} />,
      title: "Today's queue",
      body: 'Who is waiting, who is with the doctor, who has been seen.',
      meta: 'Live, refreshes itself',
    },
    {
      href: '/appointments/new',
      permission: 'appointment:write',
      icon: <IconCalendar size={20} />,
      title: 'Book an appointment',
      body: 'Pick a doctor and a slot — or add a walk-in straight to the queue.',
      meta: 'Walk-ins welcome',
    },
    {
      href: '/patients/register',
      permission: 'patient:write',
      icon: <IconUserPlus size={20} />,
      title: 'Register a patient',
      body: 'One screen, keyboard-first. Duplicate check runs as you type.',
      meta: 'Under 2 minutes',
    },
    {
      href: '/patients',
      permission: 'patient:read',
      icon: <IconSearch size={20} />,
      title: 'Find a patient',
      body: 'Search by name, mobile, UHID or ABHA number — one box, no filters.',
      meta: 'Fuzzy name matching',
    },
  ].filter((a) => can(a.permission));

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Front desk</p>
        <h1 className="mt-2 font-display text-[32px] font-bold">
          Good to see you, <em className="accent-words">let&rsquo;s begin</em>
        </h1>
        {/* The second sentence here used to read "Everything you do here is
            attributed to your account and logged" — gone with the rest of the
            data-handling copy. */}
        <p className="mt-1.5 max-w-xl text-[14.5px] text-ink-60">
          Register a patient or pull up an existing record.
        </p>
      </header>

      {actions.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {actions.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="card group relative overflow-hidden p-6 transition-all hover:-translate-y-0.5 hover:shadow"
            >
              <span
                aria-hidden="true"
                className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-clinical-tint transition-transform duration-300 group-hover:scale-125"
              />
              <div className="relative">
                <span className="grid h-11 w-11 place-items-center rounded-panel bg-clinical text-white shadow-sm">
                  {a.icon}
                </span>
                <h2 className="mt-4 font-display text-[19px] font-bold">{a.title}</h2>
                <p className="mt-1 text-[14px] text-ink-60">{a.body}</p>
                <p className="mono-label mt-4 flex items-center gap-1.5 !text-clinical-text">
                  {a.meta}
                  <span className="transition-transform group-hover:translate-x-0.5">
                    <IconChevronRight size={12} />
                  </span>
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
