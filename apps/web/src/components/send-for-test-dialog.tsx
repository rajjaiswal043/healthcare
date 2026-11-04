'use client';

import { useEffect, useState } from 'react';
import {
  api,
  ApiRequestError,
  type DayBoardRow,
  type DiagnosticOrder,
  type DiagnosticTest,
} from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/format';
import { IconAlert, IconCheck, IconSearch } from '@/components/icons';
import { PrintTestSlipButton } from '@/components/test-slip-button';

/**
 * Sending a patient for a test, from the day board.
 *
 * The doctor finishes with somebody and sends them for an X-ray without opening
 * the consultation again. Two things happen together, and they have to:
 *
 *   the ORDER is created, which raises the charge in the same transaction —
 *   see `diagnostics.service`: "an order with no charge walks straight through
 *   the pay-first gate"
 *
 *   the patient is SENT OUT of the room, so they leave the waiting list and
 *   appear under "At a department" rather than vanishing off the board
 *
 * **Only priced catalogue tests are offered here.** A free-text order raises no
 * charge at all — the clinic has no price for it — and on a screen whose whole
 * point is that the fee is collected first, an option that silently bills
 * nothing is the wrong thing to offer. Free text stays inside the consultation,
 * where choosing it is deliberate.
 *
 * **The patient is not sent out unless they were with the doctor.** Ordering a
 * test for somebody still in the waiting list should not pull them out of it —
 * they have not been seen yet.
 *
 * **The description and the amount are both editable, and both start filled.**
 * The catalogue says "X-ray, knee"; the order has to say which knee and which
 * views, and that is the part a price list cannot carry. The amount defaults to
 * the list price and is changed in the minority of cases — a repeat film, a
 * concession — where arguing it out at the desk afterwards means the patient
 * has already been quoted the wrong number.
 *
 * **TWO PANES, NOT ONE COLUMN.** The list of tests is as long as the clinic's
 * catalogue, and stacking the description and the amount underneath it put the
 * two fields that actually have to be filled in below forty rows of scroll —
 * out of sight at the moment of picking, and reached only by scrolling past
 * what had just been chosen. Side by side, choosing a test fills a panel that
 * was already on screen, and the sentence saying what will be charged never
 * moves. Below `md` there is no room for two, so the list keeps its own scroll
 * at a capped height and the panel sits directly under it — still within a
 * thumb's reach rather than at the end of the catalogue.
 *
 * **It does not close on success.** The slip is the reason: the patient is
 * being sent somewhere and has to carry the request with them, and a dialog
 * that vanishes the moment the order is raised leaves the one person who knows
 * what was ordered with nothing to hand over. So the order comes back, the
 * dialog says what happened, and printing is one press away. The board is not
 * told until the dialog is dismissed, which is the only thing deferring it
 * costs.
 */
export function SendForTestDialog({
  row,
  onClose,
  onSent,
}: {
  row: DayBoardRow;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [tests, setTests] = useState<DiagnosticTest[] | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<DiagnosticTest | null>(null);
  /** What the order will say. Pre-filled from the test, then usually added to. */
  const [description, setDescription] = useState('');
  /** Rupees as typed. Pre-filled from the list price, rarely changed. */
  const [rupees, setRupees] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The server says this test is already on the visit.
   *
   * Reported from the clinic on 27 Oct 2026: an orthopaedic patient needs an
   * X-ray of the knee AND of the shoulder, both of which are the service
   * called "X-ray". Naming the body part in the description is now enough to
   * tell them apart, so this only appears for a genuine repeat of the very
   * same wording — and then it offers the way through rather than stopping.
   */
  const [repeat, setRepeat] = useState(false);
  /** The raised order, once it exists. What the slip is printed from. */
  const [sent, setSent] = useState<{ order: DiagnosticOrder; message: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setTests((await api.diagnosticCatalogue()).tests);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the tests.');
      }
    })();
  }, []);

  /**
   * Picking a test fills both fields; picking a different one refills them.
   *
   * Not merged into the click handler alone, because the edited values must be
   * discarded when the choice changes — keeping “left knee, AP” after
   * switching to a blood test would send a description belonging to the test
   * that was NOT ordered, and the pre-filled amount would belong to the old
   * price.
   */
  function choose(test: DiagnosticTest) {
    setChosen(test);
    // A different test is a different question: the last refusal does not
    // apply to it, and offering "order it again" here would be nonsense.
    setError(null);
    setRepeat(false);
    setDescription(test.name);
    setRupees((test.pricePaise / 100).toFixed(2));
  }

  /** Null while it is being typed into and makes no sense yet. */
  const pricePaise = parseRupeesToPaise(rupees);
  const changedPrice = chosen !== null && pricePaise !== null && pricePaise !== chosen.pricePaise;

  const needle = query.trim().toLowerCase();
  const shown = (tests ?? []).filter(
    (t) =>
      !needle ||
      t.name.toLowerCase().includes(needle) ||
      t.code.toLowerCase().includes(needle) ||
      t.department.name.toLowerCase().includes(needle),
  );

  async function send(confirmedRepeat = false) {
    if (!chosen || !row.appointmentId) return;

    const said = description.trim();
    if (said.length < 2) {
      setError('Say what is being ordered.');
      return;
    }
    if (pricePaise === null) {
      setError('That amount is not a number.');
      return;
    }

    setBusy(true);
    setError(null);
    setRepeat(false);

    try {
      const order = await api.raiseDiagnosticOrder({
        appointmentId: row.appointmentId,
        departmentId: chosen.department.id,
        serviceId: chosen.id,
        description: said,
        ...(confirmedRepeat ? { confirmedRepeat: true } : {}),
        /* Sent only when it differs. The absence of the field means "the list
           price", and an order that merely accepted the default should not be
           recorded as one where somebody priced it by hand. */
        ...(changedPrice ? { pricePaise } : {}),
        referralSource: 'INTERNAL',
      });

      // Out of the room only if they were in it. Ordered from the waiting list,
      // the patient keeps their place.
      if (row.bucket === 'WITH_DOCTOR') {
        await api.sendForTests(row.appointmentId, said);
      }

      setSent({
        order,
        message:
          `${row.patient.name} sent to ${chosen.department.name} for ${said}. ` +
          `${formatPaise(pricePaise)} has been added to their bill. The department ` +
          `cannot start until it is paid.`,
      });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not send them.');
      /* Offer the way through, rather than leaving them at a wall. */
      setRepeat(
        err instanceof ApiRequestError && err.error.details?.code === 'TEST_ALREADY_ORDERED',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Send ${row.patient.name} for a test`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden max-sm:rounded-b-none">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink/8 px-6 py-4">
          <div className="min-w-0 flex-1">
            <p className="mono-label">Send for a test</p>
            <h2 className="mt-1 font-display text-[20px] font-bold">{row.patient.name}</h2>
            <p className="field-hint">
              <span className="font-mono">{row.patient.uhid}</span>
              {row.withWhom ? ` · ${row.withWhom}` : ''}
            </p>
          </div>

          {/* Where they are being sent, as soon as that is known. On the header
              because it is the one fact the patient will be told out loud, and
              it should not be something you have to look for. */}
          {chosen && !sent && (
            <p className="shrink-0 text-right">
              <span className="mono-label block">Department</span>
              <span className="font-display text-[15px] font-bold">{chosen.department.name}</span>
            </p>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4 md:overflow-hidden">
          {/* Done. The list and the fields are gone rather than disabled: there
              is nothing left to decide, and leaving them on screen invites a
              second order for the same test. */}
          {sent ? (
            <div className="space-y-3">
              <p className="flex items-start gap-2 rounded-panel border border-clinical/30 bg-clinical-tint px-3 py-2.5 text-[13px]">
                <span className="mt-0.5 shrink-0 text-clinical">
                  <IconCheck size={14} />
                </span>
                <span>{sent.message}</span>
              </p>
              <p className="field-hint">
                The slip carries the test, what exactly was asked for and the amount. Hand it to the
                patient. They take it to the desk and then to {sent.order.department.name}.
              </p>
            </div>
          ) : null}

          {!sent && error && (
            <div
              role="alert"
              className="mb-3 flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3 py-2 text-[12.5px] text-coral-text"
            >
              <span className="mt-0.5 shrink-0">
                <IconAlert size={13} />
              </span>
              <span>
                {error}
                {/*
                  The way through, not just the wall. Offered only when the
                  server said this exact test is already on the visit — which,
                  now that the description is part of the comparison, means the
                  same body part worded the same way. A genuine repeat does
                  happen (bloods after a meal, an ECG after fresh chest pain)
                  and it takes one deliberate press, so an ordinary double-click
                  still cannot bill the patient twice.
                */}
                {repeat && (
                  <button
                    type="button"
                    className="btn-ghost mt-1.5 block !px-0 !py-0 !text-[12.5px] !text-coral-text underline underline-offset-2"
                    disabled={busy}
                    onClick={() => void send(true)}
                  >
                    Order it again anyway
                  </button>
                )}
              </span>
            </div>
          )}

          {!sent && (
            <div className="grid min-h-0 flex-1 gap-5 md:grid-cols-[minmax(0,1fr)_300px]">
              {/* THE CATALOGUE. Scrolls inside itself rather than scrolling the
                  dialog, so the panel beside it stays put. */}
              <div className="flex min-h-0 flex-col gap-2.5">
                <label className="relative block shrink-0">
                  <span className="sr-only">Find a test</span>
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-20">
                    <IconSearch size={14} />
                  </span>
                  <input
                    autoFocus
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="X-ray, blood, department…"
                    className="field-input !py-2 !pl-9"
                  />
                </label>

                {tests === null ? (
                  <p className="field-hint">Loading…</p>
                ) : shown.length === 0 ? (
                  <p className="field-hint">
                    {tests.length === 0
                      ? 'No tests are priced yet. Add them under Settings → Departments.'
                      : `Nothing matches “${query.trim()}”.`}
                  </p>
                ) : (
                  <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 max-md:max-h-[34vh]">
                    {shown.map((t) => {
                      const on = chosen?.id === t.id;
                      return (
                        <li key={t.id}>
                          <button
                            type="button"
                            aria-pressed={on}
                            onClick={() => choose(t)}
                            className={[
                              'flex w-full flex-wrap items-center justify-between gap-2 rounded-panel border-[1.5px] px-3.5 py-2.5 text-left transition-colors',
                              on
                                ? 'border-clinical bg-clinical-tint'
                                : 'border-ink/10 bg-white hover:border-ink/25',
                            ].join(' ')}
                          >
                            <span className="min-w-0">
                              <span className="block text-[13.5px] font-semibold">{t.name}</span>
                              <span className="block text-[11.5px] text-ink-40">
                                {t.department.name} · <span className="font-mono">{t.code}</span>
                              </span>
                            </span>
                            <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums">
                              {formatPaise(t.pricePaise)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* WHAT IS BEING ORDERED. Beside the list rather than under it:
                  these are the two fields that have to be right, and they were
                  previously reached by scrolling past the catalogue. */}
              <div className="flex min-h-0 flex-col gap-3 rounded-panel bg-bg-soft p-3.5 md:overflow-y-auto">
                {!chosen ? (
                  /* A placeholder rather than nothing, so the panel does not
                     appear out of the floor and shift the list when a test is
                     picked. */
                  <p className="text-[12.5px] text-ink-40">
                    Pick a test on the left. What exactly is being asked for, and what it costs, are
                    set here.
                  </p>
                ) : (
                  <>
                    <label className="block">
                      <span className="field-label">What exactly</span>
                      <textarea
                        rows={3}
                        className="field-input mt-1 resize-none !py-2"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        maxLength={300}
                        placeholder="X-ray, left knee, AP and lateral"
                      />
                      <span className="field-hint">
                        Printed on the slip and shown to the department. Add the side and the views.
                      </span>
                    </label>

                    <label className="block">
                      <span className="field-label">Amount ₹</span>
                      <input
                        className="field-input mt-1 max-w-[140px] font-mono !py-2"
                        value={rupees}
                        onChange={(e) => setRupees(e.target.value)}
                        inputMode="decimal"
                      />
                      <span className="field-hint">
                        {changedPrice
                          ? `Normally ${formatPaise(chosen.pricePaise)}. This visit is charged what is typed here.`
                          : 'The clinic’s price. Change it only for this patient, this visit.'}
                      </span>
                    </label>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/8 bg-bg-soft px-6 py-4">
          {/* Said before the press. The charge is raised with the order, and the
              department is blocked until it clears — so this button is the
              moment money starts being owed. */}
          <p className="text-[12px] text-ink-40">
            {sent
              ? 'Raised. Print the slip before you close this.'
              : !chosen
                ? 'Pick a test.'
                : pricePaise === null
                  ? 'That amount is not a number.'
                  : `${formatPaise(pricePaise)} will be added to their bill.`}
          </p>
          <div className="flex gap-2">
            {sent ? (
              <>
                {/* Done first, printing primary: the slip is the thing still
                    worth doing, and it can be printed again from the patient's
                    record if this is closed too soon. */}
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    onSent(sent.message);
                    onClose();
                  }}
                >
                  Done
                </button>
                <PrintTestSlipButton order={sent.order} className="btn-primary" />
              </>
            ) : (
              <>
                <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!chosen || busy || pricePaise === null || description.trim().length < 2}
                  onClick={() => void send()}
                >
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
