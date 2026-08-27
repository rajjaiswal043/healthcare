'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  api,
  ApiRequestError,
  type ClinicLocation,
  type DayAvailability,
  type Department,
  type PatientSummary,
  type Practitioner,
} from '@/lib/api';
import { formatAge, genderInitial } from '@/lib/format';
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconSearch,
  IconUserPlus,
} from '@/components/icons';

/** Clinic-local YYYY-MM-DD, offset by n days. */
function dateKey(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

const DAYS = Array.from({ length: 14 }, (_, i) => i);

export default function NewAppointmentPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState<string>('');
  const [doctors, setDoctors] = useState<Practitioner[]>([]);
  const [doctorId, setDoctorId] = useState<string>('');
  const [locations, setLocations] = useState<ClinicLocation[]>([]);
  const [locationId, setLocationId] = useState<string>('');
  const [date, setDate] = useState<string>(dateKey());
  const [availability, setAvailability] = useState<DayAvailability | null>(null);
  const [slotStart, setSlotStart] = useState<string>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<{
    token: number | null;
    time: string;
    walkIn: boolean;
    inQueue: boolean;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [d, l] = await Promise.all([api.departments(), api.locations()]);
        setDepartments(d.departments);
        setLocations(l.locations);
        if (l.locations.length > 0) setLocationId(l.locations[0]!.id);
      } catch {
        setError('Could not load clinic setup.');
      }

      /**
       * Arriving from a patient's record with them already chosen.
       *
       * The id still goes through the API rather than being trusted from the
       * URL: the response is what proves the patient exists and belongs to this
       * tenant, and it is where the name shown on screen comes from. A patient
       * banner rendered from a query string would happily display whatever
       * somebody pasted into the address bar.
       */
      const preselected = searchParams.get('patientId');
      if (preselected) {
        try {
          setPatient(await api.getPatient(preselected));
        } catch {
          setError('That patient could not be opened. Search for them below.');
        }
      }
    })();
  }, [searchParams]);

  useEffect(() => {
    void (async () => {
      const { practitioners } = await api.practitioners(departmentId || undefined);
      setDoctors(practitioners);
      setDoctorId((prev) => (practitioners.some((p) => p.id === prev) ? prev : ''));
      setSlotStart('');
    })();
  }, [departmentId]);

  const loadAvailability = useCallback(async () => {
    if (!doctorId) {
      setAvailability(null);
      return;
    }
    try {
      setAvailability(await api.availability(doctorId, date));
      setSlotStart('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load availability.');
    }
  }, [doctorId, date]);

  useEffect(() => {
    void loadAvailability();
  }, [loadAvailability]);

  async function book(walkIn: boolean) {
    if (!patient || !doctorId || !locationId) return;
    setBusy(true);
    setError(null);

    try {
      const result = walkIn
        ? await api.walkIn({
            patientId: patient.id,
            practitionerId: doctorId,
            locationId,
            ...(departmentId ? { departmentId } : {}),
            ...(reason ? { reasonForVisit: reason } : {}),
          })
        : await api.bookAppointment({
            patientId: patient.id,
            practitionerId: doctorId,
            locationId,
            ...(departmentId ? { departmentId } : {}),
            startAt: slotStart,
            ...(reason ? { reasonForVisit: reason } : {}),
          });

      setBooked({
        token: result.tokenNumber,
        time: result.localTime,
        walkIn,
        // A walk-in with an unpaid bill is registered and holds a token, but is
        // not in the waiting list yet. Saying "added to the queue" there would
        // be a lie the front desk discovers at the check-in gate.
        inQueue: result.status === 'ARRIVED',
      });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (booked) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="card overflow-hidden text-center">
          <div className="bg-clinical-tint px-6 pb-6 pt-8">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-clinical text-white shadow">
              <IconCheck size={26} />
            </span>
            <p className="mono-label mt-4 !text-clinical-text">
              {booked.inQueue ? 'Added to the queue' : 'Appointment booked'}
            </p>

            {/* The token is the number the patient walks away with, so it is
                the biggest thing on this screen. It exists from booking now —
                there is no longer a case where a confirmed visit has none. */}
            {booked.token !== null && (
              <>
                <p className="mt-3 font-mono text-[44px] font-bold leading-none text-clinical-text">
                  {booked.token}
                </p>
                <p className="mono-label mt-1">token number</p>
              </>
            )}

            <p className="mt-3 font-display text-[19px] font-bold">{patient?.name}</p>
            <p className="mt-1 text-[13px] text-ink-60">
              {booked.inQueue
                ? 'Waiting to be called.'
                : booked.walkIn
                  ? 'Collect payment, then check them in to join the queue.'
                  : `${booked.time} — they join the queue when they arrive and check in.`}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3 p-6">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setBooked(null);
                setPatient(null);
                setReason('');
                setSlotStart('');
                void loadAvailability();
              }}
            >
              <IconUserPlus size={16} />
              Book another
            </button>
            <button type="button" className="btn-secondary" onClick={() => router.push('/queue')}>
              <IconClock size={16} />
              Open the queue
            </button>
          </div>
        </div>
      </div>
    );
  }

  const selectedDoctor = doctors.find((d) => d.id === doctorId) ?? null;
  const canBook = Boolean(patient && doctorId && locationId && slotStart);
  const canWalkIn = Boolean(patient && doctorId && locationId);

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">OPD</p>
        <h1 className="mt-2 font-display text-[30px] font-bold">
          Book an <em className="accent-words">appointment</em>
        </h1>
        <p className="mt-1 text-[14px] text-ink-60">
          Or add a walk-in straight to the queue — same form, different button.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-card border border-coral/30 bg-coral/8 p-3.5 text-[13.5px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={16} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {/* 1 — patient */}
      <section className="card p-5">
        <p className="mono-label mb-3">1 · Patient</p>
        {patient ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-clinical/25 bg-clinical-tint px-4 py-3">
            <div>
              <p className="font-semibold text-ink">{patient.name}</p>
              <p className="text-[13px] text-ink-60">
                <span className="font-mono text-[12px]">{patient.uhid}</span> · {formatAge(patient)}{' '}
                {genderInitial(patient.gender)} ·{' '}
                <span className="font-mono text-[12px]">{patient.mobile}</span>
              </p>
            </div>
            <button
              type="button"
              className="btn-ghost text-[13px]"
              onClick={() => setPatient(null)}
            >
              Change
            </button>
          </div>
        ) : (
          <PatientPicker onPick={setPatient} />
        )}
      </section>

      {/* 2 — doctor */}
      <section className="card p-5">
        <p className="mono-label mb-3">2 · Doctor</p>

        <div className="flex flex-wrap gap-1.5">
          <Chip active={departmentId === ''} onClick={() => setDepartmentId('')}>
            All departments
          </Chip>
          {departments.map((d) => (
            <Chip key={d.id} active={departmentId === d.id} onClick={() => setDepartmentId(d.id)}>
              {d.name}
            </Chip>
          ))}
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {doctors.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDoctorId(d.id)}
              className={[
                'rounded-panel border-[1.5px] p-3 text-left transition-colors',
                doctorId === d.id
                  ? 'border-clinical bg-clinical-tint'
                  : 'border-ink/10 bg-white hover:border-ink/25',
              ].join(' ')}
            >
              <p className="text-[14px] font-semibold text-ink">{d.fullName}</p>
              <p className="text-[12.5px] text-ink-40">
                {d.specialty ?? d.department?.name ?? '—'}
                {d.qualification ? ` · ${d.qualification}` : ''}
              </p>
            </button>
          ))}
          {doctors.length === 0 && (
            <p className="text-[13.5px] text-ink-40">No doctors in this department.</p>
          )}
        </div>

        {locations.length > 1 && (
          <div className="mt-4">
            <label htmlFor="location" className="field-label">
              Location
            </label>
            <select
              id="location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="field-input"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {/* 3 — day and slot */}
      <section className="card p-5">
        <p className="mono-label mb-3">3 · Day and time</p>

        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-2">
          {DAYS.map((offset) => {
            const key = dateKey(offset);
            const d = new Date(`${key}T12:00:00Z`);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setDate(key)}
                className={[
                  'shrink-0 rounded-panel border-[1.5px] px-3 py-2 text-center transition-colors',
                  date === key
                    ? 'border-clinical bg-clinical text-white'
                    : 'border-ink/10 bg-white hover:border-ink/25',
                ].join(' ')}
              >
                <span className="block font-mono text-[10px] uppercase tracking-label opacity-70">
                  {offset === 0
                    ? 'Today'
                    : d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}
                </span>
                <span className="block text-[15px] font-bold">
                  {d.toLocaleDateString('en-IN', { day: 'numeric', timeZone: 'UTC' })}
                </span>
                <span className="block text-[10.5px] opacity-70">
                  {d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}
                </span>
              </button>
            );
          })}
        </div>

        {!doctorId ? (
          <p className="mt-3 text-[13.5px] text-ink-40">Choose a doctor to see available times.</p>
        ) : availability === null ? (
          <p className="mt-3 text-[13.5px] text-ink-40">Loading…</p>
        ) : availability.slots.length === 0 ? (
          <div className="mt-3 flex items-start gap-2.5 rounded-panel border border-amber/40 bg-amber-soft/40 p-3 text-[13.5px] text-ink">
            <span className="mt-0.5 shrink-0 text-amber-text">
              <IconCalendar size={15} />
            </span>
            <span>{availability.unavailableReason}</span>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
            {availability.slots.map((s) => {
              const full = s.available <= 0;
              return (
                <button
                  key={s.startAt}
                  type="button"
                  disabled={full}
                  onClick={() => setSlotStart(s.startAt)}
                  title={
                    full ? 'Fully booked' : s.overbooking ? 'Overbooking this slot' : undefined
                  }
                  className={[
                    'rounded-tiny border-[1.5px] px-2 py-2 font-mono text-[13px] transition-colors',
                    full
                      ? 'cursor-not-allowed border-ink/8 bg-ink/5 text-ink-20 line-through'
                      : slotStart === s.startAt
                        ? 'border-clinical bg-clinical text-white'
                        : s.overbooking
                          ? 'border-amber/50 bg-amber-soft/40 text-amber-text'
                          : 'border-ink/10 bg-white hover:border-clinical/50',
                  ].join(' ')}
                >
                  {s.time}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 4 — reason and confirm */}
      <section className="card p-5">
        <p className="mono-label mb-3">4 · Reason (optional)</p>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="field-input"
          placeholder="e.g. Fever for 3 days"
          maxLength={300}
        />

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={!canBook || busy}
            onClick={() => void book(false)}
          >
            <IconCalendar size={16} />
            {busy ? 'Booking…' : 'Book appointment'}
          </button>

          {/* Same patient and doctor, no slot — straight into today's queue. */}
          <button
            type="button"
            className="btn-secondary"
            disabled={!canWalkIn || busy}
            title="Add to today's queue now, without a time slot"
            onClick={() => void book(true)}
          >
            <IconClock size={16} />
            Add as walk-in
          </button>

          <Link href="/queue" className="btn-ghost text-[13px]">
            Cancel
          </Link>
        </div>

        {selectedDoctor && patient && (
          <p className="mt-3 text-[12.5px] text-ink-40">
            {slotStart
              ? `${patient.name} with ${selectedDoctor.fullName} — ${availability?.slots.find((s) => s.startAt === slotStart)?.time} on ${date}.`
              : `Pick a time, or add ${patient.name} as a walk-in for today.`}
          </p>
        )}
      </section>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'rounded-pill border-[1.5px] px-3 py-1 text-[13px] font-semibold transition-colors',
        active
          ? 'border-clinical bg-clinical text-white'
          : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25 hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/** Inline patient search — the same one-box search as the patients screen. */
function PatientPicker({ onPick }: { onPick: (p: PatientSummary) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const { patients } = await api.searchPatients(query);
        setResults(patients.slice(0, 6));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div>
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-3.5 text-ink-20">
          <IconSearch size={16} />
        </span>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="field-input-icon"
          placeholder="Search by name, mobile or UHID"
          autoComplete="off"
        />
      </div>

      {searching && <p className="field-hint">Searching…</p>}

      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-ink/6 overflow-hidden rounded-panel border border-ink/10">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p)}
                className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-clinical-tint"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold text-ink">
                    {p.name}
                  </span>
                  <span className="block truncate text-[12.5px] text-ink-40">
                    <span className="font-mono">{p.uhid}</span> · {formatAge(p)}{' '}
                    {genderInitial(p.gender)} · <span className="font-mono">{p.mobile}</span>
                  </span>
                </span>
                <span className="mono-label shrink-0 !text-clinical-text">Select</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {query.trim().length >= 2 && !searching && results.length === 0 && (
        <p className="field-hint">
          No match.{' '}
          <Link
            href="/patients/register"
            className="text-clinical-text underline underline-offset-2"
          >
            Register this patient first
          </Link>
          .
        </p>
      )}
    </div>
  );
}
