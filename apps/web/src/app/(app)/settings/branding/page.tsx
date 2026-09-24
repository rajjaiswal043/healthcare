'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, type PublicBranding } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { ClinicLogo } from '@/components/clinic-logo';
import { IconAlert, IconCheck } from '@/components/icons';

/**
 * Settings → Branding.
 *
 * The clinic's own name and mark, which after white-labelling are the only
 * identity the console has. Two edits and a preview, and the preview matters
 * more than it looks: a logo is chosen on this screen and then seen mostly at
 * 26 pixels in a nav rail and 52 on a printed prescription, so showing it only
 * large would let somebody pick something that turns to mush everywhere it
 * actually appears.
 *
 * The upload is read to base64 in the browser. The server re-encodes whatever
 * arrives to PNG and bounds it to 512px, so the sizes shown after a save are
 * what is stored, not what was chosen.
 */
export default function BrandingPage() {
  const { session, refresh } = useAuth();

  const [branding, setBranding] = useState<PublicBranding | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState<'name' | 'logo' | 'remove' | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const current = await api.myBranding();
      setBranding(current);
      setName(current.name);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load branding.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * After any change, refresh the session too.
   *
   * The nav rail, the header and the browser tab all read the clinic from the
   * session rather than from this page, so without this the screen would show
   * the new logo while the chrome around it still showed the old one.
   */
  async function afterChange(message: string) {
    await load();
    await refresh();
    setSaved(message);
    setError(null);
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    setBusy('name');
    try {
      await api.renameClinic(name.trim());
      await afterChange('Name updated.');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not save the name.');
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setBusy('logo');
    setSaved(null);
    try {
      const base64 = await readAsBase64(file);
      const stored = await api.setClinicLogo(base64);
      await afterChange(`Logo updated — stored at ${stored.width}×${stored.height}.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not upload that image.');
    } finally {
      setBusy(null);
      // Cleared so choosing the same file twice fires a change event the second
      // time — otherwise a failed upload cannot be retried without picking a
      // different file.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove() {
    setBusy('remove');
    setSaved(null);
    try {
      await api.clearClinicLogo();
      await afterChange('Logo removed.');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not remove the logo.');
    } finally {
      setBusy(null);
    }
  }

  const clinic = session?.tenant ?? null;

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-2 font-display text-[30px] font-bold">Branding</h1>
        <p className="mt-1 max-w-[62ch] text-[14px] text-ink-60">
          Your name and logo, as they appear on this console, the sign-in page, printed
          prescriptions and the waiting-room screen.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-panel border border-coral/25 bg-coral/8 px-3.5 py-2.5 text-[13px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={14} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {saved && !error && (
        <div className="flex items-center gap-2 rounded-panel border border-green/30 bg-green-soft/50 px-3.5 py-2.5 text-[13px] text-green-text">
          <IconCheck size={14} />
          {saved}
        </div>
      )}

      <section className="card p-6">
        <h2 className="font-display text-[19px] font-bold">Logo</h2>
        <p className="field-hint">
          PNG or JPEG, up to 512KB. Anything larger than 512 pixels is scaled down, and transparent
          backgrounds are kept. SVG is not accepted.
        </p>

        <div className="mt-5 flex flex-wrap items-end gap-8">
          {/* Two sizes on purpose: the one the eye judges, and the one it will
              actually be used at. */}
          <figure className="m-0 flex flex-col items-center gap-2">
            <div className="grid h-[104px] w-[168px] place-items-center rounded-panel border border-ink/10 bg-bg-soft px-3">
              <ClinicLogo clinic={clinic} size={72} alt="" />
            </div>
            <figcaption className="mono-label">Large</figcaption>
          </figure>

          <figure className="m-0 flex flex-col items-center gap-2">
            <div className="grid h-[104px] w-[104px] place-items-center rounded-panel border border-ink/10 bg-white">
              <ClinicLogo clinic={clinic} size={26} alt="" />
            </div>
            <figcaption className="mono-label">In the nav rail</figcaption>
          </figure>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => fileInput.current?.click()}
            >
              {busy === 'logo' ? 'Uploading…' : branding?.logoVersion ? 'Replace' : 'Upload'}
            </button>

            {branding?.logoVersion && (
              <button
                type="button"
                className="btn-danger"
                disabled={busy !== null}
                onClick={() => void remove()}
              >
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />

        {!branding?.logoVersion && (
          <p className="mt-4 text-[12.5px] text-ink-40">
            No logo of your own yet — the placeholder above is what everyone currently sees.
          </p>
        )}
      </section>

      <section className="card p-6">
        <h2 className="font-display text-[19px] font-bold">Name</h2>
        <p className="field-hint">
          What staff see in the console and what is printed at the top of a prescription.
        </p>

        <form onSubmit={rename} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <label htmlFor="clinicName" className="field-label">
              Clinic name
            </label>
            <input
              id="clinicName"
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={255}
              required
            />
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy !== null || name.trim().length < 2 || name.trim() === branding?.name}
          >
            {busy === 'name' ? 'Saving…' : 'Save'}
          </button>
        </form>

        {/* Registration facts are not display preferences. Said here so an
            administrator looking for the legal name knows it is not missing by
            accident. */}
        <p className="mt-4 text-[12.5px] text-ink-40">
          Your registered legal name is separate and is not changed here. Ask us if it needs
          correcting.
        </p>
      </section>
    </div>
  );
}

/**
 * A File as base64, without the data-URL prefix.
 *
 * FileReader rather than `arrayBuffer()` plus manual encoding: converting a
 * large Uint8Array with `String.fromCharCode(...bytes)` overflows the call
 * stack somewhere around a hundred kilobytes, which is well inside the sizes
 * this accepts.
 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
