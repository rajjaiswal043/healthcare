'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BackButton } from '@/components/back-button';
import {
  api,
  ApiRequestError,
  type EncounterSummary,
  type PatientBilling,
  type PatientCorrection,
  type PatientDetail,
  type PatientTest,
  type TimelineEvent,
} from '@/lib/api';
import { PatientCorrectionDialog } from '@/components/patient-correction-dialog';
import { PrintReceiptButton } from '@/components/receipt-button';
import { useAuth } from '@/components/auth-provider';
import { formatAge, formatPaise, genderInitial, payMethodLabel } from '@/lib/format';
import { initialsOf } from '@/lib/role-signature';
import { AllergyLine } from './allergy-line';
import {
  IconAlert,
  IconArrowLeft,
  IconCalendar,
  IconCheckCircle,
  IconClock,
  IconIdCard,
  IconPhone,
  IconReceipt,
  IconRefresh,
  IconShieldCheck,
  IconStethoscope,
  IconUserPlus,
} from '@/components/icons';

type Tab = 'timeline' | 'clinical' | 'billing' | 'details';

const TABS: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
  { key: 'timeline', label: 'Timeline', icon: <IconClock size={14} /> },
  { key: 'clinical', label: 'Clinical', icon: <IconStethoscope size={14} /> },
  { key: 'billing', label: 'Billing', icon: <IconReceipt size={14} /> },
  { key: 'details', label: 'Details', icon: <IconIdCard size={14} /> },
];

/**
 * How the feed draws each kind of thing that can happen to a patient.
 *
 * A shape and a colour per kind, so a year of history is scannable before it is
 * read — money green, bills amber, clinical teal, the clerical ones quiet. The
 * icon does the work a bare dot could not: it says WHAT happened from across
 * the desk, which is how a timeline is actually used.
 */
const EVENT_STYLE: Record<
  TimelineEvent['kind'],
  { tone: string; icon: React.ReactNode; label: string }
> = {
  REGISTERED: {
    tone: 'bg-ink/8 text-ink-60',
    icon: <IconUserPlus size={13} />,
    label: 'Registered',
  },
  APPOINTMENT: {
    tone: 'bg-clinical-soft text-clinical-text',
    icon: <IconCalendar size={13} />,
    label: 'Visit',
  },
  CONSULTATION: {
    tone: 'bg-clinical-soft text-clinical-text',
    icon: <IconStethoscope size={13} />,
    label: 'Consultation',
  },
  TEST: {
    tone: 'bg-clinical-tint text-clinical-text',
    icon: <IconShieldCheck size={13} />,
    label: 'Test',
  },
  DOCUMENT: { tone: 'bg-ink/8 text-ink-60', icon: <IconIdCard size={13} />, label: 'File' },
  INVOICE: {
    tone: 'bg-amber-soft text-amber-text',
    icon: <IconReceipt size={13} />,
    label: 'Bill',
  },
  PAYMENT: {
    tone: 'bg-green-soft text-green-text',
    icon: <IconCheckCircle size={13} />,
    label: 'Payment',
  },
  CORRECTION: {
    tone: 'bg-ink/8 text-ink-60',
    icon: <IconRefresh size={13} />,
    label: 'Correction',
  },
};

/** Consent purposes, in the order a clinic thinks about them. */
const CONSENT_LABELS: Record<string, string> = {
  CARE_DELIVERY: 'Care delivery',
  COMMUNICATIONS: 'Communications',
  MARKETING: 'Marketing',
  ABDM_LINKING: 'ABDM linking',
  TELEHEALTH: 'Telehealth',
};

const STATUS_TONE: Record<string, string> = {
  FULFILLED: 'badge-green',
  IN_PROGRESS: 'badge-clinical',
  ARRIVED: 'badge-amber',
  BOOKED: 'badge-neutral',
  CANCELLED: 'badge-coral',
  NO_SHOW: 'badge-coral',
};

export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();

  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [encounters, setEncounters] = useState<EncounterSummary[] | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [tab, setTab] = useState<Tab>('timeline');

  /**
   * Each tab fetches the first time it is opened, and not before.
   *
   * A receptionist looking up a phone number should not pay for a year of
   * billing history, and the 360 is four reads precisely so it does not have to
   * be one. Null means "not asked for yet", which is why these are not `[]`.
   */
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [cursor, setCursor] = useState<{ at: string; id: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [billing, setBilling] = useState<PatientBilling | null>(null);
  const [tests, setTests] = useState<PatientTest[] | null>(null);
  /** Null until an administrator asks for them — see the panel at the bottom. */
  const [corrections, setCorrections] = useState<PatientCorrection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const mayReadNotes = can('consultation:read');

  /** Named so a correction can re-read the record without duplicating this. */
  const load = useCallback(async () => {
    try {
      setPatient(await api.getPatient(id));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the patient.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Fill whichever tab was just opened, once.
   *
   * Keyed on the tab rather than the page, so nothing is fetched for a record
   * somebody glanced at. Each guard is `=== null`, meaning "never asked" — an
   * empty result is a real answer and must not be requested again on every
   * switch back.
   */
  useEffect(() => {
    void (async () => {
      try {
        if (tab === 'timeline' && events === null) {
          const page = await api.patientTimeline(id);
          setEvents(page.events);
          setCursor(page.nextCursor);
        }
        if (tab === 'billing' && billing === null && can('invoice:read')) {
          setBilling(await api.patientBilling(id));
        }
        if (tab === 'clinical' && tests === null && can('diagnostic:read')) {
          setTests((await api.patientTests(id)).orders);
        }
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.error.message : 'Could not load that tab.');
      }
    })();
  }, [tab, id, events, billing, tests, can]);

  /**
   * Open a film or a report.
   *
   * THE URL IS FETCHED AT CLICK TIME and expires in five minutes, which is why
   * this is a button and not an anchor with an href: a link rendered when the
   * page loaded would be dead by the time somebody came back to it, and a dead
   * link to a patient's X-ray reads as a lost X-ray.
   *
   * Same path the consultation screen and the worklist use — one way to reach a
   * clinical document, with one audit trail behind it.
   */
  async function openDocument(documentId: string) {
    try {
      const { url } = await api.documentUrl(documentId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not open that file.');
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.patientTimeline(id, cursor);
      setEvents((prev) => [...(prev ?? []), ...page.events]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Clinical notes are fetched separately and only by those allowed to read
   * them. Folding them into the patient response would mean the front desk's
   * request either carries data they may not see, or the endpoint returns a
   * different shape per role — and a response whose shape depends on the caller
   * is a response nobody can type.
   */
  useEffect(() => {
    if (!mayReadNotes) return;
    void (async () => {
      try {
        setEncounters((await api.patientEncounters(id)).encounters);
      } catch {
        // A failure here must not take the page down — the demographics above
        // are still worth showing.
        setEncounters([]);
      }
    })();
  }, [id, mayReadNotes]);

  if (loading) return <p className="text-[14px] text-ink-60">Loading…</p>;

  if (!patient) {
    return (
      <div className="card p-6">
        <p className="text-[14px] text-coral-text">{error ?? 'Patient not found.'}</p>
        <Link href="/patients" className="btn-secondary mt-4">
          <IconArrowLeft size={15} />
          Back to patients
        </Link>
      </div>
    );
  }

  const address = [patient.addressLine, patient.city, patient.state, patient.postalCode]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="space-y-5">
      {/* The identity band.
          Everything somebody needs to be sure they have the right person, in
          one block they never scroll past: the name, the number, and the one
          clinical fact that changes what a doctor does next. The tint is the
          clinic's own accent at its lightest — enough to lift this off the
          record below without becoming a second colour scheme. */}
      <header className="overflow-hidden rounded-card-lg border border-ink/8 bg-gradient-to-br from-clinical-tint via-card to-card shadow">
        <div className="flex flex-wrap items-start gap-5 p-6">
          <BackButton fallback="/patients" className="btn-ghost -ml-1 mt-1 !px-2 !py-2" />

          {/* Initials, not a photograph: a clinic holds no photographs, and an
              empty avatar frame on every record reads as missing data. */}
          <span
            aria-hidden
            className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-clinical/10 font-display text-[22px] font-bold text-clinical-text ring-1 ring-clinical/20"
          >
            {initialsOf(patient.name)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-[30px] font-bold leading-tight">{patient.name}</h1>
              {!patient.isActive && <span className="badge badge-coral">Inactive</span>}
              {patient.bloodGroup !== 'UNKNOWN' && (
                <span className="badge badge-coral">
                  {patient.bloodGroup.replace('_POSITIVE', '+').replace('_NEGATIVE', '−')}
                </span>
              )}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-ink-60">
              <span className="font-mono font-semibold text-ink">{patient.uhid}</span>
              <span className="text-ink-20">|</span>
              <span>
                {formatAge(patient)} {genderInitial(patient.gender)}
              </span>
              <span className="text-ink-20">|</span>
              <span className="inline-flex items-center gap-1.5 font-mono">
                <IconPhone size={12} />
                {patient.mobile}
              </span>
            </div>

            <AllergyLine allergies={patient.allergies} reviewedAt={patient.allergiesReviewedAt} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {can('patient:write') && (
              <button type="button" className="btn-secondary" onClick={() => setCorrecting(true)}>
                <IconIdCard size={16} />
                Correct details
              </button>
            )}

            {can('appointment:write') && (
              <Link href={`/appointments/new?patientId=${patient.id}`} className="btn-primary">
                <IconCalendar size={16} />
                Book
              </Link>
            )}
          </div>
        </div>

        {/* The figures sit inside the band on a recessed strip, so the record
            reads as one object rather than a header and four loose boxes. The
            gap between them IS the background showing through. */}
        <dl className="grid grid-cols-2 gap-px border-t border-ink/8 bg-ink/6 sm:grid-cols-4">
          <Metric label="Visits" value={String(patient.stats.totalVisits)} />
          <Metric label="Completed" value={String(patient.stats.completedVisits)} />
          <Metric
            label="Last seen"
            value={
              patient.stats.lastVisitAt
                ? new Date(patient.stats.lastVisitAt).toLocaleDateString('en-IN', {
                    day: '2-digit',
                    month: 'short',
                  })
                : '—'
            }
          />
          {can('invoice:read') && (
            <Metric
              label="Outstanding"
              value={billing ? formatPaise(billing.outstandingPaise) : '—'}
              tone={billing && billing.outstandingPaise > 0 ? 'text-amber-text' : undefined}
            />
          )}
        </dl>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-panel border border-coral/30 bg-coral/8 p-3 text-[13px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={15} />
          </span>
          <span>{error}</span>
        </div>
      )}

      <div
        role="tablist"
        aria-label="Patient record"
        className="inline-flex flex-wrap gap-1 rounded-pill border border-ink/8 bg-bg-soft p-1"
      >
        {TABS.filter((t) => t.key !== 'billing' || can('invoice:read')).map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={on}
              onClick={() => setTab(t.key)}
              className={[
                'flex items-center gap-2 rounded-pill px-4 py-1.5 text-[13px] font-semibold transition-all',
                on ? 'bg-card text-clinical-text shadow-sm' : 'text-ink-40 hover:text-ink',
              ].join(' ')}
            >
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'timeline' && (
        <section className="card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="font-display text-[17px] font-bold">Activity</h2>
            <p className="mono-label">Newest first</p>
          </div>

          {events === null ? (
            <p className="field-hint mt-2">Loading…</p>
          ) : events.length === 0 ? (
            <p className="field-hint mt-2">Nothing has happened to this record yet.</p>
          ) : (
            <>
              <ol className="mt-5 space-y-0">
                {events.map((e, i) => {
                  const style = EVENT_STYLE[e.kind];
                  return (
                    <li key={`${e.kind}-${e.id}`} className="group flex gap-4">
                      {/* The rail: an icon per event, joined by a line that
                          stops at the last one rather than trailing into
                          nothing. */}
                      <span className="flex flex-col items-center">
                        <span
                          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ring-4 ring-card ${style.tone}`}
                        >
                          {style.icon}
                        </span>
                        {i < events.length - 1 && (
                          <span className="w-px flex-1 bg-gradient-to-b from-ink/12 to-ink/5" />
                        )}
                      </span>

                      <span className="min-w-0 flex-1 pb-6">
                        <span className="-mt-0.5 block rounded-panel px-3 py-2 transition-colors group-hover:bg-bg-soft">
                          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span className="text-[14px] font-semibold">{e.summary}</span>
                            <span className="mono-label">{style.label}</span>
                            <span className="ml-auto whitespace-nowrap text-[11.5px] tabular-nums text-ink-40">
                              {new Date(e.at).toLocaleString('en-IN', {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })}
                            </span>
                          </span>
                          {e.detail && (
                            <span className="mt-0.5 block text-[12.5px] text-ink-60">
                              {e.detail}
                            </span>
                          )}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>

              {cursor ? (
                <button
                  type="button"
                  className="btn-secondary !py-1.5 !text-[12.5px]"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              ) : (
                <p className="field-hint">That is the whole record.</p>
              )}
            </>
          )}
        </section>
      )}

      {tab === 'billing' && can('invoice:read') && (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink/8 px-5 py-3.5">
            <h2 className="font-display text-[17px] font-bold">Bills</h2>
            {billing && billing.outstandingPaise > 0 && (
              <p className="text-[13px] font-semibold text-amber-text">
                {formatPaise(billing.outstandingPaise)} outstanding
              </p>
            )}
          </div>

          {billing === null ? (
            <p className="field-hint px-5 py-4">Loading…</p>
          ) : billing.invoices.length === 0 ? (
            <p className="field-hint px-5 py-4">Nothing has been billed to this patient.</p>
          ) : (
            /*
              A TABLE, WITH WHAT THE MONEY WAS FOR.

              A number, a date and an amount could not answer the question this
              tab exists for — what did we charge them for, and who saw them —
              so the row now carries the charge descriptions as charged, the
              doctor, and how it was settled.

              Same columns and treatment as the day board and the finance desk,
              because all three are read the same way: down a column, comparing.
            */
            <>
              {/*
                PHONE FIRST, THEN THE TABLE.

                Six columns of billing history is a sideways scroll on a phone,
                and this tab is most often opened to answer one question —
                "what did we charge them for, and did they pay?" A card answers
                it without moving.

                The table's markup is unchanged and hidden, so a desk renders
                what it rendered before. Both halves read the same
                `billing.invoices`.
              */}
              <ul className="divide-y divide-ink/6 md:hidden">
                {billing.invoices.map((inv) => (
                  <li key={inv.id} className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="block font-mono text-[12.5px] font-semibold">
                          {inv.number}
                        </span>
                        <span className="mt-0.5 block text-[11.5px] text-ink-40">
                          {new Date(inv.createdAt).toLocaleDateString('en-IN', {
                            dateStyle: 'medium',
                          })}
                          {' · '}
                          {inv.doctor ?? 'Walk-in test'}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-[15px] font-bold tabular-nums">
                        {formatPaise(inv.totalPaise)}
                      </span>
                    </div>

                    <p className="mt-1.5 text-[12.5px] text-ink-60">
                      {inv.items.length === 0 ? (
                        <span className="text-ink-20">—</span>
                      ) : (
                        <>
                          {inv.items.join(', ')}
                          {inv.itemCount > inv.items.length &&
                            ` and ${inv.itemCount - inv.items.length} more`}
                        </>
                      )}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`badge ${inv.balancePaise > 0 ? 'badge-amber' : 'badge-green'}`}
                      >
                        {inv.balancePaise > 0
                          ? `${formatPaise(inv.balancePaise)} due`
                          : inv.status.toLowerCase().replace('_', ' ')}
                      </span>
                      {inv.paymentModes.length > 0 && (
                        <span className="text-[11.5px] text-ink-40">
                          {inv.paymentModes.map(payMethodLabel).join(', ')}
                          {inv.refundedPaise > 0 && ` · ${formatPaise(inv.refundedPaise)} refunded`}
                        </span>
                      )}

                      {inv.lastPaymentId && can('payment:collect') && (
                        <PrintReceiptButton
                          paymentId={inv.lastPaymentId}
                          className="btn-secondary ml-auto !px-3 !py-1.5 !text-[12.5px]"
                          label="Receipt"
                          iconSize={13}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-[13.5px]">
                  <thead>
                    <tr className="border-b border-ink/8 bg-bg-soft text-left">
                      <Th className="w-[150px]">Bill</Th>
                      <Th>What for</Th>
                      <Th className="w-[170px]">Doctor</Th>
                      <Th className="w-[110px] text-right">Amount</Th>
                      <Th className="w-[150px]">Settled</Th>
                      <Th className="w-[130px]">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>

                  <tbody>
                    {billing.invoices.map((inv) => (
                      <tr
                        key={inv.id}
                        className="border-b border-ink/6 transition-colors last:border-0 hover:bg-clinical-tint/60"
                      >
                        <td className="whitespace-nowrap px-4 py-3">
                          <span className="font-mono text-[12.5px] font-semibold">
                            {inv.number}
                          </span>
                          <span className="block text-[11.5px] text-ink-40">
                            {new Date(inv.createdAt).toLocaleDateString('en-IN', {
                              dateStyle: 'medium',
                            })}
                          </span>
                        </td>

                        <td className="px-4 py-3 text-ink-60">
                          {inv.items.length === 0 ? (
                            <span className="text-ink-20">—</span>
                          ) : (
                            <>
                              {inv.items.join(', ')}
                              {/* Four descriptions come back at most. The count
                                says how many are hidden rather than letting a
                                truncated list pass as the whole bill. */}
                              {inv.itemCount > inv.items.length &&
                                ` and ${inv.itemCount - inv.items.length} more`}
                            </>
                          )}
                        </td>

                        {/* Null for a walk-in test, which belongs to no doctor. */}
                        <td className="px-4 py-3 text-ink-60">
                          {inv.doctor ?? <span className="text-ink-20">Walk-in test</span>}
                        </td>

                        <td className="whitespace-nowrap px-4 py-3 text-right font-mono tabular-nums">
                          {formatPaise(inv.totalPaise)}
                        </td>

                        <td className="px-4 py-3">
                          <span
                            className={`badge ${inv.balancePaise > 0 ? 'badge-amber' : 'badge-green'}`}
                          >
                            {inv.balancePaise > 0
                              ? `${formatPaise(inv.balancePaise)} due`
                              : inv.status.toLowerCase().replace('_', ' ')}
                          </span>
                          {/* How it was actually paid, which is what somebody
                            asking about a bill from March wants to know. */}
                          {inv.paymentModes.length > 0 && (
                            <span className="mt-0.5 block text-[11.5px] text-ink-40">
                              {inv.paymentModes.map(payMethodLabel).join(', ')}
                              {inv.refundedPaise > 0 &&
                                ` · ${formatPaise(inv.refundedPaise)} refunded`}
                            </span>
                          )}
                        </td>

                        <td className="px-4 py-3 text-right">
                          {/*
                          FR-RCP-01 from the record rather than the desk. A
                          patient asking for a copy months later is the
                          commonest reprint there is, and until now the only
                          screen that could produce one was the payment dialog
                          on a bill somebody had to go and find. Nothing to
                          print when no money was ever taken.

                          BEHIND `payment:collect`, NOT `invoice:read`, which is
                          what gates the tab around it. Printing is not reading:
                          it writes a row to the print log, and that log is what
                          decides whether the NEXT copy comes out stamped
                          DUPLICATE. The Owner role holds `invoice:read` for
                          oversight and collects no money — an owner glancing
                          through a patient's bills could otherwise cause the
                          patient's own copy to print as a duplicate, which is a
                          control for catching missing cash quietly firing on
                          somebody who was only looking.
                        */}
                          {inv.lastPaymentId && can('payment:collect') && (
                            <PrintReceiptButton
                              paymentId={inv.lastPaymentId}
                              className="btn-ghost !px-2.5 !py-1 !text-[12px]"
                              label="Receipt"
                              iconSize={13}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'clinical' && (
        <div className="grid gap-5 lg:grid-cols-2">
          {mayReadNotes && (
            <section className="card p-5">
              <h2 className="font-display text-[17px] font-bold">Consultations</h2>

              {encounters === null ? (
                <p className="field-hint mt-2">Loading…</p>
              ) : encounters.length === 0 ? (
                <p className="field-hint mt-2">No consultations recorded.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {encounters.map((e) => (
                    <li key={e.id}>
                      <Link
                        href={`/consultations/${e.id}`}
                        className="block rounded-panel border border-ink/10 bg-white px-3 py-2.5 transition-colors hover:border-clinical/40"
                      >
                        <span className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-[13.5px] font-semibold">
                            {e.chiefComplaint || 'No complaint recorded'}
                          </span>
                          <span className="text-[11.5px] text-ink-40">
                            {new Date(e.startedAt).toLocaleDateString('en-IN', {
                              dateStyle: 'medium',
                            })}
                          </span>
                        </span>

                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          {e.status === 'SIGNED' ? (
                            <span className="badge badge-green">Signed</span>
                          ) : (
                            <span className="badge badge-amber">Draft</span>
                          )}
                          {e.diagnoses.slice(0, 3).map((d, i) => (
                            <span key={`${d.code}-${i}`} className="badge badge-neutral">
                              {d.display}
                            </span>
                          ))}
                          {e.prescriptionCount > 0 && (
                            <span className="text-[11.5px] text-ink-40">
                              {e.prescriptionCount} drug{e.prescriptionCount === 1 ? '' : 's'}
                            </span>
                          )}
                        </span>

                        <span className="mt-0.5 block text-[11.5px] text-ink-40">
                          {e.practitioner.fullName}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="card p-5">
            <h2 className="font-display text-[17px] font-bold">Tests</h2>

            {!can('diagnostic:read') ? (
              <p className="field-hint mt-2">You do not have access to test results.</p>
            ) : tests === null ? (
              <p className="field-hint mt-2">Loading…</p>
            ) : tests.length === 0 ? (
              <p className="field-hint mt-2">No tests have been requested.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {tests.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-panel border border-ink/10 bg-white px-3 py-2.5"
                  >
                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[13.5px] font-semibold">{t.description}</span>
                      <span className="text-[11.5px] text-ink-40">
                        {new Date(t.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                      </span>
                    </span>

                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="badge badge-neutral">{t.department.name}</span>
                      <span
                        className={`badge ${t.status === 'COMPLETED' ? 'badge-green' : t.status === 'PENDING' ? 'badge-amber' : 'badge-coral'}`}
                      >
                        {t.status.toLowerCase()}
                      </span>
                      {/* Who decided the test was needed. A walk-in and a test
                          this clinic's own doctor ordered read very differently
                          to whoever picks the record up next. */}
                      {t.referralSource === 'SELF' && (
                        <span className="badge badge-neutral">walk-in</span>
                      )}
                      {t.referrerName && (
                        <span className="text-[11.5px] text-ink-40">ref. {t.referrerName}</span>
                      )}
                    </span>

                    {/* What the test SHOWED, in the technician's words. First,
                        because it is the answer the doctor came for — the film
                        is the evidence behind it. */}
                    {t.resultNote && (
                      <span className="mt-1.5 block text-[12.5px] text-ink-60">{t.resultNote}</span>
                    )}

                    {/*
                      THE FILMS, OPENABLE.

                      This used to read "2 files" in grey text, which told a
                      doctor that an X-ray existed and gave them no way to look
                      at it — so the one screen built to hold a patient's whole
                      record sent them to the worklist to see the picture.
                    */}
                    {t.documents.length > 0 && (
                      <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        {t.documents.map((d) => (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => void openDocument(d.id)}
                            className="text-[12.5px] font-semibold text-clinical-text underline underline-offset-2"
                          >
                            {d.fileName}
                          </button>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <div className={tab === 'details' ? 'grid gap-5 lg:grid-cols-[1fr_1.25fr]' : 'hidden'}>
        <div className="space-y-5">
          <section className="card p-5">
            <h2 className="font-display text-[17px] font-bold">Details</h2>
            <dl className="mt-3 space-y-2.5">
              <Field label="Mobile" value={patient.mobile} icon={<IconPhone size={13} />} />
              <Field label="Email" value={patient.email} />
              <Field label="Address" value={address || null} />
              <Field
                label="Emergency contact"
                value={
                  patient.emergencyContactName
                    ? `${patient.emergencyContactName}${
                        patient.emergencyContactMobile ? ` · ${patient.emergencyContactMobile}` : ''
                      }`
                    : null
                }
              />
              <Field
                label="ABHA"
                value={patient.abhaNumber ?? patient.abhaAddress}
                icon={<IconIdCard size={13} />}
                /* Empty for everyone until ABDM linking lands in Phase 4. Shown
                   anyway so the gap is visible rather than mysterious. */
                emptyHint="Not linked"
              />
              <Field
                label="Registered"
                value={new Date(patient.createdAt).toLocaleDateString('en-IN', {
                  dateStyle: 'medium',
                })}
              />
            </dl>
          </section>

          <section className="card p-5">
            <h2 className="font-display text-[17px] font-bold">Consent</h2>

            {patient.consents.length === 0 ? (
              <p className="field-hint mt-2">Nothing recorded.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {patient.consents.map((c) => (
                  <li
                    key={c.purpose}
                    className="flex items-center justify-between gap-3 rounded-panel border border-ink/10 bg-white px-3 py-2"
                  >
                    <span className="text-[13px]">
                      {CONSENT_LABELS[c.purpose] ?? c.purpose}
                      <span className="block font-mono text-[10.5px] text-ink-40">
                        notice {c.noticeVersion} ·{' '}
                        {new Date(c.grantedAt).toLocaleDateString('en-IN')}
                      </span>
                    </span>
                    <span className={`badge ${c.granted ? 'badge-green' : 'badge-neutral'}`}>
                      {c.granted ? 'Given' : 'Declined'}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* The current position per purpose. Withdrawals are new records
                rather than edits, so the history behind this stays intact. */}
            <p className="field-hint mt-2">
              Current position per purpose, under the DPDP Act. Earlier decisions are retained.
            </p>
          </section>
        </div>

        <div className="space-y-5">
          <section className="card p-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="mono-label">Visits</p>
              {/* Say what is not shown. A capped list that looks complete is
                  worse than one that admits it is capped. */}
              {patient.stats.totalVisits > patient.appointments.length && (
                <p className="text-[11.5px] text-ink-40">
                  showing {patient.appointments.length} of {patient.stats.totalVisits}
                </p>
              )}
            </div>

            {patient.appointments.length === 0 ? (
              <p className="field-hint mt-2">No appointments yet.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {patient.appointments.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-panel border border-ink/10 bg-white px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="text-[13px] font-semibold">
                        {new Date(a.startAt).toLocaleString('en-IN', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                      <span className="block text-[12px] text-ink-60">
                        {a.practitioner.fullName}
                        {a.reasonForVisit ? ` · ${a.reasonForVisit}` : ''}
                        {a.source === 'WALK_IN' ? ' · walk-in' : ''}
                      </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-2">
                      <span className={`badge ${STATUS_TONE[a.status] ?? 'badge-neutral'}`}>
                        {a.status.replace('_', ' ').toLowerCase()}
                      </span>
                      {a.encounterId && mayReadNotes && (
                        <Link
                          href={`/consultations/${a.encounterId}`}
                          className="btn-ghost !px-2 !py-1 text-[11.5px]"
                        >
                          <IconStethoscope size={12} />
                          Note
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* FR-P36-22. Behind `audit:read`, and loaded on demand rather than with
          the page: this table holds patient data, so it is not something every
          screen load should pull down. */}
      {can('audit:read') && (
        <section className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-[17px] font-bold">Corrections</h2>
            {corrections === null && (
              <button
                type="button"
                className="btn-secondary !py-1.5"
                onClick={() =>
                  void (async () => {
                    try {
                      setCorrections((await api.patientCorrections(patient.id)).corrections);
                    } catch (err) {
                      setError(
                        err instanceof ApiRequestError
                          ? err.error.message
                          : 'Could not load corrections.',
                      );
                    }
                  })()
                }
              >
                Show what changed
              </button>
            )}
          </div>

          {corrections !== null &&
            (corrections.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-40">
                This record has not been corrected since registration.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {corrections.map((c) => (
                  <li key={c.id} className="rounded-panel border border-ink/10 px-3.5 py-2.5">
                    <p className="text-[13.5px]">
                      <span className="mono-label mr-2">{c.field}</span>
                      <span className="text-ink-40 line-through">{c.oldValue ?? 'empty'}</span>
                      <span className="mx-2 text-ink-20">→</span>
                      <span className="font-semibold">{c.newValue ?? 'empty'}</span>
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-40">
                      {c.correctedBy.fullName} ·{' '}
                      {new Date(c.createdAt).toLocaleString('en-IN', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            ))}
        </section>
      )}

      {correcting && (
        <PatientCorrectionDialog
          patient={patient}
          onClose={() => setCorrecting(false)}
          onSaved={() => {
            void load();
            // Force a re-fetch if the history is already open, so a correction
            // made now does not sit behind a stale list.
            setCorrections(null);
          }}
        />
      )}
    </div>
  );
}

/** One figure on the band's strip. The gap between them is the background. */
/** The same column header as the day board and the finance desk. */
function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`mono-label px-4 py-2.5 ${className}`}>
      {children}
    </th>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string | undefined;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="mono-label">{label}</dt>
      <dd className={`mt-1 font-display text-[21px] font-bold tabular-nums ${tone ?? ''}`}>
        {value}
      </dd>
    </div>
  );
}

function Field({
  label,
  value,
  icon,
  emptyHint = '—',
}: {
  label: string;
  value: string | null;
  icon?: React.ReactNode;
  emptyHint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="mono-label shrink-0 !text-[9.5px]">{label}</dt>
      <dd
        className={`min-w-0 text-right text-[13px] ${value ? '' : 'text-ink-20'} flex items-center gap-1.5`}
      >
        {value && icon}
        <span className="break-words">{value ?? emptyHint}</span>
      </dd>
    </div>
  );
}
