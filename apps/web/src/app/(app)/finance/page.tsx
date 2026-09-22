'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiRequestError,
  type ChargeableService,
  type DiagnosticTest,
  type OutstandingInvoice,
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
  IconCheck,
  IconClock,
  IconReceipt,
  IconSearch,
  IconUserPlus,
  IconX,
} from '@/components/icons';
import { Banner } from '@/components/banner';
import { PromotionPanel } from '@/components/promotion-panel';

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

  /**
   * What each doctor's day looks like, for the card labels.
   *
   * `hours` is the window the clinic is actually offering today, derived from
   * the first and last bookable slot rather than from the raw template — a
   * doctor blocked from 12:00 should read as sitting until 12:00, not 13:00.
   * `nextDay` is only filled in for a doctor who is NOT sitting today.
   */
  const [day, setDay] = useState<
    Record<
      string,
      { consulting: boolean; hours: string | null; reason: string | null; nextDay: string | null }
    >
  >({});
  const [chosenDoctorId, setChosenDoctorId] = useState<string | null>(null);

  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [services, setServices] = useState<ChargeableService[]>([]);

  /**
   * Bills this patient already owes, from the clinic-wide outstanding list.
   *
   * Filtered here rather than server-side: `GET /invoices` already returns the
   * open bills with their patient, and a per-patient endpoint would be a second
   * way to ask the same question. If a clinic ever carries more open bills than
   * that endpoint returns, this is the place that needs the narrower query.
   */
  const [outstanding, setOutstanding] = useState<OutstandingInvoice[]>([]);

  /**
   * A patient who wants tests and no doctor (FR-DIA-10).
   *
   * Its own branch off the patient step rather than a step in the seven: there
   * is no visit, no doctor and no queue in it. The desk prices the tests, takes
   * the money and the patient walks to the department.
   */
  const [walkInTests, setWalkInTests] = useState<DiagnosticTest[]>([]);
  const [walkIn, setWalkIn] = useState(false);
  /** The catalogue call FAILED, as opposed to coming back empty. */
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [referralSource, setReferralSource] = useState<'SELF' | 'EXTERNAL_DOCTOR'>('SELF');
  const [referrerName, setReferrerName] = useState('');
  const [referrerClinic, setReferrerClinic] = useState('');
  const [referrerPhone, setReferrerPhone] = useState('');

  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [approvers, setApprovers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [approversBlocked, setApproversBlocked] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

  const canBill = can('invoice:write');
  const canCollect = can('payment:collect');
  const canDiscount = can('promotion:apply');
  const canWalkIn = can('diagnostic:order:walkin');

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
   * Who is actually consulting today, and until when.
   *
   * This replaced a "N slots free today" count, which was the wrong number on
   * this screen: a walk-in does not occupy a numbered slot, so the count never
   * moved as the desk admitted people. It answered a booking question on a
   * walk-in screen. What the finance person is really being asked is "can I be
   * seen today, and until when" — so that is what the card says.
   *
   * HOW EACH LABEL IS DERIVED, all from `GET /availability`:
   *
   *   consulting — the day returns at least one slot. A doctor who does not sit
   *                today, or is on LEAVE, or is wholly BLOCKED, comes back with
   *                an empty list and a reason, because the availability engine
   *                already subtracts exceptions from the weekly template.
   *   hours      — first slot's start to last slot's end. Derived from the
   *                slots rather than the raw template on purpose: a doctor
   *                blocked from midday should read as sitting until midday.
   *   nextDay    — probed forward one day at a time, up to a week, and only for
   *                a doctor who is not sitting today. Nobody is charged for
   *                this on the common path.
   */
  useEffect(() => {
    if (doctors.length === 0) return;
    let cancelled = false;

    void (async () => {
      const today = clinicToday();

      const entries = await Promise.all(
        doctors.map(async (d) => {
          try {
            const today_ = await api.availability(d.id, today);

            if (today_.slots.length > 0) {
              const first = today_.slots[0]!;
              const last = today_.slots[today_.slots.length - 1]!;
              return [
                d.id,
                {
                  consulting: true,
                  hours: `${first.time}–${localTime(last.endAt)}`,
                  reason: null,
                  nextDay: null,
                },
              ] as const;
            }

            return [
              d.id,
              {
                consulting: false,
                hours: null,
                reason: today_.unavailableReason,
                nextDay: await findNextDay(d.id),
              },
            ] as const;
          } catch {
            // A failed read must not make a doctor look unavailable — that
            // would send a patient away over a dropped request. Unknown reads
            // as selectable, and the server refuses if it truly cannot.
            return [d.id, { consulting: true, hours: null, reason: null, nextDay: null }] as const;
          }
        }),
      );

      if (!cancelled) setDay(Object.fromEntries(entries));
    })();

    return () => {
      cancelled = true;
    };
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

  useEffect(() => {
    if (!canWalkIn) return;
    void (async () => {
      try {
        setWalkInTests((await api.diagnosticCatalogue()).tests);
        setCatalogueFailed(false);
      } catch {
        /**
         * Remembered, not swallowed.
         *
         * This catch used to discard the reason, and an empty catalogue then
         * looked identical to a refused one: the whole walk-in section simply
         * did not render, on a desk that held the permission to use it. It took
         * a bug report to discover the request was 403ing. The desk still works
         * without a catalogue — it just says so now.
         */
        setWalkInTests([]);
        setCatalogueFailed(true);
      }
    })();
  }, [canWalkIn]);

  useEffect(() => {
    if (!patient) {
      setOutstanding([]);
      return;
    }
    void (async () => {
      try {
        const { invoices } = await api.outstandingInvoices();
        setOutstanding(invoices.filter((i) => i.patient.id === patient.id));
      } catch {
        // The rest of the desk works without this; a failure here must not
        // stop somebody being registered and seen.
        setOutstanding([]);
      }
    })();
  }, [patient]);

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
    setChosenDoctorId(null);
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
        /** No visit was opened here — the desk settled a bill that already existed. */
        standalone={!appointmentId}
        onAnother={startOver}
        onQueue={() => router.push('/queue')}
      />
    );
  }

  /**
   * Where the desk is in the seven steps.
   *
   * An outstanding bill opened from "Already owing" is not part of that
   * sequence — there is no visit being opened — so it reports as the bill step
   * rather than falling through to "choose a doctor", which is not what the
   * person is doing.
   */
  const step: Step = !patient ? 1 : !appointmentId ? (invoice ? 4 : 3) : paid ? 7 : invoice ? 4 : 6;

  /**
   * The desk is settling a bill that already existed, not opening a visit.
   *
   * A doctor-ordered test bill arrives this way: raised from inside a
   * consultation that is already over, reached from "Already owing" with no
   * appointment in hand. The seven-step flow does not apply, so the steps that
   * belong to it are put away — otherwise the bill renders below a full grid of
   * doctor cards, off the bottom of the screen, and the Open button looks dead.
   */
  const settlingExistingBill = Boolean(invoice) && !appointmentId;

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

      {/*
        Bills this patient already owes.
        
        Everything else on this screen is about a visit the desk is opening RIGHT
        NOW. A test bill is not that: the doctor raised it from inside a
        consultation that started before the patient walked back out to the
        counter, and until this section existed there was no screen anywhere
        that could reach it. The patient would have been sent to pay for an
        X-ray at a desk with no way to find the charge.
      */}
      {patient && outstanding.length > 0 && !appointmentId && (
        <section className="card p-5">
          <p className="mono-label mb-3">Already owing</p>
          <ul className="space-y-2">
            {outstanding.map((o) => (
              <li
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-ink/10 px-3.5 py-2.5"
              >
                <span className="min-w-0">
                  <span className="block font-mono text-[13px] text-ink-60">{o.number}</span>
                  <span className="block text-[13px] text-ink-40">
                    {new Date(o.issuedAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="font-mono text-[14px] font-semibold tabular-nums">
                    {formatPaise(o.balancePaise)}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary !py-1.5"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        setInvoice(await api.invoice(o.id));
                        setAppointmentId(null);
                      }, 'Could not open that bill.')
                    }
                  >
                    Open
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        A patient who wants a test and no doctor (FR-DIA-10).

        Offered beside the doctor step rather than inside it, because it is not
        a step in the same sequence: no visit is opened, no doctor is chosen,
        and nobody joins the queue. The desk prices the tests, takes the money,
        and points the patient at the department.
      */}
      {patient &&
        canWalkIn &&
        !settlingExistingBill &&
        !appointmentId &&
        (walkInTests.length > 0 || catalogueFailed) && (
          <section className="card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="mono-label">Tests only — no doctor</p>
              {!walkIn && !catalogueFailed && (
                <button
                  type="button"
                  className="btn-secondary !py-1.5"
                  onClick={() => setWalkIn(true)}
                >
                  Sell a test
                </button>
              )}
            </div>

            {catalogueFailed && (
              <p className="field-hint mt-2">
                The list of tests could not be loaded, so nothing can be sold here right now. The
                rest of this desk is unaffected.
              </p>
            )}

            {walkIn && (
              <div className="mt-4 space-y-4">
                <div>
                  <p className="field-label">Which tests</p>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {walkInTests.map((t) => {
                      const on = picked.includes(t.id);
                      return (
                        <li key={t.id}>
                          <label
                            className={`flex cursor-pointer items-center justify-between gap-3 rounded-panel border px-3.5 py-2.5 text-[13.5px] ${
                              on ? 'border-clinical/40 bg-clinical-tint' : 'border-ink/10'
                            }`}
                          >
                            <span className="flex items-center gap-2.5">
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-clinical"
                                checked={on}
                                onChange={() =>
                                  setPicked((p) =>
                                    on ? p.filter((id) => id !== t.id) : [...p, t.id],
                                  )
                                }
                              />
                              <span>
                                <span className="block font-semibold text-ink">{t.name}</span>
                                <span className="block text-[12.5px] text-ink-40">
                                  {t.department.name}
                                </span>
                              </span>
                            </span>
                            <span className="font-mono text-[13px] tabular-nums">
                              {formatPaise(t.pricePaise)}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  {picked.length > 0 && (
                    <p className="mt-2 text-[13.5px]">
                      <span className="mono-label mr-2">Total</span>
                      <span className="font-semibold tabular-nums">
                        {formatPaise(
                          walkInTests
                            .filter((t) => picked.includes(t.id))
                            .reduce((n, t) => n + t.pricePaise, 0),
                        )}
                      </span>
                    </p>
                  )}
                </div>

                <div>
                  <p className="field-label">Who sent them</p>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ['SELF', 'Nobody — they asked for it'],
                        ['EXTERNAL_DOCTOR', 'A doctor elsewhere'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={referralSource === value}
                        className={
                          referralSource === value ? 'btn-secondary !py-1.5' : 'btn-ghost !py-1.5'
                        }
                        onClick={() => setReferralSource(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Printed on the report and counted in the referral report, which
                  is why the name is required and the rest is not. */}
                {referralSource === 'EXTERNAL_DOCTOR' && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label>
                      <span className="field-label">Doctor’s name</span>
                      <input
                        className="field-input !py-2"
                        value={referrerName}
                        onChange={(e) => setReferrerName(e.target.value)}
                        placeholder="Dr S Kulkarni"
                        maxLength={160}
                      />
                    </label>
                    <label>
                      <span className="field-label">Their clinic</span>
                      <input
                        className="field-input !py-2"
                        value={referrerClinic}
                        onChange={(e) => setReferrerClinic(e.target.value)}
                        maxLength={160}
                      />
                    </label>
                    <label>
                      <span className="field-label">Phone</span>
                      <input
                        className="field-input !py-2"
                        value={referrerPhone}
                        onChange={(e) => setReferrerPhone(e.target.value)}
                        maxLength={32}
                      />
                    </label>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary !py-2"
                    disabled={
                      busy ||
                      picked.length === 0 ||
                      (referralSource === 'EXTERNAL_DOCTOR' && referrerName.trim().length < 2)
                    }
                    onClick={() =>
                      run(async () => {
                        const { invoiceId } = await api.raiseWalkInTests({
                          patientId: patient.id,
                          serviceIds: picked,
                          referralSource,
                          ...(referralSource === 'EXTERNAL_DOCTOR'
                            ? {
                                referrerName: referrerName.trim(),
                                ...(referrerClinic.trim()
                                  ? { referrerClinic: referrerClinic.trim() }
                                  : {}),
                                ...(referrerPhone.trim()
                                  ? { referrerPhone: referrerPhone.trim() }
                                  : {}),
                              }
                            : {}),
                        });
                        // Straight to the bill: the next thing the desk does is
                        // take the money, and the department is already told.
                        setInvoice(await api.invoice(invoiceId));
                        setWalkIn(false);
                        setPicked([]);
                      }, 'Could not raise those tests.')
                    }
                  >
                    Raise and bill
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setWalkIn(false);
                      setPicked([]);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

      {/* 3 — the doctor. Not part of settling a bill that already exists. */}
      {patient && !settlingExistingBill && (
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
                const info = day[d.id];
                const locked = appointmentId !== null;
                const loading = info === undefined;
                // Unknown reads as available — a dropped request must not send
                // a patient away.
                const consulting = loading || info.consulting;
                const selected = chosenDoctorId === d.id;
                const price = consultationPrice(d, services);

                return (
                  <button
                    key={d.id}
                    type="button"
                    disabled={locked || !consulting || !locationId}
                    aria-pressed={selected}
                    onClick={() => setChosenDoctorId(d.id)}
                    className={[
                      'rounded-panel border-[1.5px] p-3 text-left transition-colors',
                      // The Book tab's selected-doctor treatment, so the two
                      // screens read as one product.
                      selected
                        ? 'border-clinical bg-clinical-tint'
                        : 'border-ink/10 bg-white enabled:hover:border-ink/25',
                      // Not consulting today is faded and unselectable, which is
                      // a different thing from merely not-chosen.
                      !consulting ? 'opacity-45' : '',
                      locked && !selected ? 'opacity-55' : '',
                    ].join(' ')}
                  >
                    <p className="text-[14px] font-semibold text-ink">{d.fullName}</p>
                    <p className="text-[12.5px] text-ink-40">
                      {d.specialty ?? d.department?.name ?? 'General'}
                      {d.qualification ? ` · ${d.qualification}` : ''}
                    </p>

                    <p
                      className={`mono-label mt-1.5 ${consulting && !loading ? '!text-clinical-text' : ''}`}
                    >
                      {loading
                        ? 'checking…'
                        : info.consulting
                          ? info.hours
                            ? `Consulting ${info.hours} today`
                            : 'Consulting today'
                          : info.nextDay
                            ? `Not available today · next ${dayLabel(info.nextDay)}`
                            : 'Not available today'}

                      {/* What the visit costs, resolved the way billing resolves
                          it, so this never disagrees with the bill that appears
                          after Confirm. Secondary weight — availability is the
                          question actually being asked. */}
                      {!loading && (
                        <span className="!text-ink-40">
                          {price === null
                            ? ' · No consultation charge'
                            : price.fromCatalogue
                              ? ` · ${formatPaise(price.paise)} clinic rate`
                              : ` · ${formatPaise(price.paise)}`}
                        </span>
                      )}
                    </p>

                    {/* The engine's own sentence — "On leave", "Unavailable —
                        equipment", "does not hold a clinic on this day". */}
                    {!loading && !info.consulting && info.reason && (
                      <p className="mt-1 text-[12px] text-ink-40">{info.reason}</p>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/*
            NOTHING EXISTS ON THE SERVER UNTIL THIS BUTTON.
            Clicking a doctor used to open the visit immediately, which burned a
            queue token and raised an invoice on the first click — and the token
            never comes back, because `next_queue_token()` increments a counter
            atomically. Choosing is now local and free; committing is deliberate.
          */}
          {chosenDoctorId && !appointmentId && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !locationId}
                onClick={() => void openVisit(chosenDoctorId)}
              >
                <IconCheck size={16} />
                {busy
                  ? 'Opening…'
                  : `Confirm — open visit with ${doctors.find((d) => d.id === chosenDoctorId)?.fullName ?? 'this doctor'}`}
              </button>
              <button
                type="button"
                className="btn-ghost text-[13px]"
                disabled={busy}
                onClick={() => setChosenDoctorId(null)}
              >
                Clear
              </button>
              <span className="text-[12.5px] text-ink-40">
                The doctor cannot be changed after this.
              </span>
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
      {/*
        Two ways to be looking at a bill.

        The seven-step flow reaches one by opening a visit, so this was gated on
        `appointmentId`. A test bill raised by a doctor from inside a
        consultation has no visit to open here — the desk arrives at it from
        "Already owing" instead, with no appointment in hand — and gating on the
        appointment alone left that button loading an invoice into a section
        that never rendered.
      */}
      {(appointmentId || invoice) && (
        <section className="card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="mono-label">
              {settlingExistingBill ? 'Outstanding bill' : '3 · The bill'}
            </p>
            {settlingExistingBill && (
              <button
                type="button"
                className="btn-ghost text-[13px]"
                onClick={() => setInvoice(null)}
              >
                Close
              </button>
            )}
          </div>

          {!invoice ? (
            <Banner tone="info">
              No services are priced yet, and this doctor has no consultation fee, so no bill was
              raised. Ask your administrator. The patient can go straight to the front desk to be
              checked in.
            </Banner>
          ) : (
            <>
              {/*
                WHEN A CHARGE MAY BE TAKEN OFF.

                Three conditions, and the third is the one worth explaining.

                `canBill` — the permission. `paidPaise === 0` — the invoice
                freezes once money is on it, which the server enforces in
                `loadEditable`; showing a button the API will refuse is worse
                than showing none.

                `discountPaise === 0` — because removing a line while a
                promotion is applied leaves the RECORD wrong even though the
                invoice looks right. The promotion's discount is distributed
                across the lines, so `retotal` shrinks it correctly when a line
                goes — but `promotion_application.discountPaise` was frozen at
                apply time and is append-only, so it keeps claiming the original
                amount, and the finance report reads that row. The clinic would
                be reported as giving away more than it did. Taking the discount
                off first and re-applying it afterwards writes a fresh, correct
                row.
              */}
              <InvoiceTable
                invoice={invoice}
                busy={busy}
                {...(canBill && invoice.paidPaise === 0 && !invoice.activePromotionApplicationId
                  ? {
                      onRemove: (lineId: string) =>
                        run(async () => {
                          setInvoice(await api.removeInvoiceLine(invoice.id, lineId));
                        }, 'Could not remove that charge.'),
                      /**
                       * Same guard as removing, and for the same reason: the
                       * decline writes a line discount, which under an applied
                       * promotion would overwrite that line's share while the
                       * frozen `promotion_application` row kept claiming the
                       * original figure. The server refuses it too.
                       */
                      onDecline: (orderId: string, description: string) =>
                        run(async () => {
                          await api.declineDiagnosticOrder(orderId);
                          setInvoice(await api.invoice(invoice.id));
                        }, `Could not decline ${description}.`),
                    }
                  : {})}
              />

              {/* Declined by mistake? Put it back.
                  A removed test has no line any more — that is the point — so
                  it cannot be shown among the charges. Without this the only
                  way back from a mis-click is a telephone call to the doctor. */}
              {canBill && invoice.removedTests.length > 0 && (
                <div className="mt-3 rounded-panel border border-ink/10 bg-bg-soft px-3.5 py-3">
                  <p className="mono-label mb-2">Taken off this visit</p>
                  <ul className="space-y-1.5">
                    {invoice.removedTests.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[13.5px] text-ink-60">
                          {t.description}
                          {t.service && (
                            <span className="ml-2 font-mono text-[12.5px] text-ink-40">
                              {formatPaise(t.service.pricePaise)}
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          className="btn-ghost !px-2 !py-1 text-[12px]"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api.undeclineDiagnosticOrder(t.id);
                              setInvoice(await api.invoice(invoice.id));
                            }, `Could not put ${t.description} back.`)
                          }
                        >
                          Put it back
                        </button>
                      </li>
                    ))}
                  </ul>
                  {/* Said plainly: the charge is raised fresh, so a repricing
                      between then and now shows up here rather than silently. */}
                  <p className="field-hint">Charged at today’s price.</p>
                </div>
              )}

              {/* Tests this centre does not perform, written by the doctor in
                  the room. Shown here so the desk can say "that one is not done
                  here" before the patient has waited for it. */}
              {(invoice.appointment?.externalTestNote ??
                invoice.visitAppointment?.externalTestNote) && (
                <div className="mt-3 rounded-panel border border-dashed border-ink/20 bg-bg-soft px-3.5 py-3">
                  <p className="mono-label">Not done here — patient to have elsewhere</p>
                  <p className="mt-1 whitespace-pre-wrap text-[13.5px]">
                    {invoice.appointment?.externalTestNote ??
                      invoice.visitAppointment?.externalTestNote}
                  </p>
                </div>
              )}

              {canBill && invoice.paidPaise === 0 && invoice.activePromotionApplicationId && (
                <p className="field-hint mt-2">
                  Take the discount off before adding or removing charges, then apply it again —
                  otherwise the discount stays recorded at the old amount.
                </p>
              )}

              {/* Same guard as removing: changing the charges under an applied
                  discount leaves promotion_application overstating what was
                  given. */}
              {canBill &&
                invoice.paidPaise === 0 &&
                !invoice.activePromotionApplicationId &&
                services.length > 0 && (
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
  return clinicDate(0);
}

/** Clinic-local date, `YYYY-MM-DD`, offset by whole days. */
function clinicDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** An instant rendered as clinic-local `HH:mm`. */
function localTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "Tue 10 Sep" — enough for the desk to tell a patient when to come back. */
function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T06:00:00Z`));
}

/**
 * What this doctor's consultation will actually cost.
 *
 * MIRRORS `BillingService.ensureInvoiceForAppointment` EXACTLY, because a label
 * that disagrees with the bill is worse than no label:
 *
 *   const override   = practitioner.consultationFeePaise;
 *   const pricePaise = override ?? service?.pricePaise ?? null;
 *
 * The doctor's own fee wins over the catalogue — consultants in one clinic
 * routinely charge differently. Falling back to `CONS-NEW` is the half most
 * likely to be forgotten: a doctor with no fee of their own still raises a bill
 * wherever the clinic has priced a consultation, so "no fee set" would have been
 * a lie in exactly the clinics that have a price list.
 *
 * The catalogue comes from the `services` this screen already loaded — that call
 * filters to active services, which is the same condition the billing service
 * uses. No extra request.
 *
 * Returns null only when neither exists, which is the one case where no invoice
 * is raised at all.
 */
function consultationPrice(
  practitioner: Practitioner,
  services: ChargeableService[],
): { paise: number; fromCatalogue: boolean } | null {
  if (practitioner.consultationFeePaise !== null) {
    return { paise: practitioner.consultationFeePaise, fromCatalogue: false };
  }

  const catalogue = services.find((s) => s.code === 'CONS-NEW');
  if (catalogue) return { paise: catalogue.pricePaise, fromCatalogue: true };

  return null;
}

/**
 * The next day this doctor holds a clinic, looking a week ahead.
 *
 * Probed one day at a time through `GET /availability`, because that is the
 * only read the finance desk is allowed: the endpoint that returns a doctor's
 * weekly template, `GET /setup/practitioners`, sits behind `schedule:manage`,
 * which this role deliberately does not hold.
 *
 * Sequential rather than seven calls at once — the answer is usually tomorrow,
 * and a doctor who is not sitting today is the minority case anyway. A week is
 * the ceiling because a weekly template repeats: if nothing is found in seven
 * days there is nothing to find.
 */
async function findNextDay(practitionerId: string): Promise<string | null> {
  for (let ahead = 1; ahead <= 7; ahead++) {
    const date = clinicDate(ahead);
    try {
      const day = await api.availability(practitionerId, date);
      if (day.slots.length > 0) return date;
    } catch {
      return null;
    }
  }
  return null;
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
/**
 * The bill as it stands. Gross, discount and total stay three separate lines.
 *
 * `onRemove` is passed only when charges may still be taken off — see the note
 * on `removableFrom` for what "may" means here.
 */
function InvoiceTable({
  invoice,
  busy,
  onRemove,
  onDecline,
}: {
  invoice: Invoice;
  busy?: boolean;
  onRemove?: (lineId: string) => void;
  /** Declining a test zeroes its charge. Deleting the line is refused. */
  onDecline?: (orderId: string, description: string) => void;
}) {
  return (
    <div className="rounded-panel border border-ink/10 bg-white">
      <div className="flex items-center justify-between border-b border-ink/8 px-4 py-2.5">
        <span className="mono-label">Invoice {invoice.number}</span>
        <span className="mono-label">{invoice.status.replace('_', ' ').toLowerCase()}</span>
      </div>

      <ul className="divide-y divide-ink/6">
        {invoice.lines.map((l, index) => {
          /**
           * THE FIRST LINE IS THE CONSULTATION, AND IT IS NOT REMOVABLE.
           *
           * It is created inside the invoice itself by
           * `ensureInvoiceForAppointment`, so ordered by `createdAt` it is always
           * first; every charge the desk adds comes later. Removing it would
           * leave a bill with no reason to exist — the visit it belongs to would
           * still be open and the patient would owe nothing for being seen.
           *
           * Position rather than `serviceId`: a clinic with no price list raises
           * the consultation line with a null `serviceId`, which an added
           * free-text charge also has, so the id cannot tell them apart.
           */
          const isConsultation = index === 0;

          /**
           * A test's charge is declined, never removed.
           *
           * The order points at this line with a RESTRICT foreign key, so the
           * delete is refused by the database and by `removeLine` above it —
           * offering the X here would only produce an error. Declining takes
           * the charge to zero AND stands the department down, which is the
           * thing the desk actually wants when the patient says no.
           */
          const test = l.diagnosticOrder;
          // A declined test has no line at all, so there is no struck-through
          // state to render here — see `removedTests` on the invoice.
          const declinable = Boolean(onDecline) && test?.status === 'PENDING';
          const removable = Boolean(onRemove) && !isConsultation && !test;

          return (
            <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-[14px] text-ink">{l.description}</span>
                {l.quantity > 1 && (
                  <span className="block text-[12.5px] text-ink-40">
                    {l.quantity} × {formatPaise(l.unitPricePaise)}
                  </span>
                )}
              </span>

              <span className="flex shrink-0 items-center gap-2">
                <span className="text-right">
                  <span className="block font-mono text-[13.5px] text-ink">
                    {formatPaise(l.quantity * l.unitPricePaise)}
                  </span>
                  {l.discountPaise > 0 && (
                    <span className="block font-mono text-[12.5px] text-clinical-text">
                      − {formatPaise(l.discountPaise)}
                    </span>
                  )}
                </span>

                {removable && (
                  <button
                    type="button"
                    className="btn-ghost !px-1.5 !py-1 text-[12px]"
                    disabled={busy}
                    aria-label={`Remove ${l.description}`}
                    title={`Remove ${l.description}`}
                    onClick={() => onRemove?.(l.id)}
                  >
                    <IconX size={14} />
                  </button>
                )}

                {declinable && test && (
                  <button
                    type="button"
                    className="btn-ghost !px-2 !py-1 text-[12px]"
                    disabled={busy}
                    title={`The patient does not want ${l.description}`}
                    onClick={() => onDecline?.(test.id, l.description)}
                  >
                    Decline
                  </button>
                )}
              </span>
            </li>
          );
        })}
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
  standalone,
  onAnother,
  onQueue,
}: {
  standalone?: boolean;
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
          {/* Where the patient goes next is not the same in both cases. Somebody
              who just paid for an X-ray has already been seen and checked in —
              sending them back to reception is a wasted trip across a clinic. */}
          <p className="mt-1 text-[13px] text-ink-60">
            {standalone
              ? 'Send them to the test room — the department can release the result now.'
              : 'Send them to the front desk to be checked in.'}
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
          {!standalone && (
            <button type="button" className="btn-secondary" onClick={onQueue}>
              <IconClock size={16} />
              Open the queue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
