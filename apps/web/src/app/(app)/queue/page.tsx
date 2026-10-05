'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiRequestError,
  type Appointment,
  type Invoice,
  type Practitioner,
  type QueueView,
} from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { AppointmentDialog } from '@/components/appointment-dialog';
import { PaymentDialog } from '@/components/payment-dialog';
import { QueuePriorityDialog, priorityLabel } from '@/components/queue-priority-dialog';
import { formatAge, genderInitial } from '@/lib/format';
import {
  IconCallNext,
  IconCheckCircle,
  IconClock,
  IconRefresh,
  IconStethoscope,
  IconUserPlus,
  IconUsers,
} from '@/components/icons';

/** How often the board refreshes itself. */
const POLL_MS = 15000;

export default function QueuePage() {
  const { can, session } = useAuth();
  const router = useRouter();

  const [doctors, setDoctors] = useState<Practitioner[]>([]);
  const [doctorId, setDoctorId] = useState<string>('');
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [dialog, setDialog] = useState<{
    mode: 'reschedule' | 'cancel';
    appointment: Appointment;
  } | null>(null);
  const [payingFor, setPayingFor] = useState<Invoice | null>(null);
  const [queueDialog, setQueueDialog] = useState<{
    mode: 'return' | 'prioritise';
    appointment: Appointment;
  } | null>(null);

  /**
   * A doctor is confined to their own queue.
   *
   * Not a UI preference — `GET /queue` refuses another doctor's list outright.
   * This is what stops the console offering a choice the API would then reject,
   * which is a worse experience than not offering it. An administrator who also
   * consults keeps the full list; see `assertMayReadQueue` on the API side.
   *
   * The `consultation:write` half is the fix for an unlinked doctor. This used
   * to confine on `practitionerId !== null` alone, so a doctor whose account
   * had never been joined to a practitioner row fell through to the ELSE — the
   * full list of every consultant in the clinic, each of whose queues the API
   * then happily served. Confining on "is meant to be a doctor" instead means
   * the filter below matches nothing for them and they are offered an empty
   * list, which is the honest answer: they have no queue yet.
   */
  const ownPractitionerId = session?.practitionerId ?? null;
  const confinedToSelf =
    !can('user:manage') && (ownPractitionerId !== null || can('consultation:write'));

  useEffect(() => {
    void (async () => {
      try {
        const { practitioners } = await api.practitioners();
        const visible = confinedToSelf
          ? practitioners.filter((p) => p.id === ownPractitionerId)
          : practitioners;

        setDoctors(visible);
        if (visible.length > 0) setDoctorId(visible[0]!.id);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.error.message : 'Could not load doctors.');
      }
    })();
    // Depends on who is looking: AppShell renders nothing until the session
    // exists, so these are settled by the time this mounts — but listing them
    // keeps that a fact rather than an assumption.
  }, [confinedToSelf, ownPractitionerId]);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    try {
      setQueue(await api.queue(id));
      setRefreshedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the queue.');
    }
  }, []);

  useEffect(() => {
    void load(doctorId);
  }, [doctorId, load]);

  // The board is left open on a screen all day, so it refreshes itself. A
  // receptionist should never have to remember to reload to see who arrived.
  useEffect(() => {
    if (!doctorId) return;
    const t = setInterval(() => void load(doctorId), POLL_MS);
    return () => clearInterval(t);
  }, [doctorId, load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load(doctorId);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  }

  const mayAct = can('appointment:write');
  const canCancel = can('appointment:cancel');
  const mayConsult = can('consultation:write');
  const mayBill = can('invoice:read');
  const mayPrioritise = can('queue:prioritise');

  /**
   * Open the bill for a visit.
   *
   * Fetched on demand rather than loaded with the queue: the board polls every
   * fifteen seconds, and pulling an invoice for every row would be twenty extra
   * queries a minute to render a button. The 404 case is a clinic that has
   * priced nothing — see BillingService.ensureInvoiceForAppointment.
   */
  async function openBill(appointmentId: string) {
    setBusyId(appointmentId);
    setError(null);
    try {
      setPayingFor(await api.invoiceForAppointment(appointmentId));
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 404
          ? 'No bill was raised for this visit — this clinic has not set up its charges yet.'
          : err instanceof ApiRequestError
            ? err.error.message
            : 'Could not open the bill.',
      );
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Open the consultation for an appointment and go to it.
   *
   * The API creates the note and calls the patient in as one act, because that
   * is what it means: the doctor has the patient in the room. Pressing "call"
   * here and "open" on another screen is bookkeeping the software should do.
   */
  async function startConsultation(appointmentId: string) {
    setBusyId(appointmentId);
    setError(null);
    try {
      const encounter = await api.openEncounter(appointmentId);
      router.push(`/consultations/${encounter.id}`);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not open the consultation.',
      );
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">OPD</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">Today&rsquo;s queue</h1>
          <p className="mt-1 text-[14px] text-ink-60">
            Ordered by arrival — not by token, and not by appointment time.
          </p>
        </div>

        <div className="flex items-end gap-2">
          {/* A doctor gets their name, not a menu of one. */}
          {confinedToSelf ? (
            <div>
              <p className="field-label">Doctor</p>
              {/* Confined, with nothing to be confined TO: a doctor whose
                  account has no practitioner record. They used to be shown
                  every consultant in the clinic here; an empty queue with no
                  explanation would be the opposite mistake, so say which of the
                  two it is and who can fix it. */}
              {doctors.length === 0 ? (
                <p className="max-w-[320px] rounded-panel border border-amber/30 bg-amber/8 px-3.5 py-2.5 text-[13.5px] text-amber-text">
                  Your account is not linked to a doctor record yet, so you have no queue. An
                  administrator can link it under Doctors and hours.
                </p>
              ) : (
                <p className="rounded-panel border border-ink/10 bg-bg-soft px-3.5 py-2.5 text-[15px] font-semibold text-ink">
                  {doctors[0]?.fullName}
                  {doctors[0]?.specialty ? (
                    <span className="font-normal text-ink-40"> · {doctors[0].specialty}</span>
                  ) : null}
                </p>
              )}
            </div>
          ) : (
            <div>
              <label htmlFor="doctor" className="field-label">
                Doctor
              </label>
              <select
                id="doctor"
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                className="field-input min-w-[220px]"
              >
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName}
                    {d.specialty ? ` · ${d.specialty}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            className="btn-secondary !px-3"
            onClick={() => void load(doctorId)}
            aria-label="Refresh now"
            title="Refresh now"
          >
            <IconRefresh size={16} />
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-card border border-coral/30 bg-coral/8 p-3 text-[13.5px] text-coral-text"
        >
          {error}
        </div>
      )}

      {queue && (
        <>
          <div className="grid gap-3 sm:grid-cols-5">
            <Stat label="In the queue" value={String(queue.stats.inQueue)} />
            <Stat label="Waiting" value={String(queue.stats.waiting)} tone="amber" />
            <Stat label="Away for tests" value={String(queue.stats.awayForTests)} />
            <Stat label="Seen today" value={String(queue.stats.completed)} tone="green" />
            <Stat
              label="Average wait"
              /* Null until someone has actually been seen. Showing "0 min" from
                 an empty set is a number the front desk would repeat to
                 patients, and it would be a lie. */
              value={
                queue.stats.averageWaitMinutes === null
                  ? '—'
                  : `${queue.stats.averageWaitMinutes} min`
              }
            />
          </div>

          {/* Now serving — the single most-glanced-at thing on the screen. */}
          <section
            className={
              queue.nowServing
                ? 'rounded-card border border-clinical/25 bg-clinical-tint p-6'
                : 'card-flat p-6'
            }
          >
            <p className="mono-label !text-clinical-text">Now serving</p>
            {queue.nowServing ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-5">
                  <span className="grid h-16 w-16 place-items-center rounded-panel bg-clinical font-mono text-[26px] font-bold text-white shadow">
                    {queue.nowServing.tokenNumber}
                  </span>
                  <div>
                    <p className="font-display text-[22px] font-bold">
                      {queue.nowServing.patient.name}
                    </p>
                    <p className="text-[13.5px] text-ink-60">
                      <span className="font-mono text-[12px]">{queue.nowServing.patient.uhid}</span>
                      {' · '}
                      {formatAge(queue.nowServing.patient)}{' '}
                      {genderInitial(queue.nowServing.patient.gender)}
                      {queue.nowServing.reasonForVisit
                        ? ` · ${queue.nowServing.reasonForVisit}`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {mayConsult && (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busyId === queue.nowServing.id}
                      onClick={() => void startConsultation(queue.nowServing!.id)}
                    >
                      <IconStethoscope size={16} />
                      Open consultation
                    </button>
                  )}
                  {mayAct && (
                    <button
                      type="button"
                      className={mayConsult ? 'btn-secondary' : 'btn-primary'}
                      disabled={busyId === queue.nowServing.id}
                      title="Close the visit without recording a consultation"
                      onClick={() =>
                        void act(queue.nowServing!.id, () =>
                          api.completeVisit(queue.nowServing!.id),
                        )
                      }
                    >
                      <IconCheckCircle size={16} />
                      Finish visit
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-2 text-[14px] text-ink-60">
                The room is free. Call the next token when the doctor is ready.
              </p>
            )}
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              title="Waiting"
              count={queue.waiting.length}
              empty="Nobody is waiting. A quiet moment."
              icon={<IconClock size={16} />}
            >
              {queue.waiting.map((a, i) => (
                <Row key={a.id} appointment={a}>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {mayConsult && (
                      <button
                        type="button"
                        className={
                          i === 0
                            ? 'btn-primary !px-3 !py-1.5 text-[12.5px]'
                            : 'btn-secondary !px-3 !py-1.5 text-[12.5px]'
                        }
                        disabled={busyId === a.id || Boolean(queue.nowServing)}
                        title={
                          queue.nowServing
                            ? 'Finish the current visit first'
                            : 'Call this patient in and start the note'
                        }
                        onClick={() => void startConsultation(a.id)}
                      >
                        <IconStethoscope size={13} />
                        Consult
                      </button>
                    )}
                    {mayAct && (
                      <button
                        type="button"
                        className="btn-secondary !px-3 !py-1.5 text-[12.5px]"
                        disabled={busyId === a.id || Boolean(queue.nowServing)}
                        title={
                          queue.nowServing
                            ? 'Finish the current visit first'
                            : 'Call this patient in without opening a note'
                        }
                        onClick={() => void act(a.id, () => api.callPatient(a.id))}
                      >
                        <IconCallNext size={13} />
                        Call
                      </button>
                    )}
                    {/* Flagging is its own permission because the whole waiting
                        room can see what it does. The undo matters as much as
                        the button: without it a mis-click is repaired by
                        cancelling the visit, which loses the token and the bill. */}
                    {mayPrioritise &&
                      (a.priority ? (
                        <button
                          type="button"
                          className="btn-ghost !px-2 !py-1.5 text-[12.5px]"
                          disabled={busyId === a.id}
                          title={`${priorityLabel(a.priority)} — put them back in their normal position`}
                          onClick={() => void act(a.id, () => api.clearPriority(a.id))}
                        >
                          Move back
                        </button>
                      ) : (
                        i > 0 && (
                          <button
                            type="button"
                            className="btn-ghost !px-2 !py-1.5 text-[12.5px]"
                            disabled={busyId === a.id}
                            title="Move this patient to the front of the queue"
                            onClick={() => setQueueDialog({ mode: 'prioritise', appointment: a })}
                          >
                            See next
                          </button>
                        )
                      ))}
                  </div>
                </Row>
              ))}
            </Panel>

            {/* Only rendered when somebody is actually out. An empty panel here
                every day would train the desk to stop reading this column. */}
            {queue.awayForTests.length > 0 && (
              <Panel
                title="Away for tests"
                count={queue.awayForTests.length}
                empty=""
                icon={<IconClock size={16} />}
              >
                {queue.awayForTests.map((a) => (
                  <Row key={a.id} appointment={a}>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {a.sentOut && (
                        <span className="max-w-[180px] truncate text-[12.5px] text-ink-40">
                          {a.sentOut.reason}
                        </span>
                      )}
                      {mayAct && (
                        <button
                          type="button"
                          className="btn-primary !px-3 !py-1.5 text-[12.5px]"
                          disabled={busyId === a.id}
                          title="They are back with their report"
                          onClick={() => setQueueDialog({ mode: 'return', appointment: a })}
                        >
                          Back at the desk
                        </button>
                      )}
                    </div>
                  </Row>
                ))}
              </Panel>
            )}

            <Panel
              title="Yet to arrive"
              count={queue.yetToArrive.length}
              empty="Everyone booked is here. Nobody left to wait for."
              icon={<IconUsers size={16} />}
            >
              {queue.yetToArrive.map((a) => (
                <Row key={a.id} appointment={a}>
                  {mayAct && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {/* Payment first — that is the clinic's rule, and check-in
                          refuses while anything is outstanding. The bill button
                          sits before Check in so the desk reaches for it in the
                          order the workflow actually happens. */}
                      {mayBill && (
                        <button
                          type="button"
                          className="btn-secondary !px-2.5 !py-1.5 text-[12.5px]"
                          disabled={busyId === a.id}
                          title="Open the bill for this visit"
                          onClick={() => void openBill(a.id)}
                        >
                          Bill
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-primary !px-3 !py-1.5 text-[12.5px]"
                        disabled={busyId === a.id}
                        onClick={() => void act(a.id, () => api.checkIn(a.id))}
                      >
                        Check in
                      </button>
                      <button
                        type="button"
                        className="btn-secondary !px-2.5 !py-1.5 text-[12.5px]"
                        disabled={busyId === a.id}
                        title="Move to another time"
                        onClick={() => setDialog({ mode: 'reschedule', appointment: a })}
                      >
                        Move
                      </button>
                      <button
                        type="button"
                        className="btn-ghost !px-2 !py-1.5 text-[12.5px]"
                        disabled={busyId === a.id}
                        title="Mark as did not attend"
                        onClick={() => void act(a.id, () => api.markNoShow(a.id))}
                      >
                        No-show
                      </button>
                      {canCancel && (
                        <button
                          type="button"
                          className="btn-ghost !px-2 !py-1.5 text-[12.5px] !text-coral-text"
                          disabled={busyId === a.id}
                          onClick={() => setDialog({ mode: 'cancel', appointment: a })}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  )}
                </Row>
              ))}
            </Panel>
          </div>

          {queue.completed.length > 0 && (
            <Panel
              title="Seen today"
              count={queue.completed.length}
              empty=""
              icon={<IconCheckCircle size={16} />}
            >
              {queue.completed.map((a) => (
                <Row key={a.id} appointment={a} muted />
              ))}
            </Panel>
          )}
        </>
      )}

      {queueDialog && (
        <QueuePriorityDialog
          mode={queueDialog.mode}
          appointment={queueDialog.appointment}
          onClose={() => setQueueDialog(null)}
          onDone={() => {
            setQueueDialog(null);
            void load(doctorId);
          }}
        />
      )}

      {dialog && (
        <AppointmentDialog
          mode={dialog.mode}
          appointment={dialog.appointment}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load(doctorId);
          }}
        />
      )}

      {payingFor && (
        <PaymentDialog
          invoice={payingFor}
          onClose={() => {
            setPayingFor(null);
            // The board shows nothing about payment state directly, but a
            // settled bill changes what Check in will do — so refresh.
            void load(doctorId);
          }}
          onSettled={setPayingFor}
        />
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono-label">
          {refreshedAt
            ? `Updated ${refreshedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · refreshes every ${POLL_MS / 1000}s`
            : 'Loading…'}
        </p>
        {can('appointment:write') && (
          <Link href="/appointments/new" className="btn-secondary text-[13px]">
            <IconUserPlus size={15} />
            Book or add a walk-in
          </Link>
        )}
      </footer>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'green' }) {
  const toneClass =
    tone === 'amber' ? 'text-amber-text' : tone === 'green' ? 'text-green-text' : 'text-ink';
  return (
    <div className="card p-4">
      <p className="mono-label">{label}</p>
      <p className={`mt-1 font-display text-[26px] font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}

function Panel({
  title,
  count,
  empty,
  icon,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-2 border-b border-ink/8 bg-bg-soft px-4 py-2.5">
        <span className="text-ink-40">{icon}</span>
        <p className="mono-label">{title}</p>
        <span className="badge-neutral ml-auto">{count}</span>
      </header>
      {count === 0 ? (
        <p className="px-4 py-6 text-center text-[13.5px] text-ink-40">{empty}</p>
      ) : (
        <ul className="divide-y divide-ink/6">{children}</ul>
      )}
    </section>
  );
}

function Row({
  appointment: a,
  muted,
  children,
}: {
  appointment: Appointment;
  muted?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className={`flex items-center gap-3 px-4 py-2.5 ${muted ? 'opacity-60' : ''}`}>
      {/* The token is the patient's identity for the visit and is held from
          booking, so it is shown the same way in every state — a number that
          appears only once someone is admitted is a number nobody can be
          called by at the desk. */}
      <span
        className={[
          'grid h-9 w-9 shrink-0 place-items-center rounded-tiny font-mono text-[13px] font-bold',
          a.tokenNumber === null ? 'bg-ink/5 text-ink-20' : 'bg-clinical-soft text-clinical-text',
        ].join(' ')}
        title={a.tokenNumber === null ? 'No token on this visit' : `Token ${a.tokenNumber}`}
      >
        {a.tokenNumber ?? '–'}
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-[14px] font-semibold text-ink">
          {a.patient.name}
          {a.priority && (
            <span className="badge-amber" title={priorityLabel(a.priority)}>
              seen next
            </span>
          )}
          {/* Said from their own phone (docs/10). Only while they are still
              out: once checked in, the desk can see them. */}
          {a.status === 'BOOKED' && a.arrivalIntent === 'ON_THE_WAY' && (
            <span className="badge-green" title="The patient said so from their WhatsApp link">
              on the way
            </span>
          )}
          {a.status === 'BOOKED' && a.arrivalIntent === 'RUNNING_LATE' && (
            <span className="badge-amber" title="The patient said so from their WhatsApp link">
              running late
            </span>
          )}
          {a.status === 'BOOKED' && !a.arrivalIntent && a.leaveNowSentAt && (
            <span className="badge-neutral" title="The time-to-leave message has gone">
              told to leave
            </span>
          )}
        </p>
        <p className="truncate text-[12.5px] text-ink-40">
          <span className="font-mono">{a.patient.uhid}</span>
          {' · '}
          {formatAge(a.patient)} {genderInitial(a.patient.gender)}
          {' · '}
          {a.localTime}
          {a.source === 'WALK_IN' && ' · walk-in'}
          {a.reasonForVisit ? ` · ${a.reasonForVisit}` : ''}
        </p>
      </div>

      {children}
    </li>
  );
}
