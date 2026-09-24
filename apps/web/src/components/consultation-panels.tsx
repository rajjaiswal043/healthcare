'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiRequestError,
  type DiagnosisCode,
  type DiagnosisEntry,
  type Encounter,
  type FormularyItem,
  type PrescriptionEntry,
  type Vitals,
} from '@/lib/api';
import { IconAlert, IconCheck, IconSearch, IconX } from './icons';

/**
 * The three editors on the consultation screen.
 *
 * They share one contract: each takes the encounter, and an `onSaved` callback
 * that receives the server's updated copy. Nothing keeps a local mirror of what
 * the server holds — after every write the whole encounter comes back and
 * replaces what was on screen. On a clinical record, a UI that believes its own
 * optimistic copy is a UI that can show a doctor something that was never saved.
 */

interface PanelProps {
  encounter: Encounter;
  onSaved: (e: Encounter) => void;
  onError: (message: string) => void;
  /** False once signed. Every editor hides its controls rather than disabling them. */
  editable: boolean;
}

const message = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? err.error.message : fallback;

// =============================================================================
// Vitals
// =============================================================================

/**
 * Ranges that trigger a warning, NOT a refusal.
 *
 * The database rejects impossibilities (a 700 kg weight); this flags the
 * clinically notable. The distinction matters: a patient really can have a
 * temperature of 40.5, and software that argues with the thermometer is software
 * a nurse works around.
 */
const NOTABLE: Record<string, [number, number, string]> = {
  systolicMmHg: [90, 140, 'outside 90–140'],
  diastolicMmHg: [60, 90, 'outside 60–90'],
  pulseBpm: [60, 100, 'outside 60–100'],
  temperatureC: [36, 37.5, 'febrile'],
  spo2Percent: [94, 100, 'low'],
  respiratoryRate: [12, 20, 'outside 12–20'],
};

const VITAL_FIELDS: Array<{ key: keyof Vitals; label: string; unit: string; step?: string }> = [
  { key: 'heightCm', label: 'Height', unit: 'cm', step: '0.1' },
  { key: 'weightKg', label: 'Weight', unit: 'kg', step: '0.1' },
  { key: 'systolicMmHg', label: 'BP systolic', unit: 'mmHg' },
  { key: 'diastolicMmHg', label: 'BP diastolic', unit: 'mmHg' },
  { key: 'pulseBpm', label: 'Pulse', unit: '/min' },
  { key: 'temperatureC', label: 'Temperature', unit: '°C', step: '0.1' },
  { key: 'spo2Percent', label: 'SpO₂', unit: '%' },
  { key: 'respiratoryRate', label: 'Resp. rate', unit: '/min' },
];

export function VitalsPanel({ encounter, onSaved, onError, editable }: PanelProps) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const latest = encounter.latestVitals;
  const anyEntered = Object.values(draft).some((v) => v.trim() !== '');

  async function save() {
    const payload: Record<string, number> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (value.trim() === '') continue;
      const n = Number(value);
      if (Number.isNaN(n)) {
        onError(`${key} is not a number.`);
        return;
      }
      payload[key] = n;
    }

    setBusy(true);
    try {
      onSaved(await api.recordVitals(encounter.id, payload));
      setDraft({});
    } catch (err) {
      onError(message(err, 'Could not save the vitals.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="mono-label">Vitals</p>
        {latest && (
          <p className="text-[11.5px] text-ink-40">
            last at{' '}
            {new Date(latest.recordedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}
          </p>
        )}
      </div>

      {latest ? (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          {VITAL_FIELDS.map(({ key, label, unit }) => {
            const value = latest[key] as number | null;
            if (value === null) return null;
            const range = NOTABLE[key];
            const notable = range && (value < range[0] || value > range[1]);

            return (
              <span key={key} className="text-[13px]">
                <span className="mono-label block !text-[9.5px]">{label}</span>
                <span className={notable ? 'font-bold text-coral-text' : 'font-semibold'}>
                  {value}
                  <span className="ml-0.5 text-[11px] font-normal text-ink-40">{unit}</span>
                </span>
              </span>
            );
          })}
          {latest.bmi !== null && (
            <span className="text-[13px]">
              <span className="mono-label block !text-[9.5px]">BMI</span>
              <span className="font-semibold">{latest.bmi}</span>
            </span>
          )}
        </div>
      ) : (
        <p className="field-hint mt-2">Nothing recorded yet.</p>
      )}

      {editable && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {VITAL_FIELDS.map(({ key, label, unit, step }) => (
              <label key={key} className="block">
                <span className="mono-label !text-[9.5px]">
                  {label} <span className="text-ink-20">{unit}</span>
                </span>
                <input
                  type="number"
                  step={step ?? '1'}
                  inputMode="decimal"
                  className="field-input mt-1 !py-1.5 text-[13px]"
                  value={draft[key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>

          <button
            type="button"
            className="btn-secondary mt-3 !py-1.5 text-[12.5px]"
            disabled={!anyEntered || busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Record vitals'}
          </button>

          {/* Each save is a new observation, not an edit of the last. Vitals can
              legitimately be taken twice in one visit, and the second reading is
              a fact about the visit, not a correction of the first. */}
          {encounter.vitals.length > 1 && (
            <p className="field-hint mt-2">
              {encounter.vitals.length} sets recorded this visit — the most recent is shown.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// =============================================================================
// Diagnoses
// =============================================================================

export function DiagnosesPanel({ encounter, onSaved, onError, editable }: PanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DiagnosisCode[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      return;
    }

    // Debounced: a doctor types faster than a round trip, and firing per
    // keystroke makes the list flicker between stale and fresh answers.
    const t = setTimeout(() => {
      void api
        .diagnosisCodes(query)
        .then((r) => setResults(r.codes))
        .catch(() => setResults([]));
    }, 180);

    return () => clearTimeout(t);
  }, [query, open]);

  async function commit(next: DiagnosisEntry[]) {
    setBusy(true);
    try {
      onSaved(
        await api.setDiagnoses(
          encounter.id,
          next.map((d) => ({
            ...(d.code ? { code: d.code } : {}),
            display: d.display,
            isPrimary: d.isPrimary,
          })),
        ),
      );
    } catch (err) {
      onError(message(err, 'Could not save the diagnosis.'));
    } finally {
      setBusy(false);
    }
  }

  function add(entry: { code: string | null; display: string }) {
    if (encounter.diagnoses.some((d) => d.code === entry.code && d.display === entry.display)) {
      return;
    }
    void commit([
      ...encounter.diagnoses,
      { ...entry, isPrimary: encounter.diagnoses.length === 0 },
    ]);
    setQuery('');
    setResults([]);
  }

  return (
    <section className="card p-5">
      <p className="mono-label">Diagnosis</p>

      {encounter.diagnoses.length === 0 ? (
        <p className="field-hint mt-2">None recorded.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {encounter.diagnoses.map((d, i) => (
            <li
              key={d.id ?? `${d.code}-${i}`}
              className="flex items-start justify-between gap-3 rounded-panel border border-ink/10 bg-white px-3 py-2"
            >
              <span className="min-w-0">
                <span className="text-[13.5px] font-semibold">{d.display}</span>
                {d.code && (
                  <span className="ml-2 font-mono text-[11.5px] text-ink-40">{d.code}</span>
                )}
                {d.isPrimary && <span className="badge badge-clinical ml-2">Primary</span>}
              </span>

              {editable && (
                <span className="flex shrink-0 gap-1">
                  {!d.isPrimary && (
                    <button
                      type="button"
                      className="btn-ghost !px-2 !py-1 text-[11.5px]"
                      disabled={busy}
                      title="Make this the primary diagnosis"
                      onClick={() =>
                        void commit(
                          encounter.diagnoses.map((x, j) => ({ ...x, isPrimary: j === i })),
                        )
                      }
                    >
                      Set primary
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-ghost !px-1.5 !py-1"
                    aria-label={`Remove ${d.display}`}
                    disabled={busy}
                    onClick={() => void commit(encounter.diagnoses.filter((_, j) => j !== i))}
                  >
                    <IconX size={13} />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <div className="relative mt-3">
          <div className="relative flex items-center">
            <span className="pointer-events-none absolute left-3.5 text-ink-20">
              <IconSearch size={15} />
            </span>
            <input
              className="field-input-icon !py-2"
              placeholder="Search ICD-10, or type a diagnosis"
              value={query}
              onFocus={() => setOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onKeyDown={(e) => {
                // Enter accepts free text. A code set never covers everything,
                // and a missing code must never block a consultation.
                if (e.key === 'Enter' && query.trim().length >= 2) {
                  e.preventDefault();
                  const exact = results[0];
                  add(exact ?? { code: null, display: query.trim() });
                }
              }}
            />
          </div>

          {open && results.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-panel border border-ink/12 bg-card shadow-lg">
              {results.map((c) => (
                <li key={c.code}>
                  <button
                    type="button"
                    className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-[13px] hover:bg-bg-soft"
                    onClick={() => add({ code: c.code, display: c.display })}
                  >
                    <span className="font-mono text-[11.5px] text-clinical-text">{c.code}</span>
                    <span>{c.display}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="field-hint mt-1.5">
            Press Enter to record what you typed if the code you want is not listed.
          </p>
        </div>
      )}
    </section>
  );
}

// =============================================================================
// Prescriptions
// =============================================================================

const FREQUENCIES = ['1-0-1', '1-1-1', '1-0-0', '0-0-1', '0-1-0', 'SOS', 'STAT'];

type DraftRx = {
  drugName: string;
  strength: string;
  form: string;
  dose: string;
  frequency: string;
  durationDays: string;
  instructions: string;
};

const EMPTY_RX: DraftRx = {
  drugName: '',
  strength: '',
  form: '',
  dose: '1 tablet',
  frequency: '1-0-1',
  durationDays: '5',
  instructions: '',
};

export function PrescriptionsPanel({ encounter, onSaved, onError, editable }: PanelProps) {
  const [row, setRow] = useState<DraftRx>(EMPTY_RX);
  const [matches, setMatches] = useState<FormularyItem[]>([]);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (row.drugName.trim().length < 2) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      void api
        .formulary(row.drugName)
        .then((r) => setMatches(r.items))
        .catch(() => setMatches([]));
    }, 180);
    return () => clearTimeout(t);
  }, [row.drugName]);

  const commit = useCallback(
    async (next: PrescriptionEntry[]) => {
      setBusy(true);
      try {
        onSaved(
          await api.setPrescriptions(
            encounter.id,
            next.map((p) => ({
              drugName: p.drugName,
              ...(p.strength ? { strength: p.strength } : {}),
              ...(p.form ? { form: p.form } : {}),
              dose: p.dose,
              frequency: p.frequency,
              ...(p.route ? { route: p.route } : {}),
              ...(p.durationDays ? { durationDays: p.durationDays } : {}),
              ...(p.quantity ? { quantity: p.quantity } : {}),
              ...(p.instructions ? { instructions: p.instructions } : {}),
            })),
          ),
        );
      } catch (err) {
        onError(message(err, 'Could not save the prescription.'));
      } finally {
        setBusy(false);
      }
    },
    [encounter.id, onSaved, onError],
  );

  async function addRow() {
    if (row.drugName.trim().length < 2) return;

    await commit([
      ...encounter.prescriptions,
      {
        drugName: row.drugName.trim(),
        strength: row.strength.trim() || null,
        form: row.form || null,
        dose: row.dose.trim() || '1 tablet',
        frequency: row.frequency.trim() || '1-0-1',
        route: 'ORAL',
        durationDays: row.durationDays ? Number(row.durationDays) : null,
        quantity: null,
        instructions: row.instructions.trim() || null,
      },
    ]);

    setRow(EMPTY_RX);
    setMatches([]);
    nameRef.current?.focus();
  }

  return (
    <section className="card p-5">
      <p className="mono-label">Prescription</p>

      {encounter.prescriptions.length === 0 ? (
        <p className="field-hint mt-2">Nothing prescribed.</p>
      ) : (
        <ol className="mt-3 space-y-1.5">
          {encounter.prescriptions.map((p, i) => (
            <li
              key={p.id ?? i}
              className="flex items-start justify-between gap-3 rounded-panel border border-ink/10 bg-white px-3 py-2"
            >
              <span className="min-w-0">
                <span className="text-[13.5px] font-semibold">
                  {i + 1}. {p.drugName}
                  {p.strength ? ` ${p.strength}` : ''}
                </span>
                <span className="block text-[12.5px] text-ink-60">
                  {p.dose} · <span className="font-mono">{p.frequency}</span>
                  {p.durationDays ? ` · ${p.durationDays} days` : ''}
                  {p.instructions ? ` · ${p.instructions}` : ''}
                </span>
              </span>

              {editable && (
                <button
                  type="button"
                  className="btn-ghost shrink-0 !px-1.5 !py-1"
                  aria-label={`Remove ${p.drugName}`}
                  disabled={busy}
                  onClick={() => void commit(encounter.prescriptions.filter((_, j) => j !== i))}
                >
                  <IconX size={13} />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {editable && (
        <div className="mt-4 rounded-panel border border-dashed border-ink/20 bg-bg-soft/60 p-3">
          <div className="relative">
            <input
              ref={nameRef}
              className="field-input !py-2"
              placeholder="Drug name — start typing"
              value={row.drugName}
              onChange={(e) => setRow({ ...row, drugName: e.target.value })}
            />
            {matches.length > 0 && (
              <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-panel border border-ink/12 bg-card shadow-lg">
                {matches.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left text-[13px] hover:bg-bg-soft"
                      onClick={() => {
                        setRow({
                          ...row,
                          drugName: m.name,
                          strength: m.strength ?? '',
                          form: m.form ?? '',
                        });
                        setMatches([]);
                      }}
                    >
                      <span className="font-semibold">{m.name}</span>
                      {m.strength && <span className="ml-2 text-ink-60">{m.strength}</span>}
                      {m.genericName && (
                        <span className="block text-[11.5px] text-ink-40">{m.genericName}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <input
              className="field-input !py-1.5 text-[13px]"
              placeholder="Strength"
              value={row.strength}
              onChange={(e) => setRow({ ...row, strength: e.target.value })}
            />
            <input
              className="field-input !py-1.5 text-[13px]"
              placeholder="Dose"
              value={row.dose}
              onChange={(e) => setRow({ ...row, dose: e.target.value })}
            />
            <input
              className="field-input !py-1.5 font-mono text-[13px]"
              placeholder="1-0-1"
              value={row.frequency}
              onChange={(e) => setRow({ ...row, frequency: e.target.value })}
            />
            <input
              type="number"
              min={1}
              max={365}
              className="field-input !py-1.5 text-[13px]"
              placeholder="Days"
              value={row.durationDays}
              onChange={(e) => setRow({ ...row, durationDays: e.target.value })}
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-1">
            {FREQUENCIES.map((f) => (
              <button
                key={f}
                type="button"
                className={[
                  'rounded-pill border px-2 py-0.5 font-mono text-[11.5px]',
                  row.frequency === f
                    ? 'border-clinical bg-clinical text-white'
                    : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25',
                ].join(' ')}
                onClick={() => setRow({ ...row, frequency: f })}
              >
                {f}
              </button>
            ))}
          </div>

          <input
            className="field-input mt-2 !py-1.5 text-[13px]"
            placeholder="Instructions — after food, at bedtime"
            value={row.instructions}
            onChange={(e) => setRow({ ...row, instructions: e.target.value })}
          />

          <button
            type="button"
            className="btn-secondary mt-2 !py-1.5 text-[12.5px]"
            disabled={row.drugName.trim().length < 2 || busy}
            onClick={() => void addRow()}
          >
            <IconCheck size={13} />
            Add to prescription
          </button>
        </div>
      )}
    </section>
  );
}

// =============================================================================
// Addenda
// =============================================================================

export function AddendaPanel({
  encounter,
  onSaved,
  onError,
  canWrite,
}: {
  encounter: Encounter;
  onSaved: (e: Encounter) => void;
  onError: (message: string) => void;
  canWrite: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      onSaved(await api.addAddendum(encounter.id, text.trim()));
      setText('');
    } catch (err) {
      onError(message(err, 'Could not add the addendum.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-5">
      <p className="mono-label">Addenda</p>

      {encounter.addenda.length === 0 ? (
        <p className="field-hint mt-2">No corrections have been added.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {encounter.addenda.map((a) => (
            <li
              key={a.id}
              className="rounded-panel border-l-[3px] border-amber bg-amber-soft/30 p-3"
            >
              <p className="whitespace-pre-wrap text-[13.5px]">{a.text}</p>
              <p className="mt-1.5 text-[11.5px] text-ink-40">
                {a.authorLabel} · {new Date(a.createdAt).toLocaleString('en-IN')}
              </p>
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="mt-3">
          <div className="flex items-start gap-2 rounded-panel border border-amber/40 bg-amber-soft/40 p-3 text-[12.5px]">
            <span className="mt-0.5 shrink-0 text-amber-text">
              <IconAlert size={14} />
            </span>
            <span>
              This consultation is signed and cannot be edited. An addendum is added beneath it,
              timestamped and attributed — the original stays exactly as it was written.
            </span>
          </div>

          <textarea
            className="field-input mt-2 min-h-[80px] text-[13.5px]"
            placeholder="What needs correcting or adding?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={5000}
          />

          <button
            type="button"
            className="btn-secondary mt-2 !py-1.5 text-[12.5px]"
            disabled={text.trim().length < 3 || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add addendum'}
          </button>
        </div>
      )}
    </section>
  );
}
