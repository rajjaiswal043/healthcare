'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  platformApi,
  PlatformRequestError,
  slugify,
  type Clinic,
  type OnboardResult,
  type PlatformUser,
} from '@/lib/platform-api';

const ROLES = [
  { key: 'doctor', label: 'Doctors' },
  { key: 'nurse', label: 'Nurses' },
  { key: 'front_desk', label: 'Front desk' },
  { key: 'administrator', label: 'Administrators' },
];

/**
 * The platform console.
 *
 * Dark on purpose — this is not the clinic's product, and the two should never
 * be confused at a glance by somebody with both open.
 *
 * Note what it cannot show: a patient, an appointment, an invoice. The counts
 * come from a database function that returns integers by construction, so there
 * is no shape of response here that could carry a name.
 */
export default function PlatformConsole() {
  const router = useRouter();

  const [me, setMe] = useState<PlatformUser | null>(null);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [contactMobile, setContactMobile] = useState('');
  const [seats, setSeats] = useState<Record<string, string>>({});

  /** Shown once, and only once: the credentials handed to a new clinic. */
  const [issued, setIssued] = useState<OnboardResult | null>(null);

  const load = useCallback(async () => {
    try {
      const [profile, list] = await Promise.all([platformApi.me(), platformApi.clinics()]);
      setMe(profile);
      setClinics(list.clinics);
      setError(null);
    } catch (err) {
      if (err instanceof PlatformRequestError && err.status === 401) {
        router.replace('/platform/login');
        return;
      }
      setError(err instanceof PlatformRequestError ? err.error.message : 'Could not load clinics.');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onboard() {
    setBusyId('new');
    setError(null);
    try {
      const seatLimits: Record<string, number> = {};
      for (const [key, value] of Object.entries(seats)) {
        if (value.trim() !== '') seatLimits[key] = Number(value);
      }

      const result = await platformApi.onboard({
        name: name.trim(),
        slug: (slugTouched ? slug : slugify(name)).trim(),
        ...(contactMobile.trim() ? { contactMobile: contactMobile.trim() } : {}),
        ...(Object.keys(seatLimits).length > 0 ? { seatLimits } : {}),
        admin: { email: adminEmail.trim(), fullName: adminName.trim() },
      });

      setIssued(result);
      setAdding(false);
      setName('');
      setSlug('');
      setSlugTouched(false);
      setAdminName('');
      setAdminEmail('');
      setContactMobile('');
      setSeats({});
      await load();
    } catch (err) {
      setError(err instanceof PlatformRequestError ? err.error.message : 'Could not create it.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleSuspension(clinic: Clinic) {
    if (clinic.status === 'SUSPENDED') {
      setBusyId(clinic.id);
      try {
        await platformApi.reactivate(clinic.id);
        await load();
      } catch (err) {
        setError(err instanceof PlatformRequestError ? err.error.message : 'Could not restore it.');
      } finally {
        setBusyId(null);
      }
      return;
    }

    const reason = window.prompt(
      `Suspend ${clinic.name}? They will keep reading and printing their records, and will not be able to book, consult or bill.\n\nWhy?`,
    );
    if (!reason?.trim()) return;

    setBusyId(clinic.id);
    try {
      await platformApi.suspend(clinic.id, reason.trim());
      await load();
    } catch (err) {
      setError(err instanceof PlatformRequestError ? err.error.message : 'Could not suspend it.');
    } finally {
      setBusyId(null);
    }
  }

  const proposedSlug = slugTouched ? slug : slugify(name);

  return (
    <main className="min-h-screen bg-[#12161c] px-6 py-8 text-white">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/35">
              Platform
            </p>
            <h1 className="mt-1 font-display text-[28px] font-bold">Clinics</h1>
            <p className="mt-1 text-[13.5px] text-white/45">
              Counts only — this console cannot open a patient, a queue or an invoice.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {me && <span className="text-[13px] text-white/45">{me.fullName}</span>}
            {!adding && (
              <button
                type="button"
                className="rounded-pill bg-white px-4 py-2 text-[13.5px] font-semibold text-[#12161c]"
                onClick={() => setAdding(true)}
              >
                Onboard a clinic
              </button>
            )}
            <button
              type="button"
              className="rounded-pill border border-white/15 px-3 py-2 text-[13px] text-white/60 hover:text-white"
              onClick={() => {
                void platformApi.logout().finally(() => router.replace('/platform/login'));
              }}
            >
              Sign out
            </button>
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-card border border-red-400/30 bg-red-400/10 p-3 text-[13.5px] text-red-200"
          >
            {error}
          </div>
        )}

        {/* The handover. Shown once — we store a hash, so there is no way back
            to it, and the clinic cannot be signed into without it. */}
        {issued && (
          <section className="mt-5 rounded-card border border-emerald-300/25 bg-emerald-300/10 p-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-200">
              {issued.clinic.name} is ready
            </p>
            <p className="mt-1 text-[13.5px] text-white/60">
              Send these to the clinic administrator now. The password cannot be shown again — if it
              is lost, reset it from this console.
            </p>

            <dl className="mt-4 grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-[11px] uppercase tracking-[0.12em] text-white/35">Clinic</dt>
                <dd className="mt-1 font-mono text-[14px]">{issued.clinic.slug}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-[0.12em] text-white/35">Email</dt>
                <dd className="mt-1 font-mono text-[14px] break-all">{issued.admin.email}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-[0.12em] text-white/35">Password</dt>
                <dd className="mt-1 font-mono text-[16px] font-bold tracking-[0.08em]">
                  {issued.admin.temporaryPassword}
                </dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-pill bg-white px-4 py-2 text-[13px] font-semibold text-[#12161c]"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `Clinic: ${issued.clinic.slug}\nEmail: ${issued.admin.email}\nPassword: ${issued.admin.temporaryPassword}`,
                  )
                }
              >
                Copy all three
              </button>
              <button
                type="button"
                className="rounded-pill border border-white/15 px-4 py-2 text-[13px] text-white/60 hover:text-white"
                onClick={() => setIssued(null)}
              >
                Done
              </button>
            </div>
          </section>
        )}

        {adding && (
          <section className="mt-5 rounded-card border border-white/10 bg-white/[0.04] p-5">
            <h2 className="font-display text-[19px] font-bold">Onboard a clinic</h2>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field
                label="Clinic name"
                value={name}
                onChange={setName}
                placeholder="Sunrise Clinic"
              />
              <Field
                label="Sign-in address"
                value={proposedSlug}
                onChange={(v) => {
                  setSlugTouched(true);
                  setSlug(v);
                }}
                mono
                hint="What staff type when signing in. It cannot be changed later."
              />
              <Field
                label="Administrator name"
                value={adminName}
                onChange={setAdminName}
                placeholder="Dr Ramesh Kulkarni"
              />
              <Field
                label="Administrator email"
                value={adminEmail}
                onChange={setAdminEmail}
                placeholder="ramesh@sunrise.in"
              />
              <Field
                label="Contact mobile (optional)"
                value={contactMobile}
                onChange={(v) => setContactMobile(v.replace(/\D/g, '').slice(0, 10))}
                placeholder="9876543210"
              />
            </div>

            <div className="mt-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/40">
                Seats
              </p>
              <p className="mt-1 text-[12.5px] text-white/35">
                Leave a box empty for unlimited. Counted on active staff, so deactivating somebody
                frees their seat.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                {ROLES.map((r) => (
                  <label key={r.key} className="block">
                    <span className="text-[12px] text-white/50">{r.label}</span>
                    <input
                      className="mt-1 w-full rounded-panel border border-white/12 bg-white/5 px-3 py-2 font-mono text-[14px] text-white outline-none focus:border-white/35"
                      inputMode="numeric"
                      value={seats[r.key] ?? ''}
                      onChange={(e) =>
                        setSeats((prev) => ({
                          ...prev,
                          [r.key]: e.target.value.replace(/\D/g, '').slice(0, 3),
                        }))
                      }
                      placeholder="∞"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-pill bg-white px-4 py-2 text-[13.5px] font-semibold text-[#12161c] disabled:opacity-40"
                disabled={
                  busyId === 'new' ||
                  name.trim().length < 2 ||
                  !proposedSlug ||
                  adminName.trim().length < 2 ||
                  !adminEmail.trim()
                }
                onClick={() => void onboard()}
              >
                {busyId === 'new' ? 'Creating…' : 'Create the clinic'}
              </button>
              <button
                type="button"
                className="rounded-pill border border-white/15 px-4 py-2 text-[13.5px] text-white/60 hover:text-white"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        <ul className="mt-6 space-y-2">
          {clinics.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-4 rounded-card border border-white/10 bg-white/[0.03] px-5 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-display text-[17px] font-bold">
                  {c.name}
                  {c.status === 'SUSPENDED' && (
                    <span className="rounded-pill bg-amber-300/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200">
                      suspended · read-only
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[12.5px] text-white/40">
                  <span className="font-mono">{c.slug}</span>
                  {' · '}
                  {c.activeUsers} staff
                  {' · '}
                  {c.patients} patients
                  {' · '}
                  {c.lastSignInAt
                    ? `last used ${new Date(c.lastSignInAt).toLocaleDateString('en-IN')}`
                    : 'never used'}
                  {c.suspendedReason ? ` · ${c.suspendedReason}` : ''}
                </p>
              </div>

              <button
                type="button"
                className="rounded-pill border border-white/15 px-3 py-1.5 text-[12.5px] text-white/70 hover:text-white disabled:opacity-40"
                disabled={busyId === c.id}
                onClick={() => void toggleSuspension(c)}
              >
                {c.status === 'SUSPENDED' ? 'Restore' : 'Suspend'}
              </button>
            </li>
          ))}
        </ul>

        {clinics.length === 0 && (
          <p className="mt-10 text-center text-[14px] text-white/30">
            No clinics yet. Onboard the first one.
          </p>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/40">
        {label}
      </span>
      <input
        className={[
          'mt-1 w-full rounded-panel border border-white/12 bg-white/5 px-3 py-2 text-[14px] text-white outline-none focus:border-white/35',
          mono ? 'font-mono' : '',
        ].join(' ')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hint && <span className="mt-1 block text-[11.5px] text-white/30">{hint}</span>}
    </label>
  );
}
