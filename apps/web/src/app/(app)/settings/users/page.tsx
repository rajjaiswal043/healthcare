'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, type SeatUsage, type StaffUser } from '@/lib/api';
import { useAuth } from '@/components/auth-provider';
import { IconAlert, IconCheck, IconUserPlus, IconUsers } from '@/components/icons';

/**
 * Staff accounts for one clinic.
 *
 * Built around the awkward moment in the middle: a password we generate is shown
 * once and then gone. Everything before it is small, the reveal is the biggest
 * thing on the page, and it does not disappear on its own.
 */
export default function StaffPage() {
  const { session } = useAuth();

  const [users, setUsers] = useState<StaffUser[]>([]);
  const [seats, setSeats] = useState<SeatUsage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [mobile, setMobile] = useState('');
  const [roleKeys, setRoleKeys] = useState<string[]>([]);

  /** The one moment a plaintext password exists outside the person it belongs to. */
  /**
   * The row being edited, and the values in its form.
   *
   * One at a time: an "edit" that opened several rows at once would let an
   * administrator lose unsaved changes by clicking another row, and there is no
   * reason to edit two people simultaneously.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editMobile, setEditMobile] = useState('');

  const [issued, setIssued] = useState<{ who: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const { users, seats } = await api.staff();
      setUsers(users);
      setSeats(seats);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load staff.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (fullName.trim().length < 2 || !email.trim() || roleKeys.length === 0) return;
    setBusyId('new');
    setError(null);
    try {
      const created = await api.createStaff({
        email: email.trim(),
        fullName: fullName.trim(),
        ...(mobile.trim() ? { mobile: mobile.trim() } : {}),
        roleKeys,
      });

      setIssued({ who: created.fullName, password: created.temporaryPassword });
      setAdding(false);
      setEmail('');
      setFullName('');
      setMobile('');
      setRoleKeys([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not add them.');
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(user: StaffUser) {
    setEditingId(user.id);
    setEditName(user.fullName);
    setEditMobile(user.mobile ?? '');
    setError(null);
  }

  /**
   * Save the name and the number, and nothing else.
   *
   * `mobile` is sent even when empty — that is how a wrong number is removed,
   * and skipping the field when blank would make clearing it impossible. The
   * server reads '' as null.
   *
   * `roleKeys` is deliberately absent. The endpoint would accept it; what
   * somebody may do is a different question from what they are called, and it
   * gets its own screen rather than riding along with a typo fix.
   */
  async function saveEdit(user: StaffUser) {
    const name = editName.trim();
    if (name.length < 2) {
      setError('A name needs at least two characters.');
      return;
    }

    const saved = await act(user.id, () =>
      api.updateStaff(user.id, { fullName: name, mobile: editMobile.trim() }),
    );
    if (saved) setEditingId(null);
  }

  /**
   * Returns whether it worked, which the edit form needs.
   *
   * It used to return nothing, and every caller was fire-and-forget — fine for
   * a button that either switches somebody off or reports why not. A form is
   * different: closing it on a failure throws away what the administrator
   * typed, and they would have to retype it to find out the server still says
   * no. So failures leave the form open, with the message above it.
   */
  async function act(id: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'That did not work.');
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function reset(user: StaffUser) {
    if (!window.confirm(`Reset the password for ${user.fullName}? They will be signed out.`))
      return;

    setBusyId(user.id);
    setError(null);
    try {
      const res = await api.resetStaffPassword(user.id);
      setIssued({ who: res.fullName, password: res.temporaryPassword });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not reset it.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">Staff</h1>
          <p className="mt-1 max-w-[62ch] text-[14px] text-ink-60">
            Everyone who can sign in to this clinic. Accounts are switched off rather than deleted —
            a name on a signed consultation or an issued receipt has to keep resolving.
          </p>
        </div>
        {!adding && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <IconUserPlus size={16} />
            Add someone
          </button>
        )}
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

      {/* Shown once, and it does not dismiss itself. Everything about this block
          is trying to stop it being closed before the password reaches the
          person it belongs to. */}
      {issued && (
        <section className="card overflow-hidden border-clinical/30">
          <div className="bg-clinical-tint px-5 py-4">
            <p className="mono-label !text-clinical-text">Temporary password for {issued.who}</p>
            <p className="mt-1 text-[13.5px] text-ink-60">
              Give this to them now — it cannot be shown again. They will be asked to choose their
              own password the first time they sign in.
            </p>
          </div>
          <div className="space-y-3 p-5">
            <code className="block rounded-panel border border-ink/10 bg-bg-soft p-3 text-center font-mono text-[22px] font-bold tracking-[0.12em]">
              {issued.password}
            </code>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  void navigator.clipboard.writeText(issued.password);
                  setCopied(true);
                }}
              >
                {copied ? <IconCheck size={16} /> : null}
                {copied ? 'Copied' : 'Copy it'}
              </button>
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

      {/* Seats first: the question "can I add another doctor" is answered before
          the form that asks for one. */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {seats.map((s) => {
          const full = s.limit !== null && s.used >= s.limit;
          return (
            <div key={s.key} className="card-flat p-4">
              <p className="mono-label">{s.name}</p>
              <p className="mt-1 font-display text-[22px] font-bold">
                {s.used}
                <span className={full ? 'text-coral-text' : 'text-ink-20'}>
                  {' / '}
                  {s.limit ?? '∞'}
                </span>
              </p>
              <p className="text-[12px] text-ink-40">
                {s.limit === null ? 'No limit set' : full ? 'All seats in use' : 'seats used'}
              </p>
            </div>
          );
        })}
      </section>

      {adding && (
        <section className="card p-5">
          <h2 className="font-display text-[19px] font-bold">Add someone</h2>
          <p className="mt-1 text-[13px] text-ink-60">
            They get a temporary password on the next screen. Nothing is emailed — you hand it over.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="field-label">Full name</span>
              <input
                className="field-input mt-1"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                maxLength={200}
                placeholder="Dr Anjali Deshpande"
              />
            </label>
            <label className="block">
              <span className="field-label">Email</span>
              <input
                className="field-input mt-1"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={255}
                placeholder="anjali@clinic.in"
              />
            </label>
            <label className="block">
              <span className="field-label">Mobile (optional)</span>
              <input
                className="field-input mt-1"
                inputMode="numeric"
                value={mobile}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="9876543210"
              />
            </label>
          </div>

          <div className="mt-4">
            <p className="field-label">
              What can they do? <span className="text-coral">*</span>
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {seats.map((s) => {
                const on = roleKeys.includes(s.key);
                const full = s.limit !== null && s.used >= s.limit;
                return (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={on}
                    disabled={full && !on}
                    title={
                      full && !on
                        ? `All ${s.limit} ${s.name.toLowerCase()} seats are in use`
                        : undefined
                    }
                    onClick={() =>
                      setRoleKeys((prev) =>
                        on ? prev.filter((k) => k !== s.key) : [...prev, s.key],
                      )
                    }
                    className={[
                      'rounded-pill border-[1.5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                      on
                        ? 'border-clinical bg-clinical text-white'
                        : full
                          ? 'cursor-not-allowed border-ink/8 bg-ink/5 text-ink-20'
                          : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25',
                    ].join(' ')}
                  >
                    {s.name}
                    {full && !on ? ' · full' : ''}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={
                busyId === 'new' ||
                !email.trim() ||
                fullName.trim().length < 2 ||
                roleKeys.length === 0
              }
              onClick={() => void add()}
            >
              {busyId === 'new' ? 'Adding…' : 'Add them'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="card overflow-hidden">
        <header className="flex items-center gap-2 border-b border-ink/8 bg-bg-soft px-4 py-2.5">
          <span className="text-ink-40">
            <IconUsers size={16} />
          </span>
          <p className="mono-label">Everyone</p>
          <span className="badge-neutral ml-auto">{users.length}</span>
        </header>

        <ul className="divide-y divide-ink/6">
          {users.map((u) => {
            const isMe = u.id === session?.userId;
            return (
              <li
                key={u.id}
                className={`flex flex-wrap items-center gap-3 px-4 py-3 ${u.isActive ? '' : 'opacity-55'}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-semibold">
                    {u.fullName}
                    {isMe && <span className="badge-neutral">you</span>}
                    {!u.isActive && <span className="badge-neutral">switched off</span>}
                    {u.mustChangePassword && u.isActive && (
                      <span className="badge-amber">has not set a password</span>
                    )}
                    {u.lockedUntil && <span className="badge-coral">locked out</span>}
                  </p>
                  {/* The mobile sits between the two identifiers on purpose:
                      it is now editable, and a field that can be changed but
                      not seen gives an administrator no way to tell whether the
                      change they just made is the one they meant. Omitted
                      entirely when there is none, rather than shown as a blank
                      or a dash — the row already carries enough. */}
                  <p className="truncate text-[12.5px] text-ink-40">
                    {u.email}
                    {u.mobile ? ` · ${u.mobile}` : ''}
                    {' · '}
                    {u.roles.map((r) => r.name).join(', ')}
                    {' · '}
                    {u.lastLoginAt
                      ? `last signed in ${new Date(u.lastLoginAt).toLocaleDateString('en-IN')}`
                      : 'never signed in'}
                  </p>
                </div>

                <div className="flex flex-wrap justify-end gap-1.5">
                  <button
                    type="button"
                    className="btn-secondary !px-2.5 !py-1.5 text-[12.5px]"
                    disabled={busyId === u.id}
                    onClick={() => (editingId === u.id ? setEditingId(null) : startEdit(u))}
                  >
                    {editingId === u.id ? 'Cancel' : 'Edit'}
                  </button>
                  {u.isActive && (
                    <button
                      type="button"
                      className="btn-secondary !px-2.5 !py-1.5 text-[12.5px]"
                      disabled={busyId === u.id}
                      onClick={() => void reset(u)}
                    >
                      Reset password
                    </button>
                  )}
                  {/* Deactivating yourself is refused by the server too. Hiding
                      the button is only so nobody tries. */}
                  {!isMe && (
                    <button
                      type="button"
                      className={
                        u.isActive
                          ? 'btn-ghost !px-2.5 !py-1.5 text-[12.5px] !text-coral-text'
                          : 'btn-secondary !px-2.5 !py-1.5 text-[12.5px]'
                      }
                      disabled={busyId === u.id}
                      onClick={() => void act(u.id, () => api.setStaffActive(u.id, !u.isActive))}
                    >
                      {u.isActive ? 'Switch off' : 'Switch on'}
                    </button>
                  )}
                </div>

                {/* Inside the row, not a dialog: the thing being edited stays
                    on screen above the fields, so there is never a question of
                    whose name is in the box. `basis-full` makes it a second
                    line of the same flex row. */}
                {editingId === u.id && (
                  <div className="basis-full rounded-panel border border-ink/10 bg-bg-soft p-3.5">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="block">
                        <span className="field-label">Full name</span>
                        <input
                          className="field-input mt-1"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={200}
                          autoFocus
                        />
                      </label>
                      <label className="block">
                        <span className="field-label">Mobile</span>
                        <input
                          className="field-input mt-1"
                          inputMode="numeric"
                          value={editMobile}
                          onChange={(e) =>
                            setEditMobile(e.target.value.replace(/\D/g, '').slice(0, 10))
                          }
                          placeholder="9876543210"
                        />
                        <span className="field-hint">Clear it to remove the number.</span>
                      </label>
                      {/* Shown, and not editable. The email is the login
                          identifier — changing it changes who the account IS,
                          which is a different act from correcting a name, and
                          the server refuses it outright. It is here so the
                          administrator can see which account these fields
                          belong to. */}
                      <div>
                        <span className="field-label">Email</span>
                        <p className="mt-1 truncate rounded-panel border border-ink/10 bg-ink/5 px-3.5 py-2.5 text-[15px] text-ink-40">
                          {u.email}
                        </p>
                        <span className="field-hint">Cannot be changed.</span>
                      </div>
                    </div>

                    <div className="mt-3.5 flex gap-2">
                      <button
                        type="button"
                        className="btn-primary !px-3 !py-1.5 text-[13px]"
                        disabled={busyId === u.id}
                        onClick={() => void saveEdit(u)}
                      >
                        {busyId === u.id ? 'Saving…' : 'Save changes'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary !px-3 !py-1.5 text-[13px]"
                        disabled={busyId === u.id}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
