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

/** 0 = Sunday, matching the schedule rows and JavaScript's getDay(). */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const rupees = (paise: number | null) => (paise === null ? '' : String(Math.round(paise / 100)));
const paise = (rupees: string) => (rupees.trim() === '' ? undefined : Number(rupees) * 100);

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

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'That did not work.');
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
        <DoctorCard key={d.id} doctor={d} locations={locations} busy={busy} onRun={run} />
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
  busy,
  onRun,
}: {
  doctor: SetupPractitioner;
  locations: ClinicLocation[];
  busy: string | null;
  onRun: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [session, setSession] = useState({
    dayOfWeek: '1',
    startTime: '09:00',
    endTime: '13:00',
    slotMinutes: '15',
  });

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
      </header>

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
