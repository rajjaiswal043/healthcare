'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiRequestError,
  type ChargeableService,
  type ClinicLocation,
  type Invoice,
  type PatientSummary,
  type Practitioner,
  type Promotion,
} from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { ReceiptButton } from '@/components/receipt-button';
import { formatAge, formatPaise, genderInitial, parseRupeesToPaise } from '@/lib/format';
import {
  IconAlert,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconInfo,
  IconReceipt,
  IconSearch,
  IconUserPlus,
  IconX,
} from '@/components/icons';

/**
 * The finance desk — FR-FIN-02.
 *
 * Everything one person does for a walk-in patient, in the order it actually
 * happens, on one screen. The point is not that any of these steps are new —
 * every one of them is an endpoint that already existed. The point is that the
 * finance person is not moving between four screens with a patient standing in
 * front of them.
 *
 * The seven steps stay visible as they are completed rather than disappearing,
 * because the questions asked at this desk are backwards ones: "what did you
 * charge?", "which doctor?", "how much did you take off?". A wizard that
 * discards each step as it passes cannot answer them.
 *
 * MONEY IS INTEGER PAISE EVERYWHERE HERE. `formatPaise` on the way to the
 * screen, `parseRupeesToPaise` on the way in from a field, and nothing in
 * between. A division scattered through a component is a rounding error waiting
 * to disagree with the cash drawer.
 */

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export default function FinanceDeskPage() {
  const { can } = useAuth();
  const router = useRouter();

  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [registering, setRegistering] = useState(false);

  const [doctors, setDoctors] = useState<Practitioner[]>([]);
  const [locations, setLocations] = useState<ClinicLocation[]>([]);
  const [locationId, setLocationId] = useState('');
  const [room, setRoom] = useState<Record<string, { available: number; reason: string | null }>>(
    {},
  );

  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [services, setServices] = useState<ChargeableService[]>([]);

  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [approvers, setApprovers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [approversBlocked, setApproversBlocked] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

  const canBill = can('invoice:write');
  const canCollect = can('payment:collect');
  const canDiscount = can('promotion:apply');

  // --- clinic setup, once ---------------------------------------------------

  useEffect(() => {
    void (async () => {
      try {
        const [p, l] = await Promise.all([api.practitioners(), api.locations()]);
        setDoctors(p.practitioners);
        setLocations(l.locations);
        if (l.locations.length > 0) setLocationId(l.locations[0]!.id);
      } catch (err) {
        setError(readable(err, 'Could not load the clinic setup.'));
      }

      /**
       * The service catalogue is optional.
       *
       * Billing is opt-in per tenant: a clinic that has priced nothing raises no
       * invoices and the check-in gate stays open. So a failure here is not an
       * error to shout about — it just means there is nothing to add to a bill,
       * and the screen says so where it matters instead.
       */
      try {
        setServices((await api.services()).services);
      } catch {
        setServices([]);
      }
    })();
  }, []);

  /**
   * Who is consulting today, and whether they still have room.
   *
   * One availability call per doctor. A clinic has a handful of them, and the
   * alternative — asking the receptionist to pick blind and finding out at
   * booking — is the thing this screen exists to remove.
   */
  useEffect(() => {
    if (doctors.length === 0) return;

    void (async () => {
      const today = clinicToday();
      const entries = await Promise.all(
        doctors.map(async (d) => {
          try {
            const day = await api.availability(d.id, today);
            return [
              d.id,
              {
                available: day.slots.reduce((n, s) => n + s.available, 0),
                reason: day.unavailableReason,
              },
            ] as const;
          } catch {
            return [d.id, { available: 0, reason: null }] as const;
          }
        }),
      );
      setRoom(Object.fromEntries(entries));
    })();
  }, [doctors]);

  // --- promotions and the approver list, only when they can be used ---------

  useEffect(() => {
    if (!canDiscount) return;

    void (async () => {
      try {
        setPromotions((await api.promotions(true)).promotions);
      } catch {
        setPromotions([]);
      }

      /**
       * The approver list — id and name of active staff, and nothing else.
       *
       * `approvers()` rather than `staff()`: the latter is behind `user:manage`
       * and 403s for exactly the person this screen was built for. This one is
       * behind `promotion:apply`, which finance holds.
       */
      try {
        setApprovers((await api.approvers()).approvers);
      } catch {
        setApproversBlocked(true);
      }
    })();
  }, [canDiscount]);

  // --- actions --------------------------------------------------------------

  const refreshInvoice = useCallback(async (id: string) => {
    setInvoice(await api.invoice(id));
  }, []);

  async function openVisit(practitionerId: string) {
    if (!patient || !locationId) return;
    setBusy(true);
    setError(null);

    try {
      // The walk-in path, behind `visit:open`. Opening today's visit is not the
      // same power as holding the diary, which is why finance has one and not
      // the other.
      const visit = await api.walkIn({ patientId: patient.id, practitionerId, locationId });
      setAppointmentId(visit.id);

      /**
       * A clinic that has priced nothing raises no invoice, and that is not a
       * failure. The flow continues to the queue without a bill rather than
       * dead-ending here.
       */
      try {
        setInvoice(await api.invoiceForAppointment(visit.id));
      } catch {
        setInvoice(null);
      }
    } catch (err) {
      setError(readable(err, 'Could not open the visit.'));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(readable(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setPatient(null);
    setAppointmentId(null);
    setInvoice(null);
    setPaid(false);
    setError(null);
    setRegistering(false);
  }

  // --- the finished state ---------------------------------------------------

  if (paid && patient) {
    return (
      <Finished
        patient={patient}
        invoice={invoice}
        onAnother={startOver}
        onQueue={() => router.push('/queue')}
      />
    );
  }

  const step: Step = !patient ? 1 : !appointmentId ? 3 : paid ? 7 : invoice ? 4 : 6;

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Finance desk</p>
        <h1 className="mt-2 font-display text-[30px] font-bold">
          Take the <em className="accent-words">payment</em>
        </h1>
        <p className="mt-1 text-[14px] text-ink-60">
          Find or register the patient, open today’s visit, raise the bill and collect — then send
          them to the front desk.
        </p>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      {/* 1 and 2 — the patient */}
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
                {patient.city ? ` · ${patient.city}` : ''}
              </p>
            </div>
            {!appointmentId && (
              <button type="button" className="btn-ghost text-[13px]" onClick={startOver}>
                Change
              </button>
            )}
          </div>
        ) : registering ? (
          <InlineRegister
            onDone={(p) => {
              setPatient(p);
              setRegistering(false);
            }}
            onCancel={() => setRegistering(false)}
          />
        ) : (
          <FindPatient onPick={setPatient} onRegister={() => setRegistering(true)} />
        )}
      </section>

      {/* 3 — the doctor */}
      {patient && (
        <section className="card p-5">
          <p className="mono-label mb-3">2 · Doctor consulting today</p>

          {locations.length > 1 && (
            <label className="mb-3 block">
              <span className="field-label">Location</span>
              <select
                className="field-input"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                disabled={Boolean(appointmentId)}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {doctors.length === 0 ? (
            <p className="text-[13.5px] text-ink-60">
              No doctors are listed yet.{' '}
              <Link
                href="/settings/doctors"
                className="text-clinical-text underline underline-offset-2"
              >
                Add one in settings
              </Link>
              .
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {doctors.map((d) => {
                const slots = room[d.id];
                const chosen = appointmentId !== null;
                return (
                  <button
                    key={d.id}
                    type="button"
                    disabled={busy || chosen || !locationId}
                    onClick={() => void openVisit(d.id)}
                    className={[
                      'rounded-panel border-[1.5px] p-3 text-left transition-colors disabled:opacity-55',
                      'border-ink/10 bg-white enabled:hover:border-ink/25',
                    ].join(' ')}
                  >
                    <p className="text-[14px] font-semibold text-ink">{d.fullName}</p>
                    <p className="text-[12.5px] text-ink-40">
                      {d.specialty ?? d.department?.name ?? 'General'}
                    </p>
                    <p className="mono-label mt-1.5">
                      {slots === undefined
                        ? 'checking…'
                        : slots.reason
                          ? slots.reason
                          : slots.available > 0
                            ? `${slots.available} slots free today`
                            : 'full today — walk-in still possible'}
                    </p>
                  </button>
                );
              })}
            </div>
          )}

          {appointmentId && (
            <p className="mt-3 text-[12.5px] text-ink-40">
              Visit opened. The bill below is attached to it.
            </p>
          )}
        </section>
      )}

      {/* 4, 5 and 6 — the bill */}
      {appointmentId && (
        <section className="card p-5">
          <p className="mono-label mb-3">3 · The bill</p>

          {!invoice ? (
            <Banner tone="info">
              No services are priced yet, and this doctor has no consultation fee, so no bill was
              raised. Ask your administrator. The patient can go straight to the front desk to be
              checked in.
            </Banner>
          ) : (
            <>
              <InvoiceTable invoice={invoice} />

              {canBill && invoice.balancePaise > 0 && services.length > 0 && (
                <AddCharge
                  services={services}
                  busy={busy}
                  onAdd={(input) =>
                    run(async () => {
                      setInvoice(await api.addInvoiceLine(invoice.id, input));
                    }, 'Could not add the charge.')
                  }
                />
              )}

              {/* FR-PRC-02: an empty price list must say so rather than looking
                  like a missing button. The bill exists because the doctor has a
                  fee, but there is nothing else the desk could add to it. */}
              {canBill && invoice.balancePaise > 0 && services.length === 0 && (
                <p className="field-hint mt-4">
                  No services are priced yet, so nothing else can be added to this bill. Ask your
                  administrator.
                </p>
              )}

              {canBill && invoice.lines.length > 1 && invoice.paidPaise === 0 && (
                <p className="field-hint">Remove a charge by clicking the ✕ beside it.</p>
              )}

              {canDiscount && invoice.paidPaise === 0 && (
                <PromotionPanel
                  invoice={invoice}
                  promotions={promotions}
                  approvers={approvers}
                  approversBlocked={approversBlocked}
                  busy={busy}
                  onApply={(input) =>
                    run(async () => {
                      await api.applyPromotion(invoice.id, input);
                      await refreshInvoice(invoice.id);
                    }, 'Could not apply the discount.')
                  }
                  onUndo={() =>
                    run(async () => {
                      await api.removePromotion(invoice.id, 'APPLIED_IN_ERROR');
                      await refreshInvoice(invoice.id);
                    }, 'Could not take the discount off.')
                  }
                />
              )}

              {canCollect && invoice.balancePaise > 0 && (
                <CollectPayment
                  invoice={invoice}
                  busy={busy}
                  onCollect={(input) =>
                    run(async () => {
                      const updated = await api.collectPayment(invoice.id, input);
                      setInvoice(updated);
                      if (updated.balancePaise <= 0) setPaid(true);
                    }, 'Could not record the payment.')
                  }
                />
              )}

              {invoice.balancePaise <= 0 && !paid && (
                <div className="mt-4">
                  <Banner tone="ok">
                    Nothing outstanding. Send the patient to the front desk to be checked in.
                  </Banner>
                  <button type="button" className="btn-primary mt-3" onClick={() => setPaid(true)}>
                    <IconCheck size={16} />
                    Done
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <p className="text-[12.5px] text-ink-40">Step {step} of 7.</p>
    </div>
  );
}

// --- pieces -----------------------------------------------------------------

/** Clinic-local today. The clinic runs on IST; the browser may not. */
function clinicToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * One place that turns a thrown thing into a sentence.
 *
 * A suspended clinic is the case worth naming: the API answers every write with
 * CLINIC_SUSPENDED and a message the receptionist can act on, and swallowing it
 * behind "something went wrong" would leave them phoning the wrong person.
 */
function readable(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.error.message;
  return fallback;
}

function Banner({ tone, children }: { tone: 'error' | 'info' | 'ok'; children: React.ReactNode }) {
  const skin =
    tone === 'error'
      ? 'border-coral/30 bg-coral/8 text-coral-text'
      : tone === 'ok'
        ? 'border-clinical/30 bg-clinical-tint text-clinical-text'
        : 'border-ink/12 bg-bg-soft text-ink-60';

  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`flex items-start gap-2.5 rounded-card border p-3.5 text-[13.5px] ${skin}`}
    >
      <span className="mt-0.5 shrink-0">
        {tone === 'error' ? (
          <IconAlert size={16} />
        ) : tone === 'ok' ? (
          <IconCheckCircle size={16} />
        ) : (
          <IconInfo size={16} />
        )}
      </span>
      <span>{children}</span>
    </div>
  );
}

/** The same one-box search as the patients screen, with a way out to registering. */
function FindPatient({
  onPick,
  onRegister,
}: {
  onPick: (p: PatientSummary) => void;
  onRegister: () => void;
}) {
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
        setResults((await api.searchPatients(query)).patients.slice(0, 6));
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
          placeholder="Search by name, mobile, UHID or ABHA"
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
                  {/* Enough to tell two people of the same name apart. */}
                  <span className="block truncate text-[12.5px] text-ink-40">
                    <span className="font-mono">{p.uhid}</span> · {formatAge(p)}{' '}
                    {genderInitial(p.gender)} · <span className="font-mono">{p.mobile}</span>
                    {p.city ? ` · ${p.city}` : ''}
                  </span>
                </span>
                <span className="mono-label shrink-0 !text-clinical-text">Select</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="btn-secondary text-[13px]" onClick={onRegister}>
          <IconUserPlus size={15} />
          Register a new patient
        </button>
        {query.trim().length >= 2 && !searching && results.length === 0 && (
          <span className="text-[12.5px] text-ink-40">No match for “{query.trim()}”.</span>
        )}
      </div>
    </div>
  );
}

/**
 * Registration without leaving the screen.
 *
 * The short form: name, sex, age and mobile is all the API requires, and a
 * patient standing at a finance desk is not the moment to ask for a postcode.
 * The full form on /patients/register still exists for everything else.
 *
 * Duplicate detection is the existing one, in both halves: weak matches are
 * shown while typing, and a strong match comes back from the server as
 * POSSIBLE_DUPLICATE and blocks until the person at the desk says it is
 * genuinely somebody else.
 */
function InlineRegister({
  onDone,
  onCancel,
}: {
  onDone: (p: PatientSummary) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [gender, setGender] = useState('FEMALE');
  const [ageYears, setAgeYears] = useState('');
  const [mobile, setMobile] = useState('');
  const [city, setCity] = useState('');
  const [consent, setConsent] = useState(true);

  const [weak, setWeak] = useState<Array<{ id: string; name: string; uhid: string }>>([]);
  const [blocking, setBlocking] = useState<Array<{ id: string; name: string; uhid: string }>>([]);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const digits = mobile.replace(/\D/g, '').slice(-10);
    if (name.trim().length < 3 || !/^[6-9]\d{9}$/.test(digits)) {
      setWeak([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const { duplicates } = await api.checkDuplicates({ name: name.trim(), mobile: digits });
        setWeak(duplicates.filter((d) => d.confidence === 'WEAK'));
      } catch {
        // A failed duplicate check must never block registration — the server
        // checks again on submit.
        setWeak([]);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [name, mobile]);

  async function submit(confirmedNotDuplicate: boolean) {
    setSaving(true);
    setError(null);
    setFieldErrors([]);

    try {
      const { patient } = await api.registerPatient({
        name: name.trim(),
        gender,
        mobile,
        consentCareDelivery: consent,
        consentMarketing: false,
        ...(ageYears ? { ageYears: Number(ageYears) } : {}),
        ...(city ? { city } : {}),
        ...(confirmedNotDuplicate ? { confirmedNotDuplicate: true } : {}),
      });
      onDone(patient);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.error.details?.code === 'POSSIBLE_DUPLICATE') {
          setBlocking(err.error.details.duplicates ?? []);
        } else {
          setError(err.error.message);
          setFieldErrors(err.error.details?.fieldErrors ?? []);
        }
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      {error && <Banner tone="error">{error}</Banner>}
      {fieldErrors.length > 0 && (
        <ul className="field-error list-inside list-disc">
          {fieldErrors.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      {blocking.length > 0 && (
        <div className="rounded-card border border-coral/30 bg-coral/8 p-3.5">
          <p className="text-[13.5px] font-semibold text-coral-text">
            Somebody with this name and mobile already exists.
          </p>
          <ul className="mt-1.5 space-y-0.5 text-[13px] text-ink-60">
            {blocking.map((d) => (
              <li key={d.id}>
                {d.name} · <span className="font-mono text-[12px]">{d.uhid}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12.5px] text-ink-40">
            Use the existing record if this is the same person. Registering again gives them a
            second UHID and splits their history in two.
          </p>
          <button
            type="button"
            className="btn-danger mt-2.5 text-[13px]"
            disabled={saving}
            onClick={() => void submit(true)}
          >
            This is a different person — register anyway
          </button>
        </div>
      )}

      {blocking.length === 0 && weak.length > 0 && (
        <div className="rounded-card border border-ink/12 bg-bg-soft p-3.5 text-[13px] text-ink-60">
          <p className="font-semibold text-ink">Possibly already registered</p>
          <ul className="mt-1 space-y-0.5">
            {weak.map((d) => (
              <li key={d.id}>
                {d.name} · <span className="font-mono text-[12px]">{d.uhid}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="field-label">Full name</span>
          <input
            className="field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          <span className="field-label">Mobile</span>
          <input
            className="field-input font-mono"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            inputMode="numeric"
            placeholder="10 digits"
            required
          />
        </label>
        <label>
          <span className="field-label">Sex</span>
          <select
            className="field-input"
            value={gender}
            onChange={(e) => setGender(e.target.value)}
          >
            <option value="FEMALE">Female</option>
            <option value="MALE">Male</option>
            <option value="OTHER">Other</option>
            <option value="UNKNOWN">Not stated</option>
          </select>
        </label>
        <label>
          <span className="field-label">Age in years</span>
          <input
            className="field-input"
            value={ageYears}
            onChange={(e) => setAgeYears(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="sm:col-span-2">
          <span className="field-label">City</span>
          <input className="field-input" value={city} onChange={(e) => setCity(e.target.value)} />
        </label>
      </div>

      <label className="flex items-start gap-2.5 text-[13.5px] text-ink-60">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          The patient consents to their records being held for their care. Required — this is the
          DPDP consent captured at registration.
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={saving || !consent}>
          <IconUserPlus size={16} />
          {saving ? 'Registering…' : 'Register and continue'}
        </button>
        <button type="button" className="btn-ghost text-[13px]" onClick={onCancel}>
          Back to search
        </button>
      </div>
    </form>
  );
}

/** The bill as it stands. Gross, discount and total stay three separate lines. */
function InvoiceTable({ invoice }: { invoice: Invoice }) {
  return (
    <div className="rounded-panel border border-ink/10 bg-white">
      <div className="flex items-center justify-between border-b border-ink/8 px-4 py-2.5">
        <span className="mono-label">Invoice {invoice.number}</span>
        <span className="mono-label">{invoice.status.replace('_', ' ').toLowerCase()}</span>
      </div>

      <ul className="divide-y divide-ink/6">
        {invoice.lines.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-[14px] text-ink">{l.description}</span>
              {l.quantity > 1 && (
                <span className="block text-[12.5px] text-ink-40">
                  {l.quantity} × {formatPaise(l.unitPricePaise)}
                </span>
              )}
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-mono text-[13.5px] text-ink">
                {formatPaise(l.quantity * l.unitPricePaise)}
              </span>
              {l.discountPaise > 0 && (
                <span className="block font-mono text-[12.5px] text-clinical-text">
                  − {formatPaise(l.discountPaise)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="space-y-1 border-t border-ink/8 px-4 py-3">
        <Row label="Billed" value={formatPaise(invoice.subtotalPaise)} />
        {invoice.discountPaise > 0 && (
          <Row label="Discount" value={`− ${formatPaise(invoice.discountPaise)}`} accent />
        )}
        {invoice.taxPaise > 0 && <Row label="Tax" value={formatPaise(invoice.taxPaise)} />}
        <Row label="Total" value={formatPaise(invoice.totalPaise)} bold />
        {invoice.paidPaise > 0 && (
          <Row label="Paid" value={`− ${formatPaise(invoice.paidPaise)}`} />
        )}
        <Row label="Balance" value={formatPaise(invoice.balancePaise)} bold />
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: string;
  bold?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-[13.5px]">
      <span className={bold ? 'font-semibold text-ink' : 'text-ink-60'}>{label}</span>
      <span
        className={[
          'font-mono',
          bold ? 'font-semibold text-ink' : accent ? 'text-clinical-text' : 'text-ink-60',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

function AddCharge({
  services,
  busy,
  onAdd,
}: {
  services: ChargeableService[];
  busy: boolean;
  onAdd: (input: { serviceId: string }) => void;
}) {
  const [serviceId, setServiceId] = useState('');

  return (
    <div className="mt-4 flex flex-wrap items-end gap-2">
      <label className="min-w-[220px] flex-1">
        <span className="field-label">Add a charge</span>
        <select
          className="field-input"
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">Choose a service…</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {formatPaise(s.pricePaise)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy || !serviceId}
        onClick={() => {
          onAdd({ serviceId });
          setServiceId('');
        }}
      >
        Add
      </button>
    </div>
  );
}

/**
 * Applying a discount the administrator already set up.
 *
 * The approver is mandatory and is a person, not free text. Without it the
 * record shows the finance person gave away money and shows nothing about the
 * instruction they were following — and the person most exposed by that gap is
 * the finance person, which is why the field cannot be skipped.
 */
function PromotionPanel({
  invoice,
  promotions,
  approvers,
  approversBlocked,
  busy,
  onApply,
  onUndo,
}: {
  invoice: Invoice;
  promotions: Promotion[];
  approvers: Array<{ id: string; fullName: string }>;
  approversBlocked: boolean;
  busy: boolean;
  onApply: (input: { promotionId: string; authorisedByUserId: string }) => void;
  onUndo: () => void;
}) {
  const [promotionId, setPromotionId] = useState('');
  const [authorisedByUserId, setAuthorisedByUserId] = useState('');

  if (invoice.discountPaise > 0) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-panel border border-clinical/25 bg-clinical-tint px-4 py-3">
        <p className="text-[13.5px] text-clinical-text">
          <span className="font-semibold">{formatPaise(invoice.discountPaise)}</span> discount
          applied. The fee still reads {formatPaise(invoice.subtotalPaise)}.
        </p>
        <button type="button" className="btn-ghost text-[13px]" disabled={busy} onClick={onUndo}>
          <IconX size={14} />
          Take it off
        </button>
      </div>
    );
  }

  if (promotions.length === 0) {
    return (
      <p className="field-hint mt-4">
        No discounts are set up, or none is valid today. An administrator adds them in settings.
      </p>
    );
  }

  return (
    <div className="mt-4 rounded-panel border border-ink/10 bg-bg-soft p-3.5">
      <p className="mono-label mb-2.5">Discount</p>

      {approversBlocked ? (
        <Banner tone="error">
          A discount needs the person who authorised it named, and the list of staff could not be
          loaded. Try again, or ask an administrator to apply it.
        </Banner>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[200px] flex-1">
            <span className="field-label">Promotion</span>
            <select
              className="field-input"
              value={promotionId}
              onChange={(e) => setPromotionId(e.target.value)}
            >
              <option value="">None</option>
              {promotions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.type === 'PERCENTAGE' ? `${p.value}%` : formatPaise(p.value)}
                </option>
              ))}
            </select>
          </label>

          <label className="min-w-[200px] flex-1">
            <span className="field-label">Authorised by</span>
            <select
              className="field-input"
              value={authorisedByUserId}
              onChange={(e) => setAuthorisedByUserId(e.target.value)}
            >
              <option value="">Who approved it?</option>
              {approvers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !promotionId || !authorisedByUserId}
            onClick={() => onApply({ promotionId, authorisedByUserId })}
          >
            Apply
          </button>
        </div>
      )}

      <p className="field-hint">
        The fee stays as it is and the discount shows as a reduction, so the clinic can always say
        how much it gave away.
      </p>
    </div>
  );
}

function CollectPayment({
  invoice,
  busy,
  onCollect,
}: {
  invoice: Invoice;
  busy: boolean;
  onCollect: (input: { mode: string; amountPaise: number }) => void;
}) {
  const [mode, setMode] = useState('CASH');
  const [amount, setAmount] = useState(() => (invoice.balancePaise / 100).toFixed(2));

  useEffect(() => {
    setAmount((invoice.balancePaise / 100).toFixed(2));
  }, [invoice.balancePaise]);

  const paise = parseRupeesToPaise(amount);
  const valid = paise !== null && paise > 0;

  return (
    <div className="mt-4 rounded-panel border border-ink/10 bg-white p-3.5">
      <p className="mono-label mb-2.5">Payment</p>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {['CASH', 'UPI', 'CARD'].map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={[
              'rounded-pill border-[1.5px] px-3 py-1 text-[13px] font-semibold transition-colors',
              mode === m
                ? 'border-clinical bg-clinical text-white'
                : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25 hover:text-ink',
            ].join(' ')}
          >
            {m === 'CASH' ? 'Cash' : m}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[160px]">
          <span className="field-label">Amount in rupees</span>
          <input
            className="field-input font-mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !valid}
          onClick={() => valid && onCollect({ mode, amountPaise: paise })}
        >
          <IconReceipt size={16} />
          {busy ? 'Recording…' : `Take ${formatPaise(paise ?? 0)}`}
        </button>
      </div>

      {!valid && amount.trim() !== '' && <p className="field-error">That is not an amount.</p>}
    </div>
  );
}

/**
 * Done.
 *
 * There is no receipt to print yet — that is a later phase — so this says what
 * happened and where the patient goes, rather than pretending a printer exists.
 */
function Finished({
  patient,
  invoice,
  onAnother,
  onQueue,
}: {
  patient: PatientSummary;
  invoice: Invoice | null;
  onAnother: () => void;
  onQueue: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg">
      <div className="card overflow-hidden text-center">
        <div className="bg-clinical-tint px-6 pb-6 pt-8">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-clinical text-white shadow">
            <IconCheck size={26} />
          </span>
          <p className="mono-label mt-4 !text-clinical-text">Nothing outstanding</p>
          <p className="mt-3 font-display text-[19px] font-bold">{patient.name}</p>
          <p className="mt-1 text-[13px] text-ink-60">
            Send them to the front desk to be checked in.
          </p>
        </div>

        {invoice && (
          <div className="space-y-1 border-t border-ink/8 px-6 py-4 text-left">
            <Row label={`Invoice ${invoice.number}`} value="" />
            <Row label="Billed" value={formatPaise(invoice.subtotalPaise)} />
            {invoice.discountPaise > 0 && (
              <Row label="Discount" value={`− ${formatPaise(invoice.discountPaise)}`} accent />
            )}
            <Row label="Total" value={formatPaise(invoice.totalPaise)} bold />
            <Row label="Paid" value={formatPaise(invoice.paidPaise)} />
            <p className="pt-2 text-[12.5px] text-ink-40">A printed receipt is not built yet.</p>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-3 p-6">
          {/* FR-RCP-01: available immediately after taking the payment. */}
          {invoice && <ReceiptButton invoice={invoice} className="btn-primary" />}
          <button type="button" className="btn-secondary" onClick={onAnother}>
            <IconUserPlus size={16} />
            Next patient
          </button>
          <button type="button" className="btn-secondary" onClick={onQueue}>
            <IconClock size={16} />
            Open the queue
          </button>
        </div>
      </div>
    </div>
  );
}
