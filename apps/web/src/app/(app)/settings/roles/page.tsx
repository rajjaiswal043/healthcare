'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError, type ClinicRole, type PermissionInfo } from '@/lib/api';
import {
  IconAlert,
  IconCheck,
  IconLock,
  IconRefresh,
  IconShield,
  IconUserPlus,
  IconX,
} from '@/components/icons';

type Category = { category: string; permissions: PermissionInfo[] };

/**
 * What each role in this clinic is allowed to do.
 *
 * The list is the screen; the editor is a panel over it. Two things are said
 * out loud rather than left to be discovered:
 *
 * **Administrator is locked, and the reason is on the card.** A padlock with no
 * explanation reads as a missing feature. It is the way back from every other
 * change here, so it cannot be the thing you break.
 *
 * **Saving signs people out, and the button says so before it is pressed.**
 * Permissions ride in the signed token, so a change only takes effect when the
 * holders sign in again — the alternative to interrupting three people is a
 * removed permission that still works all afternoon.
 */
export default function RolesPage() {
  const [roles, setRoles] = useState<ClinicRole[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** The role open in the editor — `'new'` for one being created. */
  const [editing, setEditing] = useState<ClinicRole | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ roles }, { categories }] = await Promise.all([
        api.clinicRoles(),
        api.permissionCatalogue(),
      ]);
      setRoles(roles);
      setCategories(categories);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load roles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function afterSave(message: string) {
    setNotice(message);
    setEditing(null);
    await load();
  }

  async function reset(role: ClinicRole) {
    if (
      !window.confirm(
        `Put “${role.name}” back to the permissions it came with? ` +
          `${role.staffCount} member${role.staffCount === 1 ? '' : 's'} of staff will be signed out.`,
      )
    )
      return;

    try {
      const result = await api.resetRole(role.id);
      await afterSave(describeSave(role.name, result.signedOut, 'put back'));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not reset it.');
    }
  }

  async function remove(role: ClinicRole) {
    if (!window.confirm(`Delete the role “${role.name}”?`)) return;

    try {
      await api.deleteRole(role.id);
      setNotice(`“${role.name}” was deleted.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not delete it.');
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">Roles and permissions</h1>
          <p className="mt-1 max-w-[62ch] text-[14px] text-ink-60">
            What each kind of staff member can do. The six built-in roles can be adjusted to suit
            this clinic but not removed, and you can add roles of your own.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          <IconUserPlus size={16} />
          Add a role
        </button>
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

      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-card border border-clinical/30 bg-clinical-tint p-3 text-[13.5px]">
          <span className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-clinical-text">
              <IconCheck size={14} />
            </span>
            <span>{notice}</span>
          </span>
          <button
            type="button"
            className="shrink-0 text-ink-40 hover:text-ink"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            <IconX size={14} />
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-[13.5px] text-ink-40">Loading…</p>
      ) : (
        <section className="grid gap-3 md:grid-cols-2">
          {roles.map((role) => (
            <article key={role.id} className="card flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-1.5 font-display text-[18px] font-bold">
                    {role.name}
                    {!role.editable && (
                      <span className="text-ink-40" title="This role cannot be changed">
                        <IconLock size={13} />
                      </span>
                    )}
                  </h2>
                  <p className="mono-label mt-0.5">{role.key}</p>
                </div>
                <span className="shrink-0 rounded-pill border border-ink/12 px-2.5 py-0.5 text-[12px] text-ink-60">
                  {role.staffCount} {role.staffCount === 1 ? 'person' : 'people'}
                </span>
              </div>

              <p className="mt-3 text-[13px] text-ink-60">
                {role.editable
                  ? `${role.permissions.length} permission${role.permissions.length === 1 ? '' : 's'}${
                      role.isSystem ? ' · built in' : ' · added by this clinic'
                    }`
                  : // Said on the card, not hidden behind the padlock. A locked
                    // thing with no reason reads as something that is broken.
                    'Holds every permission, and cannot be changed — it is how you undo a mistake made on this screen.'}
              </p>

              <div className="mt-4 flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  className="btn-ghost !py-1.5 !text-[12.5px]"
                  disabled={!role.editable}
                  onClick={() => setEditing(role)}
                >
                  {role.editable ? 'Change permissions' : 'Locked'}
                </button>
                {role.resettable && (
                  <button
                    type="button"
                    className="btn-ghost !py-1.5 !text-[12.5px]"
                    onClick={() => void reset(role)}
                  >
                    <IconRefresh size={13} />
                    Reset to default
                  </button>
                )}
                {!role.isSystem && (
                  <button
                    type="button"
                    className="btn-ghost !py-1.5 !text-[12.5px] !text-coral-text disabled:!text-ink-20"
                    disabled={!role.deletable}
                    title={
                      role.deletable ? undefined : 'Move the staff holding it to another role first'
                    }
                    onClick={() => void remove(role)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}

      {editing && (
        <RoleEditor
          role={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={afterSave}
        />
      )}
    </div>
  );
}

/** "Front desk was changed. 3 people were signed out and will need to sign in again." */
function describeSave(name: string, signedOut: number, verb: string): string {
  if (signedOut === 0) return `“${name}” was ${verb}. Nobody was signed out.`;
  return (
    `“${name}” was ${verb}. ${signedOut} ${signedOut === 1 ? 'person was' : 'people were'} ` +
    'signed out and will need to sign in again to pick up the change.'
  );
}

function RoleEditor({
  role,
  categories,
  onClose,
  onSaved,
}: {
  role: ClinicRole | null;
  categories: Category[];
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [picked, setPicked] = useState<string[]>(role?.permissions ?? []);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staffCount = role?.staffCount ?? 0;

  // A built-in keeps its name: clinics recognise "Front desk", and a support
  // call gets much harder when one clinic's Front desk is called something else.
  const nameEditable = !role?.isSystem;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return categories;
    return categories
      .map((c) => ({
        category: c.category,
        permissions: c.permissions.filter(
          (p) =>
            p.description.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
        ),
      }))
      .filter((c) => c.permissions.length > 0);
  }, [categories, query]);

  function toggle(permission: string) {
    setPicked((prev) =>
      prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission],
    );
  }

  function toggleCategory(c: Category, on: boolean) {
    const names = c.permissions.map((p) => p.name);
    setPicked((prev) =>
      on ? [...new Set([...prev, ...names])] : prev.filter((p) => !names.includes(p)),
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (role) {
        const result = await api.updateRole(role.id, {
          ...(nameEditable ? { name: name.trim() } : {}),
          description: description.trim(),
          permissions: picked,
        });
        await onSaved(describeSave(result.name, result.signedOut, 'changed'));
      } else {
        const created = await api.createRole({
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          permissions: picked,
        });
        await onSaved(`“${created.name}” was added. Assign it to staff from the Staff screen.`);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not save it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={role ? `Change ${role.name}` : 'Add a role'}
      className="fixed inset-0 z-[60] !m-0 grid place-items-center bg-ink/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden">
        <div className="border-b border-ink/10 px-6 py-4">
          <p className="mono-label">{role ? 'Change a role' : 'Add a role'}</p>
          <h2 className="mt-1 font-display text-[21px] font-bold">
            {role ? role.name : 'New role'}
          </h2>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
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

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="field-label">Name</span>
              <input
                className="field-input mt-1 disabled:bg-bg-soft disabled:text-ink-40"
                value={name}
                disabled={!nameEditable}
                maxLength={60}
                placeholder="Ward sister"
                onChange={(e) => setName(e.target.value)}
              />
              {!nameEditable && (
                <span className="field-hint block">
                  A built-in role keeps its name so it means the same thing in every clinic.
                </span>
              )}
            </label>
            <label className="block">
              <span className="field-label">What this role is for (optional)</span>
              <input
                className="field-input mt-1"
                value={description}
                maxLength={200}
                placeholder="Covers the ward outside consulting hours"
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-ink-60">
              <span className="font-semibold text-ink">{picked.length}</span> of{' '}
              {categories.reduce((n, c) => n + c.permissions.length, 0)} permissions
            </p>
            <input
              className="field-input !w-auto !py-1.5 min-w-[220px]"
              type="search"
              value={query}
              placeholder="Search permissions…"
              aria-label="Search permissions"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {shown.map((c) => {
            const names = c.permissions.map((p) => p.name);
            const all = names.every((n) => picked.includes(n));

            return (
              <section key={c.category} className="rounded-card border border-ink/10">
                <div className="flex items-center justify-between gap-3 border-b border-ink/8 bg-bg-soft px-4 py-2.5">
                  <h3 className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                    <IconShield size={13} />
                    {c.category}
                  </h3>
                  <button
                    type="button"
                    className="text-[12px] font-semibold text-clinical-text hover:underline"
                    onClick={() => toggleCategory(c, !all)}
                  >
                    {all ? 'Clear all' : 'Select all'}
                  </button>
                </div>

                <ul className="divide-y divide-ink/6">
                  {c.permissions.map((p) => (
                    <li key={p.name}>
                      <label className="flex cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-bg-soft">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 accent-clinical"
                          checked={picked.includes(p.name)}
                          onChange={() => toggle(p.name)}
                        />
                        <span>
                          <span className="block text-[13.5px]">{p.description}</span>
                          <span className="mono-label">{p.name}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          {shown.length === 0 && (
            <p className="text-[13px] text-ink-40">Nothing matches “{query}”.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/10 px-6 py-4">
          {/* Said before the press, not after. Saving ends their sessions. */}
          <p className="text-[12.5px] text-ink-40">
            {staffCount === 0
              ? 'Nobody holds this role yet.'
              : `Saving signs out ${staffCount} ${staffCount === 1 ? 'person' : 'people'} holding this role.`}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || name.trim().length < 2 || picked.length === 0}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : role ? 'Save changes' : 'Add the role'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
