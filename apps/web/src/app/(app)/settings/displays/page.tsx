'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiRequestError,
  type ClinicLocation,
  type DisplayDevice,
  type Practitioner,
} from '@/lib/api';
import { IconAlert, IconCheck, IconClock } from '@/components/icons';

/**
 * Pairing a waiting-room screen.
 *
 * The whole screen is arranged around one awkward fact: the key is shown once
 * and never again. Everything before the reveal is small, and the reveal itself
 * is the biggest thing on the page — because an administrator who closes it too
 * early has to pair the television a second time.
 */
export default function DisplaysPage() {
  const [devices, setDevices] = useState<DisplayDevice[]>([]);
  const [locations, setLocations] = useState<ClinicLocation[]>([]);
  const [doctors, setDoctors] = useState<Practitioner[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [chosenDoctors, setChosenDoctors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  /** The one moment the plaintext key exists outside the screen that will hold it. */
  const [issued, setIssued] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ devices }, { locations }, { practitioners }] = await Promise.all([
        api.displayDevices(),
        api.locations(),
        api.practitioners(),
      ]);
      setDevices(devices);
      setLocations(locations);
      setDoctors(practitioners);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load screens.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function pair() {
    if (name.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.pairDisplay({
        name: name.trim(),
        ...(locationId ? { locationId } : {}),
        ...(chosenDoctors.length > 0 ? { practitionerIds: chosenDoctors } : {}),
      });

      setIssued({
        name: created.name,
        url: `${window.location.origin}/display/${created.accessKey}`,
      });
      setName('');
      setLocationId('');
      setChosenDoctors([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not pair the screen.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string, deviceName: string) {
    if (!window.confirm(`Turn off “${deviceName}”? The screen will stop updating immediately.`)) {
      return;
    }
    setError(null);
    try {
      await api.revokeDisplay(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not turn it off.');
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-2 font-display text-[30px] font-bold">Waiting-room screens</h1>
        <p className="mt-1 max-w-[62ch] text-[14px] text-ink-60">
          A screen shows token numbers and the doctor&rsquo;s name — never a patient&rsquo;s. It
          signs in with its own key rather than a staff login, so nobody has to leave a session open
          on a television.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-coral/30 bg-coral/8 p-3 text-[13.5px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={14} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {/* Shown once. Everything about this block is trying to stop it being
          closed before the URL reaches the television. */}
      {issued && (
        <section className="card overflow-hidden border-clinical/30">
          <div className="bg-clinical-tint px-5 py-4">
            <p className="mono-label !text-clinical-text">{issued.name} is paired</p>
            <p className="mt-1 text-[13.5px] text-ink-60">
              Open this address on the screen. <strong>Copy it now</strong> — it cannot be shown
              again, and a screen that loses it has to be paired afresh.
            </p>
          </div>
          <div className="space-y-3 p-5">
            <code className="block break-all rounded-panel border border-ink/10 bg-bg-soft p-3 font-mono text-[12.5px]">
              {issued.url}
            </code>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  void navigator.clipboard.writeText(issued.url);
                  setCopied(true);
                }}
              >
                {copied ? <IconCheck size={16} /> : null}
                {copied ? 'Copied' : 'Copy the address'}
              </button>
              <a className="btn-secondary" href={issued.url} target="_blank" rel="noreferrer">
                Open it here
              </a>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setIssued(null);
                  setCopied(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="card p-5">
        <h2 className="font-display text-[19px] font-bold">Pair a screen</h2>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">What is it called?</span>
            <input
              className="field-input mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Ground floor waiting"
            />
          </label>

          <label className="block">
            <span className="field-label">Which waiting room?</span>
            <select
              className="field-input mt-1"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">Every location</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4">
          <p className="field-label">Which doctors?</p>
          <p className="field-hint mb-2">Choose none to show everyone sitting that day.</p>
          <div className="flex flex-wrap gap-1.5">
            {doctors.map((d) => {
              const on = chosenDoctors.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setChosenDoctors((prev) =>
                      on ? prev.filter((x) => x !== d.id) : [...prev, d.id],
                    )
                  }
                  className={[
                    'rounded-pill border-[1.5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                    on
                      ? 'border-clinical bg-clinical text-white'
                      : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25',
                  ].join(' ')}
                >
                  {d.fullName}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          className="btn-primary mt-4"
          disabled={busy || name.trim().length < 2}
          onClick={() => void pair()}
        >
          {busy ? 'Pairing…' : 'Pair this screen'}
        </button>
      </section>

      <section className="card overflow-hidden">
        <header className="flex items-center gap-2 border-b border-ink/8 bg-bg-soft px-4 py-2.5">
          <span className="text-ink-40">
            <IconClock size={16} />
          </span>
          <p className="mono-label">Paired screens</p>
          <span className="badge-neutral ml-auto">{devices.length}</span>
        </header>

        {devices.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13.5px] text-ink-40">No screens paired yet.</p>
        ) : (
          <ul className="divide-y divide-ink/6">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold">
                    {d.name}
                    {!d.isActive && <span className="badge-neutral ml-2">off</span>}
                  </p>
                  <p className="text-[12.5px] text-ink-40">
                    {d.location?.name ?? 'Every location'}
                    {' · '}
                    {d.practitionerIds.length === 0
                      ? 'all doctors'
                      : `${d.practitionerIds.length} doctor${d.practitionerIds.length === 1 ? '' : 's'}`}
                    {' · '}
                    {/* A dead screen and an idle one look identical on a wall.
                        This is how an administrator tells them apart. */}
                    {d.lastSeenAt
                      ? `last seen ${new Date(d.lastSeenAt).toLocaleString('en-IN')}`
                      : 'never connected'}
                  </p>
                </div>
                {d.isActive && (
                  <button
                    type="button"
                    className="btn-ghost !px-2.5 !py-1.5 text-[12.5px] !text-coral-text"
                    onClick={() => void revoke(d.id, d.name)}
                  >
                    Turn off
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
