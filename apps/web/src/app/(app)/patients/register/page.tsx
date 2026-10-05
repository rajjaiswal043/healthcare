'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  api,
  ApiRequestError,
  type DuplicateCandidate,
  type PatientSummary,
  type RegisterPatientInput,
} from '@/lib/api';
import { IconAlert, IconCheck, IconInfo, IconSearch, IconUserPlus } from '@/components/icons';

type Form = {
  name: string;
  gender: string;
  ageMode: 'age' | 'dob';
  ageYears: string;
  birthDate: string;
  mobile: string;
  city: string;
  state: string;
  postalCode: string;
  addressLine: string;
  bloodGroup: string;
  emergencyContactName: string;
  emergencyContactMobile: string;
  consentCareDelivery: boolean;
  consentMarketing: boolean;
  consentCommunications: boolean;
};

const EMPTY: Form = {
  name: '',
  gender: '',
  // Age-first, not DOB-first. Most Indian OPD patients do not know their date of
  // birth, and defaulting to DOB produces a register full of 01/01/1980.
  ageMode: 'age',
  ageYears: '',
  birthDate: '',
  mobile: '',
  city: '',
  state: 'Maharashtra',
  postalCode: '',
  addressLine: '',
  bloodGroup: 'UNKNOWN',
  emergencyContactName: '',
  emergencyContactMobile: '',
  consentCareDelivery: false,
  consentMarketing: false,
  consentCommunications: false,
};

const BLOOD_GROUPS = [
  ['UNKNOWN', 'Not known'],
  ['O_POSITIVE', 'O+'],
  ['O_NEGATIVE', 'O−'],
  ['A_POSITIVE', 'A+'],
  ['A_NEGATIVE', 'A−'],
  ['B_POSITIVE', 'B+'],
  ['B_NEGATIVE', 'B−'],
  ['AB_POSITIVE', 'AB+'],
  ['AB_NEGATIVE', 'AB−'],
] as const;

export default function RegisterPatientPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [blocking, setBlocking] = useState<DuplicateCandidate[]>([]);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [registered, setRegistered] = useState<PatientSummary | null>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Live duplicate check (FR-P36-03). Fires once name and a plausible mobile
  // are present, so the receptionist finds out while the patient is still
  // standing there rather than after.
  const checkDuplicates = useCallback(async (name: string, mobile: string) => {
    const digits = mobile.replace(/\D/g, '').slice(-10);
    if (name.trim().length < 3 || !/^[6-9]\d{9}$/.test(digits)) {
      setDuplicates([]);
      return;
    }

    try {
      const { duplicates: found } = await api.checkDuplicates({
        name: name.trim(),
        mobile: digits,
      });
      setDuplicates(found);
    } catch {
      // A failed duplicate check must never block registration — worst case the
      // server-side check catches it on submit.
      setDuplicates([]);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void checkDuplicates(form.name, form.mobile), 400);
    return () => clearTimeout(t);
  }, [form.name, form.mobile, checkDuplicates]);

  async function submit(confirmedNotDuplicate = false) {
    setSaving(true);
    setError(null);
    setFieldErrors([]);

    const payload: RegisterPatientInput = {
      name: form.name.trim(),
      gender: form.gender,
      mobile: form.mobile,
      consentCareDelivery: form.consentCareDelivery,
      consentMarketing: form.consentMarketing,
      consentCommunications: form.consentCommunications,
      ...(confirmedNotDuplicate ? { confirmedNotDuplicate: true } : {}),
      ...(form.ageMode === 'age' && form.ageYears ? { ageYears: Number(form.ageYears) } : {}),
      ...(form.ageMode === 'dob' && form.birthDate ? { birthDate: form.birthDate } : {}),
      ...(form.city ? { city: form.city } : {}),
      ...(form.state ? { state: form.state } : {}),
      ...(form.postalCode ? { postalCode: form.postalCode } : {}),
      ...(form.addressLine ? { addressLine: form.addressLine } : {}),
      ...(form.bloodGroup ? { bloodGroup: form.bloodGroup } : {}),
      ...(form.emergencyContactName ? { emergencyContactName: form.emergencyContactName } : {}),
      ...(form.emergencyContactMobile
        ? { emergencyContactMobile: form.emergencyContactMobile }
        : {}),
    };

    try {
      const { patient } = await api.registerPatient(payload);
      setRegistered(patient);
      setForm(EMPTY);
      setDuplicates([]);
      setBlocking([]);
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

  if (registered) return <Success patient={registered} onAgain={() => setRegistered(null)} />;

  const weak = duplicates.filter((d) => d.confidence === 'WEAK');
  const strong = duplicates.filter((d) => d.confidence === 'STRONG');

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Patient 360</p>
        <h1 className="mt-2 font-display text-[30px] font-bold">
          Register a <em className="accent-words">patient</em>
        </h1>
        <p className="mt-1 text-[14px] text-ink-60">
          Name, sex, age and mobile are all that is required. Everything else can wait.
        </p>
      </header>

      {strong.length > 0 && <DuplicateNotice candidates={strong} tone="strong" />}
      {strong.length === 0 && weak.length > 0 && <DuplicateNotice candidates={weak} tone="weak" />}

      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <section className="card p-6">
          <p className="mono-label mb-4">Who is the patient</p>
          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={saving}>
            <legend className="sr-only">Patient details</legend>

            <div className="sm:col-span-2">
              <label htmlFor="name" className="field-label">
                Full name <Req />
              </label>
              <input
                id="name"
                autoFocus
                required
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                className="field-input"
                autoComplete="off"
                placeholder="e.g. Ramesh Kulkarni"
              />
            </div>

            <div>
              <label htmlFor="mobile" className="field-label">
                Mobile <Req />
              </label>
              <input
                id="mobile"
                required
                inputMode="numeric"
                value={form.mobile}
                onChange={(e) => set('mobile', e.target.value)}
                className="field-input font-mono"
                autoComplete="off"
                placeholder="98765 43210"
              />
              <p className="field-hint">Any format — spaces and +91 are fine.</p>
            </div>

            <div>
              <label htmlFor="gender" className="field-label">
                Sex <Req />
              </label>
              <select
                id="gender"
                required
                value={form.gender}
                onChange={(e) => set('gender', e.target.value)}
                className="field-input"
              >
                <option value="">Select…</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
                <option value="UNKNOWN">Not stated</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <span className="field-label">
                Age <Req />
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <div
                  className="inline-flex rounded-pill border-[1.5px] border-ink/12 bg-white p-0.5"
                  role="group"
                  aria-label="Age or date of birth"
                >
                  {(['age', 'dob'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => set('ageMode', mode)}
                      aria-pressed={form.ageMode === mode}
                      className={[
                        'rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors',
                        form.ageMode === mode
                          ? 'bg-clinical text-white'
                          : 'text-ink-40 hover:text-ink',
                      ].join(' ')}
                    >
                      {mode === 'age' ? 'Age' : 'Date of birth'}
                    </button>
                  ))}
                </div>

                {form.ageMode === 'age' ? (
                  <input
                    aria-label="Age in years"
                    required
                    inputMode="numeric"
                    value={form.ageYears}
                    onChange={(e) => set('ageYears', e.target.value)}
                    className="field-input w-24 font-mono"
                    placeholder="years"
                  />
                ) : (
                  <input
                    aria-label="Date of birth"
                    required
                    type="date"
                    value={form.birthDate}
                    onChange={(e) => set('birthDate', e.target.value)}
                    className="field-input w-48"
                  />
                )}
              </div>
              <p className="field-hint">
                Many patients do not know their date of birth — an approximate age is better than a
                made-up date.
              </p>
            </div>
          </fieldset>
        </section>

        <section className="card p-6">
          <p className="mono-label mb-4">Contact and clinical (optional)</p>
          <fieldset className="grid gap-4 sm:grid-cols-3" disabled={saving}>
            <legend className="sr-only">Optional details</legend>

            <div>
              <label htmlFor="city" className="field-label">
                City
              </label>
              <input
                id="city"
                value={form.city}
                onChange={(e) => set('city', e.target.value)}
                className="field-input"
              />
            </div>

            <div>
              <label htmlFor="postalCode" className="field-label">
                PIN code
              </label>
              <input
                id="postalCode"
                inputMode="numeric"
                value={form.postalCode}
                onChange={(e) => set('postalCode', e.target.value)}
                className="field-input font-mono"
                placeholder="411001"
              />
            </div>

            <div>
              <label htmlFor="bloodGroup" className="field-label">
                Blood group
              </label>
              <select
                id="bloodGroup"
                value={form.bloodGroup}
                onChange={(e) => set('bloodGroup', e.target.value)}
                className="field-input"
              >
                {BLOOD_GROUPS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="emergencyContactName" className="field-label">
                Emergency contact name
              </label>
              <input
                id="emergencyContactName"
                value={form.emergencyContactName}
                onChange={(e) => set('emergencyContactName', e.target.value)}
                className="field-input"
              />
            </div>

            <div>
              <label htmlFor="emergencyContactMobile" className="field-label">
                Their mobile
              </label>
              <input
                id="emergencyContactMobile"
                inputMode="numeric"
                value={form.emergencyContactMobile}
                onChange={(e) => set('emergencyContactMobile', e.target.value)}
                className="field-input font-mono"
              />
            </div>
          </fieldset>
        </section>

        {/* Consent is part of registration, not an afterthought. Purpose-wise
            and separately checkable, because DPDP requires consent per purpose
            and prohibits bundling them. */}
        <section className="rounded-card border border-clinical/20 bg-clinical-tint p-6">
          <p className="mono-label mb-1 !text-clinical-text">Consent · DPDP Act</p>
          <p className="mb-4 text-[13px] text-ink-60">
            Recorded against this patient with a timestamp and the notice version shown.
          </p>

          <fieldset className="space-y-3" disabled={saving}>
            <legend className="sr-only">Consent</legend>

            <Consent
              id="consentCareDelivery"
              checked={form.consentCareDelivery}
              onChange={(v) => set('consentCareDelivery', v)}
              required
              title="Care delivery"
              body="Process personal and health data for treatment and medical records."
            />
            {/* docs/10. Its own purpose: messages about THIS patient's own care,
                which is not marketing and must not be bundled with it. */}
            <Consent
              id="consentCommunications"
              checked={form.consentCommunications}
              onChange={(v) => set('consentCommunications', v)}
              title="WhatsApp about their visits"
              body="Their token and live place in line, a message when it is time to leave, recovery check-ins and review reminders. Optional."
            />
            <Consent
              id="consentMarketing"
              checked={form.consentMarketing}
              onChange={(v) => set('consentMarketing', v)}
              title="Health updates and offers"
              body="Optional. Declining does not affect care in any way."
            />
          </fieldset>
        </section>

        {(error ?? fieldErrors.length > 0) && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-card border border-coral/30 bg-coral/8 p-4"
          >
            <span className="mt-0.5 shrink-0 text-coral-text">
              <IconAlert size={17} />
            </span>
            <div className="text-[13.5px]">
              {error && <p className="font-semibold text-coral-text">{error}</p>}
              {fieldErrors.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-coral-text/90">
                  {fieldErrors.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {blocking.length > 0 && (
          <div role="alert" className="rounded-card border border-amber/50 bg-amber-soft/40 p-5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-amber-text">
                <IconAlert size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display text-[16px] font-bold text-ink">
                  This looks like an existing patient
                </p>
                <p className="mt-0.5 text-[13.5px] text-ink-60">
                  Check before creating a second record — a split file means a split allergy
                  history.
                </p>
                <ul className="mt-3 space-y-1.5">
                  {blocking.map((d) => (
                    <li
                      key={d.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-tiny bg-white/70 px-3 py-2 text-[13px]"
                    >
                      <span className="font-mono text-[12px] text-ink-60">{d.uhid}</span>
                      <span className="font-semibold">{d.name}</span>
                      <span className="font-mono text-[12px] text-ink-60">{d.mobile}</span>
                      {d.matchReason === 'SAME_MOBILE' && (
                        <span className="badge-amber">same mobile</span>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href="/patients" className="btn-secondary text-[13px]">
                    <IconSearch size={15} />
                    Open the existing record
                  </Link>
                  <button
                    type="button"
                    className="btn-ghost text-[13px] !text-amber-text"
                    onClick={() => void submit(true)}
                    disabled={saving}
                  >
                    This is a different person — register anyway
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={saving}>
            <IconUserPlus size={16} />
            {saving ? 'Registering…' : 'Register patient'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setForm(EMPTY);
              setDuplicates([]);
              setBlocking([]);
              setError(null);
            }}
            disabled={saving}
          >
            Clear
          </button>
        </div>
      </form>
    </div>
  );
}

function Req() {
  return (
    <span className="text-coral" aria-label="required">
      *
    </span>
  );
}

function Consent({
  id,
  checked,
  onChange,
  title,
  body,
  required,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  body: string;
  required?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={[
        'flex cursor-pointer items-start gap-3 rounded-panel border-[1.5px] bg-white p-3.5 transition-colors',
        checked ? 'border-clinical/45' : 'border-ink/10 hover:border-ink/20',
      ].join(' ')}
    >
      <input
        id={id}
        type="checkbox"
        required={required}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={[
          'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border-[1.5px] transition-colors',
          checked ? 'border-clinical bg-clinical text-white' : 'border-ink/25 bg-white',
        ].join(' ')}
      >
        {checked && <IconCheck size={13} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold text-ink">
          {title} {required && <Req />}
        </span>
        <span className="block text-[13px] text-ink-60">{body}</span>
      </span>
    </label>
  );
}

function DuplicateNotice({
  candidates,
  tone,
}: {
  candidates: DuplicateCandidate[];
  tone: 'strong' | 'weak';
}) {
  const strong = tone === 'strong';

  return (
    <div
      className={[
        'flex items-start gap-3 rounded-card border p-4',
        strong ? 'border-amber/50 bg-amber-soft/40' : 'border-ink/10 bg-white',
      ].join(' ')}
      role={strong ? 'alert' : undefined}
    >
      <span className={`mt-0.5 shrink-0 ${strong ? 'text-amber-text' : 'text-ink-20'}`}>
        {strong ? <IconAlert size={17} /> : <IconInfo size={17} />}
      </span>
      <div className="min-w-0">
        <p className={`text-[13.5px] font-semibold ${strong ? 'text-ink' : 'text-ink-60'}`}>
          {strong
            ? 'Likely already registered'
            : `${candidates.length} similar ${candidates.length === 1 ? 'name' : 'names'} on file — probably unrelated`}
        </p>
        <ul className="mt-1.5 space-y-1 text-[13px] text-ink-60">
          {candidates.slice(0, 4).map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-2.5">
              <span className="font-mono text-[11.5px]">{d.uhid}</span>
              <span>{d.name}</span>
              <span className="font-mono text-[11.5px]">{d.mobile}</span>
              {d.matchReason === 'SAME_MOBILE' && <span className="badge-amber">same mobile</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Success({ patient, onAgain }: { patient: PatientSummary; onAgain: () => void }) {
  return (
    <div className="mx-auto max-w-lg">
      <div className="card overflow-hidden text-center">
        <div className="bg-clinical-tint px-6 pb-6 pt-8">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-clinical text-white shadow">
            <IconCheck size={26} />
          </span>
          <p className="mono-label mt-4 !text-clinical-text">Registered</p>
          <p className="mt-3 font-mono text-[34px] font-bold leading-none tracking-tight text-clinical-text">
            {patient.uhid}
          </p>
          <p className="mt-3 font-display text-[20px] font-bold">{patient.name}</p>
          <p className="font-mono text-[13px] text-ink-60">{patient.mobile}</p>
        </div>

        <div className="flex flex-wrap justify-center gap-3 p-6">
          <button type="button" className="btn-primary" onClick={onAgain}>
            <IconUserPlus size={16} />
            Register another
          </button>
          <Link href="/patients" className="btn-secondary">
            <IconSearch size={16} />
            Find a patient
          </Link>
        </div>
      </div>
    </div>
  );
}
