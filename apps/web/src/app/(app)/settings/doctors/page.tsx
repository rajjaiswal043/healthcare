'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiRequestError,
  type ClinicLocation,
  type Department,
  type LinkableUser,
  type SetupPractitioner,
} from '@/lib/api';
import { IconAlert, IconCalendar, IconUserPlus } from '@/components/icons';
import { useAuth } from '@/components/auth-provider';

/** 0 = Sunday, matching the schedule rows and JavaScript's getDay(). */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const rupees = (paise: number | null) => (paise === null ? '' : String(Math.round(paise / 100)));
const paise = (rupees: string) => (rupees.trim() === '' ? undefined : Number(rupees) * 100);

/**
 * Empty means CLEAR, not "unchanged" — the difference between adding a doctor
 * and editing one. `paise()` above returns undefined for an empty box, which is
 * right on creation (omit the field) and wrong on an edit (it would leave a
 * wrong fee in place with no way to remove it).
 */
const feeOrNull = (value: string): number | null =>
  value.trim() === '' ? null : Number(value) * 100;

/**
 * Doctors and their hours.
 *
 * The screen that was missing between "a clinic exists with staff" and "a clinic
 * can see patients". Two things surprise people here, so the page says both out
 * loud rather than letting them be discovered:
 *
 *   - a doctor with a LOGIN is not yet a doctor patients can be BOOKED with;
 *   - a doctor with no weekly hours has no slots, because availability is
 *     computed from the template rather than stored.
 */
export default function DoctorsPage() {
  const { can } = useAuth();
  const [doctors, setDoctors] = useState<SetupPractitioner[]>([]);
  const [linkable, setLinkable] = useState<LinkableUser[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [locations, setLocations] = useState<ClinicLocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    fullName: '',
    registrationNumber: '',
    specialty: '',
    qualification: '',
    departmentId: '',
    userId: '',
    consultationFee: '',
    followUpFee: '',
  });

  const [newDepartment, setNewDepartment] = useState('');
  const [newIsDiagnostic, setNewIsDiagnostic] = useState(false);

  const load = useCallback(async () => {
    try {
      const [setup, depts, locs] = await Promise.all([
        api.setupPractitioners(),
        api.setupDepartments(),
        api.locations(),
      ]);
      setDoctors(setup.practitioners);
      setLinkable(setup.linkableUsers);
      setDepartments(depts.departments);
      setLocations(locs.locations);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load doctors.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Returns whether it worked, which the profile form needs: closing it on a
   * failure throws away what the administrator typed, and they would have to
   * retype it to discover the server still says no.
   */
  async function run(key: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'That did not work.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addDoctor() {
    // Narrowed into consts first: under exactOptionalPropertyTypes, calling the
    // converter inside the spread leaves the value typed `number | undefined`
    // even inside the guard, because they are two separate calls.
    const consultationFeePaise = paise(form.consultationFee);
    const followUpFeePaise = paise(form.followUpFee);

    await run('new', () =>
      api.createPractitioner({
        fullName: form.fullName.trim(),
        ...(form.registrationNumber.trim()
          ? { registrationNumber: form.registrationNumber.trim() }
          : {}),
        ...(form.specialty.trim() ? { specialty: form.specialty.trim() } : {}),
        ...(form.qualification.trim() ? { qualification: form.qualification.trim() } : {}),
        ...(form.departmentId ? { departmentId: form.departmentId } : {}),
        ...(form.userId ? { userId: form.userId } : {}),
        ...(consultationFeePaise === undefined ? {} : { consultationFeePaise }),
        ...(followUpFeePaise === undefined ? {} : { followUpFeePaise }),
      }),
    );

    setAdding(false);
    setForm({
      fullName: '',
      registrationNumber: '',
      specialty: '',
      qualification: '',
      departmentId: '',
      userId: '',
      consultationFee: '',
      followUpFee: '',
    });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">Doctors and hours</h1>
          <p className="mt-1 max-w-[64ch] text-[14px] text-ink-60">
            A doctor needs to be listed here before anybody can book them — a login on its own is
            not enough. And a doctor with no weekly hours has no appointment slots, because times
            are worked out from these sessions rather than stored in advance.
          </p>
        </div>
        {!adding && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <IconUserPlus size={16} />
            Add a doctor
          </button>
        )}
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-coral/30 bg-coral/8 p-3 text-[13.5px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={14} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {adding && (
        <section className="card p-5">
          <h2 className="font-display text-[19px] font-bold">Add a doctor</h2>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field
              label="Name"
              value={form.fullName}
              onChange={(v) => setForm({ ...form, fullName: v })}
              placeholder="Vivek Swarnkar"
            />
            <Field
              label="Registration number"
              value={form.registrationNumber}
              onChange={(v) => setForm({ ...form, registrationNumber: v })}
              placeholder="MMC-2011-48213"
              hint="Printed on every prescription. The print refuses without it."
            />
            <Field
              label="Specialty"
              value={form.specialty}
              onChange={(v) => setForm({ ...form, specialty: v })}
              placeholder="Orthopaedics"
            />
            <Field
              label="Qualification"
              value={form.qualification}
              onChange={(v) => setForm({ ...form, qualification: v })}
              placeholder="MBBS, MS (Ortho)"
            />

            <label className="block">
              <span className="field-label">Department</span>
              <select
                className="field-input mt-1"
                value={form.departmentId}
                onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
              >
                <option value="">None</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="field-label">Their login</span>
              <select
                className="field-input mt-1"
                value={form.userId}
                onChange={(e) => setForm({ ...form, userId: e.target.value })}
              >
                <option value="">Does not sign in</option>
                {linkable.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} · {u.email}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Links this doctor to a staff account, so they see their own day list.
              </span>
            </label>

            <Field
              label="Consultation fee ₹"
              value={form.consultationFee}
              onChange={(v) => setForm({ ...form, consultationFee: v.replace(/\D/g, '') })}
              placeholder="600"
              hint="Leave empty to use the clinic's catalogue price."
            />
            <Field
              label="Follow-up fee ₹"
              value={form.followUpFee}
              onChange={(v) => setForm({ ...form, followUpFee: v.replace(/\D/g, '') })}
              placeholder="350"
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy === 'new' || form.fullName.trim().length < 2}
              onClick={() => void addDoctor()}
            >
              {busy === 'new' ? 'Adding…' : 'Add the doctor'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {doctors.length === 0 && !adding && (
        <section className="card-flat p-8 text-center">
          <p className="text-[15px] font-semibold">No doctors yet</p>
          <p className="mx-auto mt-1 max-w-[52ch] text-[13.5px] text-ink-60">
            Until one is listed here, the booking screen has nothing to offer. Adding a doctor takes
            a name; everything else can follow.
          </p>
        </section>
      )}

      {doctors.map((d) => (
        <DoctorCard
          key={d.id}
          doctor={d}
          locations={locations}
          linkable={linkable}
          canManageLogins={can('user:manage')}
          canSwitch={can('schedule:manage')}
          busy={busy}
          onRun={run}
        />
      ))}

      <section className="card p-5">
        <h2 className="font-display text-[17px] font-bold">Departments</h2>
        <p className="mt-1 max-w-[62ch] text-[13px] text-ink-60">
          The first step of booking. Optional — with none, the booking screen simply shows every
          doctor. Mark a department as <strong>diagnostic</strong> (X-ray, pathology) and it takes
          test requests instead of appointments: it has no slots and never appears when booking.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {departments.map((d) => (
            <span key={d.id} className={d.isDiagnostic ? 'badge-clinical' : 'badge-neutral'}>
              {d.name}
              {d.isDiagnostic && ' · tests'}
            </span>
          ))}
          {departments.length === 0 && <span className="text-[13px] text-ink-40">None yet.</span>}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="field-input max-w-[260px]"
            value={newDepartment}
            onChange={(e) => setNewDepartment(e.target.value)}
            placeholder={newIsDiagnostic ? 'X-ray' : 'Orthopaedics'}
            maxLength={120}
          />

          {/* Chosen before creating, not after: the flag decides whether the
              department ever appears on the booking screen, and a consulting
              department that quietly became diagnostic would take its doctors'
              slots with it. */}
          <label className="flex select-none items-center gap-2 text-[13.5px] text-ink-60">
            <input
              type="checkbox"
              className="h-4 w-4 accent-clinical"
              checked={newIsDiagnostic}
              onChange={(e) => setNewIsDiagnostic(e.target.checked)}
            />
            Does tests, not appointments
          </label>

          <button
            type="button"
            className="btn-secondary"
            disabled={busy === 'dept' || newDepartment.trim().length < 2}
            onClick={() =>
              void run('dept', async () => {
                await api.createDepartment(newDepartment.trim(), newIsDiagnostic);
                setNewDepartment('');
                setNewIsDiagnostic(false);
              })
            }
          >
            Add department
          </button>
        </div>
      </section>
    </div>
  );
}

function DoctorCard({
  doctor: d,
  locations,
  linkable,
  canManageLogins,
  canSwitch,
  busy,
  onRun,
}: {
  doctor: SetupPractitioner;
  locations: ClinicLocation[];
  linkable: LinkableUser[];
  /** `user:manage` — the administrator. Linking is theirs alone; the server says so too. */
  canManageLogins: boolean;
  /** `schedule:manage` — the administrator, the same as Edit and Delete. */
  canSwitch: boolean;
  busy: string | null;
  onRun: (key: string, fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [session, setSession] = useState({
    dayOfWeek: '1',
    startTime: '09:00',
    endTime: '13:00',
    slotMinutes: '15',
  });

  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState({
    registrationNumber: '',
    specialty: '',
    qualification: '',
    consultationFee: '',
    followUpFee: '',
  });

  const [loginPanel, setLoginPanel] = useState<'link' | 'unlink' | null>(null);
  const [loginChoice, setLoginChoice] = useState('');
  const [loginReason, setLoginReason] = useState('');

  function openLoginPanel(kind: 'link' | 'unlink') {
    setLoginChoice('');
    setLoginReason('');
    setLoginPanel(loginPanel === kind ? null : kind);
  }

  /**
   * Who the picker may offer. An entry with consultations takes back only the
   * login that was unlinked from it — anyone else would become the owner of
   * notes they did not write — so the server's rule is mirrored here rather
   * than discovered as a 409 after choosing.
   */
  const offer =
    d.relinkOnly === undefined ? linkable : linkable.filter((u) => u.id === d.relinkOnly?.id);
  const consultations = `${d.history.encounters} consultation${d.history.encounters === 1 ? '' : 's'}`;
  const noOfferReason =
    d.relinkOnly === undefined
      ? 'No doctor logins are free to link. A login needs the doctor role and must not be linked to another entry.'
      : d.relinkOnly === null
        ? `${d.fullName} has ${consultations} and no login was ever unlinked from them here, so no login can be linked — it would become the owner of those notes.`
        : `${d.fullName} has ${consultations}, so only ${d.relinkOnly.fullName} (${d.relinkOnly.email}), who was linked before, can be linked back — and that login is not eligible now: it is switched off, lacks the doctor role, or is linked to another entry.`;

  async function submitLogin() {
    const reason = loginReason.trim();
    const done = await onRun(`login-${d.id}`, () =>
      loginPanel === 'unlink'
        ? api.unlinkLogin(d.id, reason)
        : api.linkLogin(d.id, loginChoice, reason),
    );
    if (done) setLoginPanel(null);
  }

  function startEdit() {
    setProfile({
      registrationNumber: d.registrationNumber ?? '',
      specialty: d.specialty ?? '',
      qualification: d.qualification ?? '',
      consultationFee: rupees(d.consultationFeePaise),
      followUpFee: rupees(d.followUpFeePaise),
    });
    setEditing(true);
  }

  /**
   * Save the profile.
   *
   * Fees go as `null` when the box is empty — that is how an override is
   * removed, putting the doctor back on the catalogue price. An empty box
   * cannot mean "leave it alone", or a fee typed in by mistake could never be
   * taken off. Zero stays a real, different answer.
   *
   * `departmentId` is not sent and cannot be: it is not on the client's type,
   * and the server would refuse the request if it were.
   */
  async function saveProfile() {
    const saved = await onRun(`edit-${d.id}`, () =>
      api.updatePractitioner(d.id, {
        registrationNumber: profile.registrationNumber.trim(),
        specialty: profile.specialty.trim(),
        qualification: profile.qualification.trim(),
        consultationFeePaise: feeOrNull(profile.consultationFee),
        followUpFeePaise: feeOrNull(profile.followUpFee),
      }),
    );
    if (saved) setEditing(false);
  }

  const locationId = locations[0]?.id ?? '';

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink/8 bg-bg-soft px-5 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-display text-[17px] font-bold">
            {d.fullName}
            {!d.isActive && <span className="badge-neutral ml-2">switched off</span>}
          </p>
          <p className="text-[12.5px] text-ink-40">
            {[
              d.specialty,
              d.department?.name,
              d.registrationNumber ? `Reg. ${d.registrationNumber}` : null,
              d.consultationFeePaise !== null ? `₹${rupees(d.consultationFeePaise)}` : null,
              d.userId ? 'has a login' : 'no login',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>

        {!d.registrationNumber && (
          <span
            className="badge-amber"
            title="Prescriptions for this doctor will refuse to print until this is filled in"
          >
            no registration number
          </span>
        )}

        {canManageLogins && (
          <button
            type="button"
            className="btn-ghost !px-2.5 !py-1.5 text-[12.5px]"
            onClick={() => openLoginPanel(d.userId ? 'unlink' : 'link')}
          >
            {loginPanel ? 'Cancel' : d.userId ? 'Unlink login' : 'Link login'}
          </button>
        )}

        {/* Switching off is refused by the server while patients are still
            booked with this doctor, and the 409 names how many — that message
            is what appears here, so the button is not hidden for it. Switching
            back on is always allowed. */}
        {canSwitch && (
          <button
            type="button"
            className="btn-ghost !px-2.5 !py-1.5 text-[12.5px]"
            disabled={busy === `switch-${d.id}`}
            onClick={() => {
              const off = d.isActive;
              if (
                !window.confirm(
                  off
                    ? `Switch ${d.fullName} off? They stop appearing on the booking screen. ` +
                        `Their history stays, and they can be switched back on at any time.`
                    : `Switch ${d.fullName} back on? They appear on the booking screen again.`,
                )
              ) {
                return;
              }
              void onRun(`switch-${d.id}`, () => api.updatePractitioner(d.id, { isActive: !off }));
            }}
          >
            {d.isActive ? 'Switch off' : 'Switch on'}
          </button>
        )}

        <button
          type="button"
          className="btn-secondary !px-2.5 !py-1.5 text-[12.5px]"
          disabled={busy === `edit-${d.id}`}
          onClick={() => (editing ? setEditing(false) : startEdit())}
        >
          {editing ? 'Cancel' : 'Edit'}
        </button>

        {/* Only for a doctor with no history at all — the only one the server
            will delete. Anyone with an appointment (cancelled ones included) or
            a consultation stays, and is switched off instead. The server checks
            again regardless; this only keeps the button off the cards where it
            could never work. */}
        {d.history.appointments === 0 && d.history.encounters === 0 && (
          <button
            type="button"
            className="btn-ghost !px-2.5 !py-1.5 text-[12.5px] !text-coral-text"
            disabled={busy === `delete-${d.id}`}
            onClick={() => {
              if (
                !window.confirm(
                  `Delete ${d.fullName}? This removes the doctor and their weekly hours for good. ` +
                    `It is only possible because nobody has been booked with them yet.`,
                )
              ) {
                return;
              }
              void onRun(`delete-${d.id}`, () => api.deletePractitioner(d.id));
            }}
          >
            Delete
          </button>
        )}
      </header>

      {loginPanel && (
        <div className="border-b border-ink/8 bg-bg-soft px-5 py-4">
          {loginPanel === 'unlink' ? (
            <p className="max-w-[70ch] text-[13.5px] text-ink-60">
              Unlink{' '}
              <strong className="text-ink">
                {d.login ? `${d.login.fullName} (${d.login.email})` : 'the login'}
              </strong>{' '}
              from {d.fullName}? The doctor entry, its hours, appointments and consultations stay
              exactly as they are. The login stops seeing this doctor&apos;s queue and consultations
              straight away.
            </p>
          ) : offer.length === 0 ? (
            <p className="max-w-[70ch] text-[13.5px] text-ink-60">{noOfferReason}</p>
          ) : (
            <label className="block max-w-[420px]">
              <span className="field-label">Login to link to {d.fullName}</span>
              <select
                className="field-input mt-1"
                value={loginChoice}
                onChange={(e) => setLoginChoice(e.target.value)}
              >
                <option value="">Choose a login…</option>
                {offer.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} — {u.email}
                  </option>
                ))}
              </select>
              {d.relinkOnly && (
                <span className="mt-1 block text-[12.5px] text-ink-40">
                  Only the login linked before can be linked back: {d.fullName} has {consultations}.
                </span>
              )}
            </label>
          )}

          {(loginPanel === 'unlink' || offer.length > 0) && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="block min-w-[260px] flex-1">
                <span className="field-label">Reason (required)</span>
                <input
                  className="field-input mt-1"
                  value={loginReason}
                  onChange={(e) => setLoginReason(e.target.value)}
                  maxLength={300}
                  placeholder={
                    loginPanel === 'unlink' ? 'Linked to the wrong doctor' : 'Their own login'
                  }
                />
              </label>
              <button
                type="button"
                className="btn-primary"
                disabled={
                  busy === `login-${d.id}` ||
                  loginReason.trim().length < 3 ||
                  (loginPanel === 'link' && !loginChoice)
                }
                onClick={() => void submitLogin()}
              >
                {loginPanel === 'unlink' ? 'Unlink login' : 'Link login'}
              </button>
            </div>
          )}
        </div>
      )}

      {editing && (
        <div className="border-b border-ink/8 bg-bg-soft px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="field-label">Registration number</span>
              <input
                className="field-input mt-1"
                value={profile.registrationNumber}
                onChange={(e) => setProfile((f) => ({ ...f, registrationNumber: e.target.value }))}
                maxLength={64}
                placeholder="MH-12345"
              />
              <span className="field-hint">Printed on every prescription.</span>
            </label>

            <label className="block">
              <span className="field-label">Specialty</span>
              <input
                className="field-input mt-1"
                value={profile.specialty}
                onChange={(e) => setProfile((f) => ({ ...f, specialty: e.target.value }))}
                maxLength={120}
                placeholder="Orthopaedics"
              />
            </label>

            <label className="block">
              <span className="field-label">Qualification</span>
              <input
                className="field-input mt-1"
                value={profile.qualification}
                onChange={(e) => setProfile((f) => ({ ...f, qualification: e.target.value }))}
                maxLength={200}
                placeholder="MBBS, MS (Ortho)"
              />
            </label>

            <label className="block">
              <span className="field-label">Consultation fee (₹)</span>
              <input
                className="field-input mt-1"
                inputMode="numeric"
                value={profile.consultationFee}
                onChange={(e) =>
                  setProfile((f) => ({ ...f, consultationFee: e.target.value.replace(/\D/g, '') }))
                }
                placeholder="500"
              />
              <span className="field-hint">Empty uses the price list.</span>
            </label>

            <label className="block">
              <span className="field-label">Follow-up fee (₹)</span>
              <input
                className="field-input mt-1"
                inputMode="numeric"
                value={profile.followUpFee}
                onChange={(e) =>
                  setProfile((f) => ({ ...f, followUpFee: e.target.value.replace(/\D/g, '') }))
                }
                placeholder="300"
              />
              <span className="field-hint">Empty uses the price list.</span>
            </label>

            {/* Shown, and not editable. The department is what the finance
                report splits revenue by and what walk-in diagnostics file
                against — both treat it as permanent. Moving a doctor would not
                re-file the money they earned last quarter, it would change what
                last quarter's report MEANS, which is the one thing a report
                must not do. The server refuses it outright, not just this form. */}
            <div>
              <span className="field-label">Department</span>
              <p className="mt-1 truncate rounded-panel border border-ink/10 bg-ink/5 px-3.5 py-2.5 text-[15px] text-ink-40">
                {d.department?.name ?? 'None'}
              </p>
              <span className="field-hint">Locked once set — past reports are split by it.</span>
            </div>
          </div>

          {/* Changing a fee is not retrospective: bills already raised keep the
              fee they were raised at, because the amount is written onto the
              invoice line rather than looked up from here. Said out loud
              because an administrator about to change a price is entitled to
              know which way it cuts. */}
          <p className="mt-3 text-[12.5px] text-ink-40">
            A new fee applies to bills raised from now on. Bills already raised keep what they were
            charged at.
          </p>

          <div className="mt-3.5 flex gap-2">
            <button
              type="button"
              className="btn-primary !px-3 !py-1.5 text-[13px]"
              disabled={busy === `edit-${d.id}`}
              onClick={() => void saveProfile()}
            >
              {busy === `edit-${d.id}` ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              className="btn-secondary !px-3 !py-1.5 text-[13px]"
              disabled={busy === `edit-${d.id}`}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4 p-5">
        <div>
          <p className="mono-label mb-2">Weekly hours</p>

          {d.schedules.length === 0 ? (
            <p className="rounded-panel border border-amber/30 bg-amber-soft/40 p-3 text-[13px]">
              No sessions yet, so this doctor has <strong>no bookable slots</strong>. Add the days
              and times they sit below.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {d.schedules.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-pill border border-ink/12 bg-white px-3 py-1 text-[12.5px]"
                >
                  <span className="font-semibold">{DAYS[s.dayOfWeek]}</span>
                  <span className="font-mono">
                    {s.startTime}–{s.endTime}
                  </span>
                  <span className="text-ink-40">{s.slotMinutes}m</span>
                  <button
                    type="button"
                    className="text-coral-text"
                    aria-label="Remove this session"
                    disabled={busy === s.id}
                    onClick={() => void onRun(s.id, () => api.removeSchedule(s.id))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-ink/8 pt-4">
          <label className="block">
            <span className="field-label">Day</span>
            <select
              className="field-input mt-1 w-[110px]"
              value={session.dayOfWeek}
              onChange={(e) => setSession({ ...session, dayOfWeek: e.target.value })}
            >
              {DAYS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="field-label">From</span>
            <input
              className="field-input mt-1 w-[100px] font-mono"
              value={session.startTime}
              onChange={(e) => setSession({ ...session, startTime: e.target.value })}
              placeholder="09:00"
            />
          </label>

          <label className="block">
            <span className="field-label">To</span>
            <input
              className="field-input mt-1 w-[100px] font-mono"
              value={session.endTime}
              onChange={(e) => setSession({ ...session, endTime: e.target.value })}
              placeholder="13:00"
            />
          </label>

          <label className="block">
            <span className="field-label">Slot</span>
            <select
              className="field-input mt-1 w-[100px]"
              value={session.slotMinutes}
              onChange={(e) => setSession({ ...session, slotMinutes: e.target.value })}
            >
              {['10', '15', '20', '30'].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="btn-secondary"
            disabled={busy === `add-${d.id}` || !locationId}
            onClick={() =>
              void onRun(`add-${d.id}`, () =>
                api.addSchedule(d.id, {
                  locationId,
                  dayOfWeek: Number(session.dayOfWeek),
                  startTime: session.startTime,
                  endTime: session.endTime,
                  slotMinutes: Number(session.slotMinutes),
                }),
              )
            }
          >
            <IconCalendar size={15} />
            Add session
          </button>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <input
        className="field-input mt-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={200}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
