'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiRequestError, type ClinicalDocument, type DayBoardRow } from '@/lib/api';
import { IconAlert, IconCheck } from '@/components/icons';

/** Matches the worklist, which matches what the server will store. */
const ACCEPT = 'image/png,image/jpeg,image/webp,image/tiff,application/pdf';
const MAX_MB = 25;

/**
 * Recording a test result from the day board.
 *
 * The technician's whole job in one place: the film goes on, the reading gets
 * written, the order stops being pending. That last part is what the rest of
 * the clinic is waiting for — a pending order holds the patient under "At a
 * department" on everybody's board and holds the doctor waiting for an answer.
 *
 * THE FILE BELONGS HERE, not behind a link. It was behind one, on the reasoning
 * that the worklist already had an uploader and two uploaders would be one too
 * many. That was wrong for the job this dialog exists to do: for an X-ray the
 * film IS the result, so a dialog that takes a note but not an image sends the
 * technician to the worklist anyway — which is the screen this was meant to
 * save them opening.
 *
 * SEVERAL FILES, ONE AT A TIME. A study is often more than one view, and the
 * endpoint takes a single file per request (`files: 1`), so they go up in
 * sequence and each is listed as it lands. One failing does not lose the ones
 * already stored.
 *
 * ATTACHING IS NOT FINISHING. The order is completed by the button, with the
 * note, and the server will still take a file against a completed order — so a
 * second view turning up later is not a problem. Only a cancelled or declined
 * order refuses one.
 *
 * HANDOVER STAYS ON THE WORKLIST. Giving the film to the patient happens at the
 * counter, often hours later and often by somebody else; it is not part of
 * recording what the test showed.
 */
export function RecordResultDialog({
  row,
  orderId,
  onClose,
  onRecorded,
}: {
  row: DayBoardRow;
  orderId: string;
  onClose: () => void;
  onRecorded: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  /** Why there is no file. Only asked for, and only sent, when there is none. */
  const [noFileReason, setNoFileReason] = useState('');
  const [documents, setDocuments] = useState<ClinicalDocument[]>([]);
  const [busy, setBusy] = useState<'loading' | 'attaching' | 'completing' | null>('loading');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * What is already on this order.
   *
   * Loaded rather than assumed empty: a technician who attached a view from the
   * worklist earlier would otherwise see nothing here and send the same file
   * again. The note comes too, so a draft reading is not silently discarded.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const order = await api.diagnosticOrder(orderId);
        if (cancelled) return;
        setDocuments(order.documents ?? []);
        setNote(order.resultNote ?? '');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiRequestError ? err.error.message : 'Could not open the test.');
        }
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function attach(chosen: FileList) {
    setBusy('attaching');
    setError(null);

    // In sequence, and each one kept as it lands: a failure on the third view
    // must not throw away the two already stored.
    for (const file of Array.from(chosen)) {
      try {
        const document = await api.attachResult(orderId, file);
        setDocuments((all) => [...all, document]);
      } catch (err) {
        setError(
          err instanceof ApiRequestError
            ? err.error.message
            : `Could not attach ${file.name}. Anything before it is saved.`,
        );
        break;
      }
    }

    setBusy(null);
    // Cleared so the same file can be chosen again after a failure.
    if (fileInput.current) fileInput.current.value = '';
  }

  /**
   * WHAT COUNTS AS A RESULT — the server's rule, not a stricter one.
   *
   * `completeOrder` refuses an order carrying neither a file nor a note, and
   * accepts either. This dialog used to demand a note regardless, so somebody
   * who attached the film — which IS the result, and leaves nothing to type —
   * watched Mark done stay grey while the server would have taken it.
   *
   * Reported from the clinic on 27 Oct 2026: the technician could not log in,
   * the patient came back holding their X-ray, and the administrator had no
   * way to mark it done.
   */
  const hasResult = note.trim().length >= 2 || documents.length > 0;

  /**
   * A NOTE IS NOT A REPORT.
   *
   * Since 30 Oct 2026 the server takes a note alone only once somebody has said
   * why there is no file — a test reading COMPLETED with no image behind it was
   * reported from the clinic. Not every test produces one (a strip test read off
   * a card, a reading taken verbally), so the exception is explicit and stored
   * rather than implied by silence.
   */
  const needsWhy = documents.length === 0;
  const canRecord = hasResult && (!needsWhy || noFileReason.trim().length >= 3);

  async function record() {
    if (!canRecord) return;
    setBusy('completing');
    setError(null);

    try {
      /* An empty note is sent as empty rather than as two spaces: the server
         stores it only when there is something in it, and a note of "" beside
         an attached film is the honest record of "the film is the result". */
      await api.completeDiagnosticOrder(
        orderId,
        note.trim(),
        needsWhy ? noFileReason.trim() : undefined,
      );
      onRecorded(`${row.patient.name}’s result is recorded. The doctor can see it now.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not record the result.');
      setBusy(null);
    }
  }

  const working = busy !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Record a result for ${row.patient.name}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !working) onClose();
      }}
    >
      <div className="card flex max-h-[85vh] w-full max-sm:rounded-b-none max-w-md flex-col overflow-hidden">
        <div className="border-b border-ink/8 px-6 py-4">
          <p className="mono-label">Record a result</p>
          <h2 className="mt-1 font-display text-[20px] font-bold">{row.patient.name}</h2>
          <p className="field-hint">
            <span className="font-mono">{row.patient.uhid}</span>
            {row.withWhom ? ` · ${row.withWhom}` : ''}
          </p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3 py-2 text-[12.5px] text-coral-text"
            >
              <span className="mt-0.5 shrink-0">
                <IconAlert size={13} />
              </span>
              <span>{error}</span>
            </div>
          )}

          <div>
            <p className="field-label">The film or report</p>

            {documents.length > 0 && (
              <ul className="mb-2 space-y-1">
                {documents.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center gap-2 rounded-panel border border-ink/10 bg-bg-soft px-3 py-1.5 text-[12.5px]"
                  >
                    <span className="shrink-0 text-green-text">
                      <IconCheck size={13} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{d.fileName}</span>
                    <span className="shrink-0 font-mono text-[11.5px] text-ink-40">
                      {Math.max(1, Math.round(d.sizeBytes / 1024))} KB
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              disabled={working}
              onChange={(e) => {
                if (e.target.files?.length) void attach(e.target.files);
              }}
              className="block w-full text-[12.5px] file:mr-3 file:rounded-pill file:border-0 file:bg-ink/8 file:px-3 file:py-1.5 file:text-[12.5px] file:font-semibold file:text-ink hover:file:bg-ink/12"
            />
            <p className="field-hint">
              {busy === 'attaching'
                ? 'Uploading…'
                : `Images or a PDF, up to ${MAX_MB}MB each. Several views can go up together.`}
            </p>
          </div>

          <label className="block">
            <span className="field-label">What the test showed</span>
            <textarea
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              disabled={working}
              placeholder="No fracture seen. Soft tissue swelling over the lateral malleolus."
              className="field-input font-sans"
            />
            <span className="field-hint">
              The doctor reads this on the consultation screen, beside the order they raised.
            </span>
          </label>

          {/*
            WHY THERE IS NO FILE — asked only when there is none.

            A note is the remark ABOUT a report, not the report, and until
            30 Oct 2026 a note alone closed the test: an X-ray could read
            COMPLETED with no image behind it, which the department was
            reported doing. But a strip test read off a card or a reading taken
            verbally genuinely has no file, so the way through is to say so —
            and what is said is stored, because "which finished tests have no
            report, and why" has to stay answerable.

            Appears only with nothing attached, and disappears the moment a file
            is: a question nobody needs to answer should not be on the screen.
          */}
          {needsWhy && (
            <label className="block">
              <span className="field-label">Why is there no file to attach?</span>
              <input
                value={noFileReason}
                onChange={(e) => setNoFileReason(e.target.value)}
                maxLength={300}
                disabled={working}
                placeholder="Read off the strip; nothing printed. / Reading phoned over by the lab."
                className="field-input"
              />
              <span className="field-hint">
                Attach the report instead if there is one — this is for tests that never produce a
                file.
              </span>
            </label>
          )}

          {/* Handover is a counter job, often hours later and often somebody
              else, so it stays where the form for it lives. */}
          <p className="text-[12.5px] text-ink-40">
            Recording who collected the film is done on the{' '}
            <Link href="/diagnostics" className="text-clinical-text underline underline-offset-2">
              test worklist
            </Link>
            .
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/8 bg-bg-soft px-6 py-4">
          {/* Said before the press: this is what stops the patient appearing
              under "At a department" on every board in the clinic. */}
          {/*
            Says what is still missing, rather than leaving a grey button to be
            puzzled over. The two ways to finish are a film or a reading, and
            either alone is enough.
          */}
          <p className="text-[12px] text-ink-40">
            {!hasResult
              ? 'Attach the film or write the reading first.'
              : canRecord
                ? 'Marks the test done for everyone.'
                : 'Say why there is no file to attach.'}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={working}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!canRecord || working}
              onClick={() => void record()}
            >
              {busy === 'completing' ? 'Recording…' : 'Mark done'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
