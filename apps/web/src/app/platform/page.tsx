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
import {
  UHID_PREFIX_MAX,
  UHID_WIDTH_DEFAULT,
  UHID_WIDTH_MAX,
  UHID_WIDTH_MIN,
  derivePrefix,
  formatUhid,
  uhidPrefixProblems,
} from '@/lib/uhid-format';
import { LogoMark } from '@/components/auth-shell';
import {
  IconAlert,
  IconBuilding,
  IconCheckCircle,
  IconLogout,
  IconUsers,
} from '@/components/icons';

/**
 * The roles a seat limit can be set for at onboarding.
 *
 * Naya system role add ho to isse yahan bhi update karna. This cannot be
 * derived from SYSTEM_ROLES in packages/db: the web bundle does not import that
 * package, which would drag Prisma into the browser. The backend is generic —
 * any role key the clinic has is accepted — so a role missing from THIS list is
 * silently unlimited for every clinic onboarded without it. That is how Finance
 * went missing until 15 Sep 2026.
 *
 * `owner` is left out on purpose: a rare, read-only oversight role nobody has
 * needed to cap.
 */
const ROLES = [
  { key: 'doctor', label: 'Doctors' },
  { key: 'nurse', label: 'Nurses' },
  { key: 'front_desk', label: 'Front desk' },
  { key: 'diagnostics', label: 'Diagnostics' },
  { key: 'finance', label: 'Finance' },
  { key: 'administrator', label: 'Administrators' },
];

/**
 * The platform console.
 *
 * Built from the clinic's design tokens — same paper, same ink, same cards,
 * fields and teal. It was hand-rolled dark, which kept it distinguishable at
 * the price of belonging to no design system, so every fix had to be made
 * twice. Narveer chose the shared theme on 25 Aug 2026; the wordmark and the
 * subtitle are what say which console this is.
 *
 * Note what it still cannot show: a patient, an appointment, an invoice. The
 * counts come from a database function that returns integers by construction,
 * so there is no shape of response here that could carry a name.
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

  /**
   * The patient ID format (FR-UID-01).
   *
   * The prefix follows the clinic name until somebody types in it, the same way
   * the sign-in address does — so an onboarding that never touches it still
   * gets what it always got, and one that does is not overwritten.
   */
  const [prefix, setPrefix] = useState('');
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [width, setWidth] = useState(UHID_WIDTH_DEFAULT);

  /**
   * The clinic whose patient ID format is being changed (FR-UID-03), or null.
   *
   * Its own error, shown inside the dialog: the page-level banner sits behind
   * the overlay, where a refusal would go unread.
   */
  const [formatFor, setFormatFor] = useState<Clinic | null>(null);
  const [newPrefix, setNewPrefix] = useState('');
  const [newWidth, setNewWidth] = useState(UHID_WIDTH_DEFAULT);
  const [formatReason, setFormatReason] = useState('');
  const [formatError, setFormatError] = useState<string | null>(null);

  /** Shown once, and only once: the credentials handed to a new clinic. */
  const [issued, setIssued] = useState<OnboardResult | null>(null);
  const [copied, setCopied] = useState(false);

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
        // Sent explicitly even when untouched: what the preview showed is what
        // the clinic gets, rather than whatever the server's default is today.
        uhidPrefix: proposedPrefix,
        uhidPadding: width,
        ...(contactMobile.trim() ? { contactMobile: contactMobile.trim() } : {}),
        ...(Object.keys(seatLimits).length > 0 ? { seatLimits } : {}),
        admin: { email: adminEmail.trim(), fullName: adminName.trim() },
      });

      setIssued(result);
      setCopied(false);
      setAdding(false);
      setName('');
      setSlug('');
      setSlugTouched(false);
      setAdminName('');
      setAdminEmail('');
      setContactMobile('');
      setSeats({});
      setPrefix('');
      setPrefixTouched(false);
      setWidth(UHID_WIDTH_DEFAULT);
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

  function openFormat(clinic: Clinic) {
    setFormatFor(clinic);
    // Start from what the clinic has, so an accidental submit changes nothing
    // and the server's "already this format" refusal is the worst outcome.
    setNewPrefix(clinic.uhidPrefix);
    setNewWidth(clinic.uhidPadding);
    setFormatReason('');
    setFormatError(null);
  }

  async function changeFormat() {
    if (!formatFor) return;
    setBusyId(formatFor.id);
    setFormatError(null);
    try {
      await platformApi.changeUhidFormat(formatFor.id, {
        uhidPrefix: newPrefix,
        uhidPadding: newWidth,
        reason: formatReason.trim(),
      });
      setFormatFor(null);
      await load();
    } catch (err) {
      setFormatError(
        err instanceof PlatformRequestError ? err.error.message : 'Could not change the format.',
      );
    } finally {
      setBusyId(null);
    }
  }

  const newPrefixProblems = uhidPrefixProblems(newPrefix);
  const formatUnchanged =
    formatFor !== null && newPrefix === formatFor.uhidPrefix && newWidth === formatFor.uhidPadding;

  const proposedSlug = slugTouched ? slug : slugify(name);
  const proposedPrefix = prefixTouched ? prefix : derivePrefix(name);
  const prefixProblems = uhidPrefixProblems(proposedPrefix);

  return (
    <main className="min-h-screen bg-bg">
      {/* The same hairline the clinic console wears under its header. */}
      <div aria-hidden="true" className="h-[3px] w-full bg-clinical" />

      <div className="border-b border-ink/8 bg-white/70 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <LogoMark size={30} />
            <div>
              <p className="font-display text-[17px] font-extrabold leading-tight tracking-display">
                doctors<span className="text-clinical-text">desk.in</span>
              </p>
              <p className="mono-label">Platform console</p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {me && (
              <span className="hidden items-center gap-2 rounded-pill bg-clinical-soft py-1 pl-1 pr-3 sm:flex">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-clinical font-mono text-[11px] font-bold text-white">
                  {initials(me.fullName)}
                </span>
                <span className="text-[12.5px] font-semibold text-clinical-text">
                  {me.fullName}
                </span>
              </span>
            )}
            <button
              type="button"
              className="btn-ghost !text-ink-60"
              onClick={() => {
                void platformApi.logout().finally(() => router.replace('/platform/login'));
              }}
            >
              <IconLogout size={15} />
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-7">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[28px] font-bold">
              Clinics <span className="text-ink-20">·</span>{' '}
              <span className="text-clinical-text">{clinics.length}</span>
            </h1>
            <p className="mt-1 text-[13.5px] text-ink-60">
              Counts only — this console cannot open a patient, a queue or an invoice.
            </p>
          </div>

          {!adding && (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <IconBuilding size={15} />
              Onboard a clinic
            </button>
          )}
        </header>

        {error && (
          <div
            role="alert"
            className="mt-5 flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3.5 py-2.5 text-[13px] text-coral-text"
          >
            <span className="mt-0.5 shrink-0">
              <IconAlert size={14} />
            </span>
            <span>{error}</span>
          </div>
        )}

        {/* The handover. Shown once — we store a hash, so there is no way back
            to it, and the clinic cannot be signed into without it. */}
        {issued && (
          <section className="mt-5 rounded-card border border-green/30 bg-green-soft/50 p-5">
            <p className="flex items-center gap-2 font-display text-[17px] font-bold text-green-text">
              <IconCheckCircle size={17} />
              {issued.clinic.name} is ready
            </p>
            <p className="mt-1 text-[13px] text-ink-60">
              Send these to the clinic administrator now. The password cannot be shown again — if it
              is lost, reset it from this console.
            </p>

            <dl className="mt-4 grid gap-3 sm:grid-cols-3">
              <Handover label="Clinic" value={issued.clinic.slug} />
              <Handover label="Email" value={issued.admin.email} />
              <Handover label="Password" value={issued.admin.temporaryPassword} emphasis />
            </dl>

            {/* The format as the clinic now has it, read back from the server
                rather than from the form — the answer to "what do our patient
                numbers look like" on the day it was decided. */}
            <p className="mt-3 text-[13px] text-ink-60">
              Patient IDs start at{' '}
              <span className="font-mono font-semibold text-ink">
                {formatUhid(issued.clinic.uhidPrefix, issued.clinic.uhidPadding, 1)}
              </span>
              .
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `Clinic: ${issued.clinic.slug}\nEmail: ${issued.admin.email}\nPassword: ${issued.admin.temporaryPassword}`,
                  );
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy all three'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setIssued(null)}>
                Done
              </button>
            </div>
          </section>
        )}

        {adding && (
          <section className="card mt-5 p-5">
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

            {/*
              FR-UID-01. Asked here because it is the one moment it is free to
              change: once a card is printed, a patient ID is permanent.
            */}
            <div className="mt-5 rounded-panel border border-ink/8 bg-bg-soft px-4 py-3.5">
              <p className="mono-label">Patient IDs</p>
              <p className="mt-1 text-[12.5px] text-ink-40">
                Printed on every card, bill and report. Existing patients never change, so choose
                what this hospital actually wants now.
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
                <label className="block" htmlFor="uhidPrefix">
                  <span className="field-label !mb-1">Prefix</span>
                  <input
                    id="uhidPrefix"
                    className="field-input !py-2 font-mono"
                    value={proposedPrefix}
                    maxLength={UHID_PREFIX_MAX + 4}
                    onChange={(e) => {
                      setPrefixTouched(true);
                      // Uppercase as they type: the database stores it that way,
                      // and a preview in lowercase would show them something
                      // they will never get.
                      setPrefix(e.target.value.toUpperCase());
                    }}
                    aria-invalid={prefixProblems.length > 0}
                    aria-describedby="uhidPreview"
                  />
                </label>

                <label className="block" htmlFor="uhidWidth">
                  <span className="field-label !mb-1">Number width</span>
                  <select
                    id="uhidWidth"
                    className="field-input !py-2 font-mono"
                    value={width}
                    onChange={(e) => setWidth(Number(e.target.value))}
                  >
                    {Array.from(
                      { length: UHID_WIDTH_MAX - UHID_WIDTH_MIN + 1 },
                      (_, k) => UHID_WIDTH_MIN + k,
                    ).map((w) => (
                      <option key={w} value={w}>
                        {w} digits · {formatUhid('', w, 1)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div id="uhidPreview" aria-live="polite" className="mt-3">
                {prefixProblems.length > 0 ? (
                  <ul className="space-y-0.5 text-[12.5px] text-coral-text">
                    {prefixProblems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <p className="text-[13.5px]">
                      Your first patient will be{' '}
                      <span className="font-mono font-semibold">
                        {formatUhid(proposedPrefix, width, 1)}
                      </span>
                      .
                    </p>
                    {/* Width is a minimum, not a ceiling. Said, because
                        somebody choosing 4 digits is otherwise guessing what
                        happens at the ten-thousandth patient. */}
                    <p className="mt-0.5 text-[12.5px] text-ink-40">
                      Longer numbers are written in full — patient{' '}
                      {(10 ** width).toLocaleString('en-IN')} will be{' '}
                      <span className="font-mono">
                        {formatUhid(proposedPrefix, width, 10 ** width)}
                      </span>
                      .
                    </p>
                  </>
                )}
              </div>
            </div>

            <div className="mt-5 rounded-panel border border-ink/8 bg-bg-soft px-4 py-3.5">
              <p className="mono-label">Seats</p>
              <p className="mt-1 text-[12.5px] text-ink-40">
                Leave a box empty for unlimited. Counted on active staff, so deactivating somebody
                frees their seat.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {ROLES.map((r) => (
                  <label key={r.key} className="block">
                    <span className="field-label !mb-1">{r.label}</span>
                    <input
                      className="field-input !py-2 font-mono"
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
                className="btn-primary"
                disabled={
                  busyId === 'new' ||
                  name.trim().length < 2 ||
                  !proposedSlug ||
                  adminName.trim().length < 2 ||
                  !adminEmail.trim() ||
                  prefixProblems.length > 0
                }
                onClick={() => void onboard()}
              >
                {busyId === 'new' ? 'Creating…' : 'Create the clinic'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </section>
        )}

        <ul className="mt-6 space-y-2">
          {clinics.map((c) => (
            <li key={c.id} className="card flex flex-wrap items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-display text-[17px] font-bold">
                  {c.name}
                  {c.status === 'SUSPENDED' && (
                    <span className="badge-amber">suspended · read-only</span>
                  )}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-40">
                  <span className="font-mono text-ink-60">{c.slug}</span>
                  <Dot />
                  <span className="inline-flex items-center gap-1.5">
                    <IconUsers size={13} />
                    {c.activeUsers} staff
                  </span>
                  <Dot />
                  <span>{c.patients} patients</span>
                  <Dot />
                  <span>
                    {c.lastSignInAt
                      ? `last used ${new Date(c.lastSignInAt).toLocaleDateString('en-IN')}`
                      : 'never used'}
                  </span>
                  <Dot />
                  {/* The ID the next registration gets, not the first one ever
                      issued — that is the question a platform user is asked. */}
                  <span>
                    next ID{' '}
                    <span className="font-mono text-ink-60">
                      {formatUhid(c.uhidPrefix, c.uhidPadding, c.uhidIssued + 1)}
                    </span>
                  </span>
                  {c.suspendedReason && (
                    <>
                      <Dot />
                      <span className="text-amber-text">{c.suspendedReason}</span>
                    </>
                  )}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary !px-4 !py-1.5 !text-[13px]"
                  disabled={busyId === c.id}
                  onClick={() => openFormat(c)}
                >
                  Patient IDs
                </button>
                <button
                  type="button"
                  className="btn-secondary !px-4 !py-1.5 !text-[13px]"
                  disabled={busyId === c.id}
                  onClick={() => void toggleSuspension(c)}
                >
                  {c.status === 'SUSPENDED' ? 'Restore' : 'Suspend'}
                </button>
              </div>
            </li>
          ))}
        </ul>

        {/* FR-UID-03 — changing the format after patients exist. */}
        {formatFor && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="formatTitle"
            className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget && busyId !== formatFor.id) setFormatFor(null);
            }}
          >
            <div className="card max-h-[90vh] w-full max-w-lg overflow-y-auto p-6">
              <p className="mono-label">{formatFor.name}</p>
              <h2 id="formatTitle" className="mt-1 font-display text-[21px] font-bold">
                Change patient IDs
              </h2>
              <p className="mt-1 text-[13px] text-ink-60">
                Now <span className="font-mono">{formatFor.uhidPrefix}</span> ·{' '}
                {formatFor.uhidPadding} digits · {formatFor.uhidIssued.toLocaleString('en-IN')}{' '}
                issued
              </p>

              {/* The sentence the requirement asks for, word for word, and
                  placed before the fields rather than after them. */}
              <p className="mt-4 rounded-panel border border-amber/30 bg-amber-soft/50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-text">
                Patients already registered keep their existing IDs. This applies to new
                registrations only.
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
                <label className="block" htmlFor="newUhidPrefix">
                  <span className="field-label !mb-1">Prefix</span>
                  <input
                    id="newUhidPrefix"
                    className="field-input !py-2 font-mono"
                    value={newPrefix}
                    maxLength={UHID_PREFIX_MAX + 4}
                    onChange={(e) => setNewPrefix(e.target.value.toUpperCase())}
                    aria-invalid={newPrefixProblems.length > 0}
                    aria-describedby="newUhidPreview"
                  />
                </label>
                <label className="block" htmlFor="newUhidWidth">
                  <span className="field-label !mb-1">Number width</span>
                  <select
                    id="newUhidWidth"
                    className="field-input !py-2 font-mono"
                    value={newWidth}
                    onChange={(e) => setNewWidth(Number(e.target.value))}
                  >
                    {Array.from(
                      { length: UHID_WIDTH_MAX - UHID_WIDTH_MIN + 1 },
                      (_, k) => UHID_WIDTH_MIN + k,
                    ).map((w) => (
                      <option key={w} value={w}>
                        {w} digits
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div id="newUhidPreview" aria-live="polite" className="mt-3">
                {newPrefixProblems.length > 0 ? (
                  <ul className="space-y-0.5 text-[12.5px] text-coral-text">
                    {newPrefixProblems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <p className="text-[13.5px]">
                      The next patient will be{' '}
                      <span className="font-mono font-semibold">
                        {formatUhid(newPrefix, newWidth, formatFor.uhidIssued + 1)}
                      </span>
                      .
                    </p>
                    {/* Said, because "restart at 0001" is the change people
                        expect and the one that would create two patients whose
                        IDs differ only by prefix. */}
                    <p className="mt-0.5 text-[12.5px] text-ink-40">
                      Numbering carries on from {(formatFor.uhidIssued + 1).toLocaleString('en-IN')}{' '}
                      — it does not restart.
                    </p>
                  </>
                )}
              </div>

              <label className="mt-4 block" htmlFor="formatReason">
                <span className="field-label !mb-1">Why</span>
                <textarea
                  id="formatReason"
                  rows={2}
                  maxLength={300}
                  className="field-input text-[13.5px]"
                  placeholder="Dr Vivek asked on the phone — wants DRVIV- instead of DRV"
                  value={formatReason}
                  onChange={(e) => setFormatReason(e.target.value)}
                />
                <span className="field-hint block">
                  Written into the clinic&rsquo;s audit trail with your name and the old and new
                  formats.
                </span>
              </label>

              {formatError && (
                <p role="alert" className="mt-3 text-[13px] text-coral-text">
                  {formatError}
                </p>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={
                    busyId === formatFor.id ||
                    newPrefixProblems.length > 0 ||
                    formatUnchanged ||
                    formatReason.trim().length < 3
                  }
                  onClick={() => void changeFormat()}
                >
                  {busyId === formatFor.id ? 'Changing…' : 'Change format'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busyId === formatFor.id}
                  onClick={() => setFormatFor(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {clinics.length === 0 && (
          <div className="card mt-6 px-6 py-12 text-center">
            <p className="font-display text-[18px] font-bold text-ink">No clinics yet</p>
            <p className="mt-1 text-[13.5px] text-ink-40">
              Onboard the first one — it takes a name and an administrator.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function Dot() {
  return <span aria-hidden="true" className="h-1 w-1 rounded-full bg-ink/20" />;
}

/** One handed-over credential. `select-all` because these get copied by hand too. */
function Handover({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="mono-label">{label}</dt>
      <dd
        className={[
          'mt-1 select-all break-all rounded-tiny bg-white px-2.5 py-1.5 font-mono text-ink',
          emphasis ? 'text-[15px] font-bold tracking-[0.06em]' : 'text-[13px]',
        ].join(' ')}
      >
        {value}
      </dd>
    </div>
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
      <span className="field-label">{label}</span>
      <input
        className={`field-input !py-2 ${mono ? 'font-mono' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hint && <span className="field-hint block">{hint}</span>}
    </label>
  );
}

/** Two letters for the avatar. Same rule as the clinic's, kept local: this file
 *  has no session and no roles, so importing role-signature would drag a whole
 *  clinic concept into a console that deliberately has none. */
function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  const last = words[words.length - 1];

  if (!first) return '··';
  if (!last || words.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}
