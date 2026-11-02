'use client';

import { useEffect, useState } from 'react';
import { api, ApiRequestError, type DayBoardRow, type DiagnosticTest } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * CORRECT OR WITHDRAW A TEST ALREADY AT A DEPARTMENT.
 *
 * Narveer's requirement, 2 Nov 2026: a film is ordered as "X-ray left knee",
 * the doctor meant "AP and lateral", and there was no way to say so — nothing
 * wrote `description` after creation, so the only route was cancelling the
 * order and raising another.
 *
 * ONE BUTTON ON THE ROW, TWO ENDINGS IN HERE. The board's quiet slot already
 * carries the way out of a test; rather than add a third button and widen the
 * Action column again, that one button now opens this and the withdrawal lives
 * inside it.
 *
 * DELIBERATELY NOT `SendForTestDialog`, which this copies the shape of. That
 * one also stamps the appointment as sent-out and moves the patient to a
 * department; reusing it would mean a dialog that has to undo half of what it
 * does. Same reasoning as keeping the collect-across dialog separate from the
 * payment dialog on 30 Oct.
 *
 * WHICH WITHDRAWAL IS OFFERED FOLLOWS THE MONEY, not the role — `declineOrder`
 * refuses an order with no charge, so offering "patient declined" there would
 * draw a button the server throws out.
 */
export function EditTestDialog({
  row,
  orderId,
  billed,
  onClose,
  onDone,
}: {
  row: DayBoardRow;
  orderId: string;
  /** Whether the test carries a charge. Decides decline versus cancel. */
  billed: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [tests, setTests] = useState<DiagnosticTest[] | null>(null);
  /**
   * THE FIRST TEST NOT YET DONE, not simply the first.
   *
   * `pendingOrderId` on the server is the first PENDING order, and `tests` is
   * built in the same pass over the same orders with COMPLETED ones flagged —
   * so the first not-done entry is the order this dialog is editing. Taking
   * `tests[0]` would pre-fill a patient's finished X-ray into the box while
   * saving against their pending blood test.
   */
  const [description, setDescription] = useState(row.tests.find((t) => !t.done)?.description ?? '');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [rupees, setRupees] = useState('');
  const [busy, setBusy] = useState<'saving' | 'withdrawing' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setTests((await api.diagnosticCatalogue()).tests);
      } catch {
        // The catalogue is only needed to CHANGE the test. Failing to load it
        // must not stop somebody fixing the wording, which is the common case.
        setTests([]);
      }
    })();
  }, []);

  const chosen = tests?.find((t) => t.id === serviceId) ?? null;
  const working = busy !== null;

  async function save() {
    const said = description.trim();
    if (!said) {
      setError('Say what the test is.');
      return;
    }

    setBusy('saving');
    setError(null);
    try {
      /*
       * Only what actually changed is sent. An unchanged price must not be sent
       * back as an explicit figure — the server treats a given price as "this
       * one costs something else", and every ordinary correction would be
       * recorded as a priced decision somebody made.
       */
      const typed = rupees.trim();
      const pricePaise = typed === '' ? undefined : Math.round(Number(typed) * 100);
      if (pricePaise !== undefined && !Number.isFinite(pricePaise)) {
        setError('That amount is not a number.');
        setBusy(null);
        return;
      }

      await api.updateDiagnosticOrder(orderId, {
        description: said,
        ...(serviceId ? { serviceId } : {}),
        ...(pricePaise === undefined ? {} : { pricePaise }),
      });
      onDone(`The test for ${row.patient.name} has been updated.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not save that.');
      setBusy(null);
    }
  }

  async function withdraw() {
    setBusy('withdrawing');
    setError(null);
    try {
      if (billed) {
        await api.declineDiagnosticOrder(orderId);
        onDone(`Recorded: ${row.patient.name} declined the test. The charge has been removed.`);
      } else {
        await api.cancelDiagnosticOrder(orderId);
        onDone(`The test for ${row.patient.name} has been cancelled.`);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not do that.');
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 md:items-center md:p-6">
      <div className="flex max-h-[92vh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-panel bg-card md:rounded-panel">
        <header className="border-b border-ink/8 px-5 py-4">
          <h2 className="font-display text-[17px] font-bold">Edit or cancel the test</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-60">
            {row.patient.name} · <span className="font-mono">{row.patient.uhid}</span>
          </p>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="field-label">What exactly</span>
            <textarea
              rows={3}
              className="field-input mt-1 resize-none !py-2"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              disabled={working}
              placeholder="X-ray, left knee, AP and lateral"
            />
            <span className="field-hint">
              Printed on the slip and shown to the department. Add the side and the views.
            </span>
          </label>

          {/* Changing WHICH test is a bigger act than fixing the wording, so it
              is offered below it rather than above — and left blank by default,
              because the common case is that the test is right. */}
          <label className="block">
            <span className="field-label">A different test (optional)</span>
            <select
              className="field-input mt-1 !py-2"
              value={serviceId ?? ''}
              disabled={working || tests === null}
              onChange={(e) => setServiceId(e.target.value || null)}
            >
              <option value="">Keep the test as it is</option>
              {(tests ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} — {formatPaise(t.pricePaise)}
                </option>
              ))}
            </select>
            <span className="field-hint">
              Moves it to that test’s department, and replaces the charge with its price.
            </span>
          </label>

          {/*
            SAY WHY THERE IS NO AMOUNT, rather than leaving a gap.

            Reported immediately on 2 Nov 2026: "amount changing option is not
            coming". It was correct — that order was free text with no charge on
            it, so there was nothing to change — but an absent field explains
            nothing, and somebody looking for it concludes the screen is broken.
          */}
          {!billed && (
            <p className="rounded-card bg-bg-soft px-3 py-2 text-[12.5px] text-ink-60">
              There is no charge on this test, so there is no amount to change. It was raised as
              free text, or before tests were billable.
            </p>
          )}

          {billed && (
            <label className="block">
              <span className="field-label">Amount ₹ (optional)</span>
              <input
                className="field-input mt-1 max-w-[140px] font-mono !py-2"
                value={rupees}
                onChange={(e) => setRupees(e.target.value)}
                inputMode="decimal"
                disabled={working}
                placeholder={chosen ? String(chosen.pricePaise / 100) : ''}
              />
              <span className="field-hint">
                Leave empty to keep what is on the bill. Changing it replaces the charge.
              </span>
            </label>
          )}

          {error && <p className="text-[12.5px] text-coral">{error}</p>}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-ink/8 px-5 py-4">
          <button
            type="button"
            className="btn-primary"
            disabled={working}
            onClick={() => void save()}
          >
            {busy === 'saving' ? 'Saving…' : 'Save changes'}
          </button>

          {/*
            THE WAY OUT, named for what actually happened.

            "Patient declined" where there is a charge to take off, "Cancel
            test" where there is not — the clinic changing its mind and the
            patient refusing are different facts, and a report that cannot tell
            them apart cannot tell a clinical decision from a commercial one.
          */}
          <button
            type="button"
            className="btn-ghost !text-coral"
            disabled={working}
            onClick={() => void withdraw()}
          >
            {busy === 'withdrawing' ? 'Working…' : billed ? 'Patient declined' : 'Cancel test'}
          </button>

          <button type="button" className="btn-ghost ml-auto" disabled={working} onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
