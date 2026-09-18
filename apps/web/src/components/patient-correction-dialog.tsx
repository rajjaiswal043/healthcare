'use client';

import { useState } from 'react';
import {
  api,
  ApiRequestError,
  type DuplicateCandidate,
  type PatientCorrectionInput,
  type PatientDetail,
} from '@/lib/api';
import { IconAlert, IconCheck } from '@/components/icons';

const GENDERS = ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'] as const;
/**
 * The database's own spelling, paired with what a clinic reads.
 *
 * This list said `A_POS`, and so did the server DTO that validated it — the two
 * agreed with each other and with nothing else. `BloodGroup` in the schema has
 * always been `A_POSITIVE`, so every correction that touched this field passed
 * validation, reached Prisma, and died there as an unhandled 500: "Something
 * went wrong. Quote the correlation id." Registration was never affected,
 * because its own list was right.
 *
 * It broke the read path too, quietly. The dialog prefills from
 * `patient.bloodGroup`, which is `A_POSITIVE`; with no option of that value a
 * `<select>` has selectedIndex -1 and renders BLANK, so a patient with a
 * recorded blood group looked like a patient without one.
 *
 * Pairs rather than a bare list, matching the registration screen: deriving the
 * label by string surgery on the value is what made a wrong value display
 * plausibly ("A_POS".replace('_POS','+') is a tidy "A+") and hid the mismatch
 * from anyone reading the UI.
 */
const BLOOD_GROUPS = [
  ['UNKNOWN', 'Unknown'],
  ['O_POSITIVE', 'O+'],
  ['O_NEGATIVE', 'O−'],
  ['A_POSITIVE', 'A+'],
  ['A_NEGATIVE', 'A−'],
  ['B_POSITIVE', 'B+'],
  ['B_NEGATIVE', 'B−'],
  ['AB_POSITIVE', 'AB+'],
  ['AB_NEGATIVE', 'AB−'],
] as const;

/**
 * Correcting a patient's details — FR-P36-20.
 *
 * **The UHID is shown and cannot be edited**, rather than hidden. A receptionist
 * looking for it needs to see that it exists and is fixed; a field that simply
 * vanishes reads as a bug. ABHA is treated the same way. The server refuses both
 * regardless, which is the part that actually enforces it.
 *
 * Only changed fields are sent. The API diffs anyway, but sending the whole form
 * would make every save look like a correction of every field to anybody reading
 * the network tab, and the smaller request is the honest description of what
 * happened.
 */
export function PatientCorrectionDialog({
  patient,
  onClose,
  onSaved,
}: {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: patient.name,
    gender: patient.gender,
    birthDate: patient.birthDate ? String(patient.birthDate).slice(0, 10) : '',
    ageYears: patient.ageYears === null ? '' : String(patient.ageYears),
    mobile: patient.mobile,
    email: patient.email ?? '',
    addressLine: patient.addressLine ?? '',
    city: patient.city ?? '',
    state: patient.state ?? '',
    postalCode: patient.postalCode ?? '',
    bloodGroup: patient.bloodGroup,
    emergencyContactName: patient.emergencyContactName ?? '',
    emergencyContactMobile: patient.emergencyContactMobile ?? '',
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);

  function set(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setError(null);

    /**
     * Build the patch from what actually differs.
     *
     * An empty string means "clear this", which is not the same as leaving it
     * alone — so a field that was empty and still is gets left out entirely,
     * while one that was filled and is now blank is sent as undefined only if it
     * never had a value.
     */
    const input: PatientCorrectionInput = {};
    if (form.name.trim() !== patient.name) input.name = form.name.trim();
    if (form.gender !== patient.gender) input.gender = form.gender;
    if (form.mobile !== patient.mobile) input.mobile = form.mobile;

    const originalBirth = patient.birthDate ? String(patient.birthDate).slice(0, 10) : '';
    if (form.birthDate && form.birthDate !== originalBirth) input.birthDate = form.birthDate;

    const originalAge = patient.ageYears === null ? '' : String(patient.ageYears);
    if (form.ageYears && form.ageYears !== originalAge) input.ageYears = Number(form.ageYears);

    for (const key of [
      'email',
      'addressLine',
      'city',
      'state',
      'postalCode',
      'emergencyContactName',
      'emergencyContactMobile',
    ] as const) {
      const next = form[key].trim();
      const previous = (patient[key] ?? '') as string;
      if (next !== previous && next !== '') input[key] = next;
    }

    if (form.bloodGroup !== patient.bloodGroup) input.bloodGroup = form.bloodGroup;

    if (Object.keys(input).length === 0) {
      onClose();
      setBusy(false);
      return;
    }

    try {
      const result = await api.correctPatient(patient.id, input);
      // Shown, not blocking: the correction has already been saved, and a
      // duplicate is something the front desk resolves by merging.
      setDuplicates(result.duplicatesWarned);
      onSaved();
      if (result.duplicatesWarned.length === 0) onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not save the change.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Correct ${patient.name}`}
      className="fixed inset-0 z-[60] !m-0 grid place-items-center bg-ink/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card max-h-[88vh] w-full max-w-2xl overflow-y-auto p-6">
        <p className="mono-label">Correct a record</p>
        <h2 className="mt-1 font-display text-[21px] font-bold">{patient.name}</h2>
        <p className="field-hint">
          Fixes a mistake made at registration. Every change is recorded with what it said before.
        </p>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3 py-2 text-[12.5px] text-coral-text"
          >
            <span className="mt-0.5 shrink-0">
              <IconAlert size={13} />
            </span>
            <span>{error}</span>
          </div>
        )}

        {duplicates.length > 0 && (
          <div className="mt-4 rounded-panel border border-amber/40 bg-amber-soft/50 px-3.5 py-3">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-text">
              <IconCheck size={13} />
              Saved — but this now looks like an existing patient
            </p>
            <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-ink-60">
              {duplicates.map((d) => (
                <li key={d.id}>
                  {d.name} · <span className="font-mono">{d.uhid}</span> · {d.mobile}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[12px] text-ink-40">
              If they are the same person, merge the records rather than leaving two.
            </p>
          </div>
        )}

        {/* Shown and locked, not hidden: a receptionist looking for the UHID
            needs to see that it exists and is fixed. */}
        <div className="mt-5 grid gap-3 rounded-panel border border-ink/10 bg-bg-soft px-3.5 py-3 sm:grid-cols-2">
          <div>
            <p className="mono-label">UHID · cannot change</p>
            <p className="font-mono text-[13.5px]">{patient.uhid}</p>
          </div>
          <div>
            <p className="mono-label">ABHA · cannot change</p>
            <p className="font-mono text-[13.5px]">{patient.abhaNumber ?? '—'}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Name" value={form.name} onChange={(v) => set('name', v)} />

          <div>
            <label htmlFor="gender" className="field-label">
              Sex
            </label>
            <select
              id="gender"
              className="field-input !py-2"
              value={form.gender}
              onChange={(e) => set('gender', e.target.value)}
            >
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g.charAt(0) + g.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Date of birth"
            type="date"
            value={form.birthDate}
            onChange={(v) => set('birthDate', v)}
            hint="Setting this clears the recorded age."
          />
          <Field
            label="Age"
            value={form.ageYears}
            onChange={(v) => set('ageYears', v.replace(/\D/g, '').slice(0, 3))}
            hint="Setting this clears the date of birth."
          />

          <Field
            label="Mobile"
            value={form.mobile}
            onChange={(v) => set('mobile', v.replace(/\D/g, '').slice(0, 10))}
          />
          <Field label="Email" value={form.email} onChange={(v) => set('email', v)} />

          <Field label="Address" value={form.addressLine} onChange={(v) => set('addressLine', v)} />
          <Field label="City" value={form.city} onChange={(v) => set('city', v)} />
          <Field label="State" value={form.state} onChange={(v) => set('state', v)} />
          <Field
            label="PIN"
            value={form.postalCode}
            onChange={(v) => set('postalCode', v.replace(/\D/g, '').slice(0, 6))}
          />

          <div>
            <label htmlFor="bloodGroup" className="field-label">
              Blood group
            </label>
            <select
              id="bloodGroup"
              className="field-input !py-2"
              value={form.bloodGroup}
              onChange={(e) => set('bloodGroup', e.target.value)}
            >
              {BLOOD_GROUPS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Emergency contact"
            value={form.emergencyContactName}
            onChange={(v) => set('emergencyContactName', v)}
          />
          <Field
            label="Emergency mobile"
            value={form.emergencyContactMobile}
            onChange={(v) => set('emergencyContactMobile', v.replace(/\D/g, '').slice(0, 10))}
          />
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || form.name.trim().length < 2}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save correction'}
          </button>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {duplicates.length > 0 ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
}) {
  const id = label.toLowerCase().replace(/\s+/g, '-');

  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        type={type}
        className="field-input !py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="field-hint block">{hint}</span>}
    </div>
  );
}
