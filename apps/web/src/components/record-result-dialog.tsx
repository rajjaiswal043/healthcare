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

  async function record() {
    if (note.trim().length < 2) return;
    setBusy('completing');
    setError(null);

    try {
      await api.completeDiagnosticOrder(orderId, note.trim());
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
          <p className="text-[12px] text-ink-40">Marks the test done for everyone.</p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={working}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={note.trim().length < 2 || working}
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
