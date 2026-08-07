'use client';

import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import {
  IconCalendar,
  IconChevronRight,
  IconClock,
  IconIdCard,
  IconSearch,
  IconShield,
  IconStethoscope,
  IconUserPlus,
} from '@/components/icons';

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
        <p className="mt-1.5 max-w-xl text-[14.5px] text-ink-60">
          Register a patient or pull up an existing record. Everything you do here is attributed to
          your account and logged.
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

      {/* What the platform guarantees. Front-of-house staff rarely care; the
          clinic owner watching over their shoulder very much does. */}
      <section>
        <p className="eyebrow">How your data is protected</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Assurance
            icon={<IconShield size={17} />}
            title="Isolated by the database"
            body="Another clinic's records are unreachable from this account — enforced by PostgreSQL, not by application code."
          />
          <Assurance
            icon={<IconIdCard size={17} />}
            title="Consent recorded"
            body="Purpose-wise consent is captured at registration and versioned, as the DPDP Act requires."
          />
          <Assurance
            icon={<IconStethoscope size={17} />}
            title="Every access logged"
            body="Who viewed which record, when and from where. Field names only — never patient values."
          />
        </div>
      </section>
    </div>
  );
}

function Assurance({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="card-flat p-4">
      <span className="grid h-8 w-8 place-items-center rounded-tiny bg-white text-clinical shadow-sm">
        {icon}
      </span>
      <h3 className="mt-3 text-[14px] font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-40">{body}</p>
    </div>
  );
}
