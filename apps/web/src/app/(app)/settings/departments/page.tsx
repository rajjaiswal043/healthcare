'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiRequestError, type ManagedDepartment, type DepartmentTest } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/format';
import { IconAlert, IconCheck } from '@/components/icons';

/**
 * Settings → Departments.
 *
 * A DEPARTMENT IS A PLACE THAT DOES TESTS — X-ray, Pathology, Physio. Nobody
 * books an appointment with radiology; a doctor sends somebody there mid-visit,
 * or the desk sells a walk-in test. That is the whole of the concept.
 *
 * It existed long before this screen did, and only a seed could create one —
 * which is how a clinic ended up with five clinical departments nobody used and
 * no way to add the one they needed. Worse, a priced test is only orderable if
 * its service names a department, so an invisible table silently decided
 * whether the catalogue worked at all.
 *
 * SO THE ROOM HOLDS ITS OWN TESTS. Pricing an X-ray used to mean going to the
 * price list, choosing the Diagnostics category and then remembering to attach
 * a department — and getting that last part wrong produced a test that could be
 * billed but never ordered. Here the department is the screen you are on, so
 * neither is a question.
 *
 * AND ITS OWN STAFF, read-only. Who works in X-ray is decided when their login
 * is created, under Settings → Users; showing it here answers "is this room
 * covered" without making this a second place to change it.
 *
 * Retiring rather than deleting: a department is named on every order ever sent
 * to it, so removing the row would rewrite history. Switching it off takes it
 * out of the pickers and leaves the record intact.
 */
export default function DepartmentsPage() {
  const [departments, setDepartments] = useState<ManagedDepartment[] | null>(null);
  /** Priced tests in no room at all, which nobody can be sent for. */
  const [orphans, setOrphans] = useState<DepartmentTest[]>([]);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  /** The department whose "add a test" row is open, and what is typed into it. */
  const [newTest, setNewTest] = useState<{
    departmentId: string;
    name: string;
    rupees: string;
  } | null>(null);
  /**
   * The test being edited: its name and its price together.
   *
   * One edit rather than a rename button and a price button, because they are
   * the only two things a test has and correcting a typo in a name usually
   * comes with noticing the price too. The code is not in here — it never
   * changes, which is what makes it safe for reports to group by.
   */
  const [testDraft, setTestDraft] = useState<{ id: string; name: string; rupees: string } | null>(
    null,
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { departments, unassignedTests } = await api.setupDepartments();
      setDepartments(departments);
      setOrphans(unassignedTests);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not load the departments.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, action: () => Promise<unknown>, fallback: string) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : fallback);
    } finally {
      setBusy(null);
    }
  }

  async function addTest() {
    if (!newTest) return;

    const pricePaise = parseRupeesToPaise(newTest.rupees);
    if (pricePaise === null) {
      setError('That price is not a number.');
      return;
    }

    await run(
      `add-test-${newTest.departmentId}`,
      async () => {
        await api.addDepartmentTest(newTest.departmentId, {
          name: newTest.name.trim(),
          pricePaise,
        });
        setNewTest(null);
      },
      'Could not price that test.',
    );
  }

  async function saveTest(test: DepartmentTest) {
    if (!testDraft) return;

    const name = testDraft.name.trim();
    if (name.length < 2) {
      setError('A test needs a name.');
      return;
    }

    const pricePaise = parseRupeesToPaise(testDraft.rupees);
    if (pricePaise === null) {
      setError('That price is not a number.');
      return;
    }

    await run(
      test.id,
      async () => {
        await api.upsertService({
          /* Keyed on the code, which is why it is generated once and never
             edited: renaming a test must not orphan the reports that group by
             it, and the bills it is already on keep the name they were charged
             under either way. */
          code: test.code,
          name,
          category: 'DIAGNOSTIC',
          pricePaise,
          /* `isActive` deliberately absent: correcting a name or a price must
             not revive a test somebody switched off. */
        });
        setTestDraft(null);
      },
      'Could not save that test.',
    );
  }

  /**
   * Delete a test, when it is genuinely deletable.
   *
   * The server refuses one that has been billed or ordered — deleting that
   * would cut those records loose from what they were for — and says so, which
   * is why this asks for confirmation rather than offering a choice between
   * delete and switch off up front. The common case is a test priced by mistake
   * five minutes ago, and that one should just go.
   */
  async function deleteTest(test: DepartmentTest) {
    if (!window.confirm(`Delete “${test.name}”? This cannot be undone.`)) return;

    await run(`delete-${test.id}`, () => api.deleteService(test.id), 'Could not delete that test.');
  }

  /** Give a test that belongs to no room the room it is done in. */
  async function moveTest(test: DepartmentTest, departmentId: string) {
    await run(
      `move-${test.id}`,
      () =>
        api.upsertService({
          code: test.code,
          name: test.name,
          category: 'DIAGNOSTIC',
          pricePaise: test.pricePaise,
          departmentId,
        }),
      'Could not move that test.',
    );
  }

  const active = departments?.filter((d) => d.isActive !== false) ?? [];
  const retired = departments?.filter((d) => d.isActive === false) ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[24px] font-bold">Departments</h1>
        <p className="text-[13.5px] text-ink-60">
          Where a patient is sent for a test: X-ray, Pathology, Physio.
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

      {/* Adding one is the thing this screen exists for, so it is at the top
          rather than behind a button. */}
      <section className="card p-5">
        <p className="mono-label mb-3">Add a department</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[200px] flex-1">
            <span className="sr-only">Department name</span>
            <input
              className="field-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Physiotherapy"
              maxLength={120}
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy === 'new' || newName.trim().length < 2}
            onClick={() =>
              void run(
                'new',
                async () => {
                  /* There is no kind to choose: a department is a place that
                     does tests, and the only other state it has is retired. */
                  await api.createDepartment(newName.trim());
                  setNewName('');
                },
                'Could not add that department.',
              )
            }
          >
            Add
          </button>
        </div>
        <p className="field-hint">Then price its tests on the room itself, below.</p>
      </section>

      {departments === null ? (
        <p className="field-hint px-1">Loading…</p>
      ) : active.length === 0 ? (
        <div className="card p-5">
          <p className="field-hint">
            No departments yet. Until one exists, no test can be priced or ordered.
          </p>
        </div>
      ) : (
        active.map((d) => {
          const isRenaming = editing?.id === d.id;
          const adding = newTest?.departmentId === d.id;
          const liveTests = d.tests.filter((t) => t.isActive);

          return (
            <section key={d.id} className="card overflow-hidden">
              {/* The room itself. */}
              <div className="flex flex-wrap items-center gap-3 border-b border-ink/8 px-5 py-3">
                {isRenaming ? (
                  <>
                    <input
                      autoFocus
                      className="field-input min-w-[180px] flex-1 !py-2"
                      value={editing.name}
                      onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                      maxLength={120}
                    />
                    <button
                      type="button"
                      className="btn-primary !py-1.5 !text-[13px]"
                      disabled={busy === d.id || editing.name.trim().length < 2}
                      onClick={() =>
                        void run(
                          d.id,
                          async () => {
                            await api.updateDepartment(d.id, { name: editing.name.trim() });
                            setEditing(null);
                          },
                          'Could not rename it.',
                        )
                      }
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !py-1.5 !text-[13px]"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block font-display text-[16px] font-bold text-ink">
                        {d.name}
                      </span>
                      {/* What retiring it would strand, said before they press
                          the button rather than after. The test count is not
                          repeated here — the tests are listed underneath. */}
                      <span className="block text-[12px] text-ink-40">
                        {d.orderCount} {d.orderCount === 1 ? 'order' : 'orders'} ever sent here
                      </span>
                    </span>

                    <button
                      type="button"
                      className="btn-ghost !py-1.5 !text-[13px]"
                      onClick={() => setEditing({ id: d.id, name: d.name })}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !py-1.5 !text-[13px]"
                      disabled={busy === d.id}
                      onClick={() =>
                        void run(
                          d.id,
                          () => api.updateDepartment(d.id, { isActive: false }),
                          'Could not retire it.',
                        )
                      }
                    >
                      Retire
                    </button>
                  </>
                )}
              </div>

              {/* Who covers it. Read-only on purpose: the assignment is made
                  when the login is created, and two places to change one thing
                  is how they stop agreeing. */}
              <p className="border-b border-ink/6 px-5 py-2.5 text-[12.5px] text-ink-60">
                <span className="mono-label mr-2">Staff</span>
                {d.staff.length === 0 ? (
                  <>
                    Nobody works here yet.{' '}
                    <Link href="/settings/users" className="underline">
                      Add a diagnostics login
                    </Link>
                    .
                  </>
                ) : (
                  d.staff.map((s) => s.fullName).join(', ')
                )}
              </p>

              {/* What it does, and what it costs. */}
              <div className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="mono-label flex-1">
                    Tests · {liveTests.length}
                    {d.tests.length > liveTests.length &&
                      ` · ${d.tests.length - liveTests.length} off`}
                  </p>
                  {!adding && (
                    <button
                      type="button"
                      className="btn-secondary !py-1.5 !text-[13px]"
                      onClick={() => setNewTest({ departmentId: d.id, name: '', rupees: '' })}
                    >
                      <IconCheck size={14} />
                      Add a test
                    </button>
                  )}
                </div>

                {d.tests.length === 0 && !adding && (
                  <p className="field-hint mt-1">
                    Nothing is priced here yet, so nothing can be ordered from this room.
                  </p>
                )}

                {d.tests.length > 0 && (
                  <ul className="mt-2 divide-y divide-ink/6">
                    {d.tests.map((t) => {
                      const isEditing = testDraft?.id === t.id;

                      return (
                        <li
                          key={t.id}
                          className={`flex flex-wrap items-center gap-2 py-2 ${
                            t.isActive ? '' : 'opacity-60'
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13.5px] font-semibold text-ink">
                              {t.name}
                              {!t.isActive && (
                                <span className="ml-2 text-[11.5px] font-normal text-ink-40">
                                  switched off
                                </span>
                              )}
                            </span>
                            <span className="block font-mono text-[11.5px] text-ink-40">
                              {t.code}
                            </span>
                          </span>

                          {isEditing ? (
                            <>
                              <input
                                autoFocus
                                className="field-input min-w-[160px] flex-1 !py-1.5"
                                value={testDraft.name}
                                onChange={(e) =>
                                  setTestDraft({ ...testDraft, name: e.target.value })
                                }
                                maxLength={120}
                                aria-label={`Name of ${t.name}`}
                              />
                              <input
                                className="field-input max-w-[110px] font-mono !py-1.5"
                                value={testDraft.rupees}
                                onChange={(e) =>
                                  setTestDraft({ ...testDraft, rupees: e.target.value })
                                }
                                inputMode="decimal"
                                aria-label={`Price for ${t.name} in rupees`}
                              />
                              <button
                                type="button"
                                className="btn-primary !py-1.5 !text-[13px]"
                                disabled={busy === t.id || testDraft.name.trim().length < 2}
                                onClick={() => void saveTest(t)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="btn-ghost !py-1.5 !text-[13px]"
                                onClick={() => setTestDraft(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="font-mono text-[13.5px] tabular-nums text-ink">
                                {formatPaise(t.pricePaise)}
                              </span>
                              <button
                                type="button"
                                className="btn-ghost !py-1.5 !text-[13px]"
                                onClick={() =>
                                  setTestDraft({
                                    id: t.id,
                                    name: t.name,
                                    rupees: (t.pricePaise / 100).toFixed(2),
                                  })
                                }
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn-ghost !py-1.5 !text-[13px]"
                                disabled={busy === `off-${t.id}`}
                                onClick={() =>
                                  void run(
                                    `off-${t.id}`,
                                    () => api.setServiceActive(t.id, !t.isActive),
                                    'Could not change that test.',
                                  )
                                }
                              >
                                {t.isActive ? 'Switch off' : 'Switch on'}
                              </button>
                              <button
                                type="button"
                                className="btn-ghost !py-1.5 !text-[13px] !text-coral-text"
                                disabled={busy === `delete-${t.id}`}
                                onClick={() => void deleteTest(t)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {/* A test is a name and a price. No code, no category: the
                    server generates the one and already knows the other. */}
                {adding && (
                  <div className="mt-3 flex flex-wrap items-end gap-2 rounded-panel bg-bg-soft p-3">
                    <label className="min-w-[180px] flex-1">
                      <span className="field-label">Test name</span>
                      <input
                        autoFocus
                        className="field-input"
                        value={newTest.name}
                        onChange={(e) => setNewTest({ ...newTest, name: e.target.value })}
                        placeholder="X-ray, knee"
                        maxLength={120}
                      />
                    </label>
                    <label className="max-w-[130px]">
                      <span className="field-label">Price ₹</span>
                      <input
                        className="field-input font-mono"
                        value={newTest.rupees}
                        onChange={(e) => setNewTest({ ...newTest, rupees: e.target.value })}
                        inputMode="decimal"
                        placeholder="500"
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={
                        busy === `add-test-${d.id}` ||
                        newTest.name.trim().length < 2 ||
                        newTest.rupees.trim() === ''
                      }
                      onClick={() => void addTest()}
                    >
                      {busy === `add-test-${d.id}` ? 'Saving…' : 'Add it'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !text-[13px]"
                      onClick={() => setNewTest(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </section>
          );
        })
      )}

      {/*
        TESTS IN NO ROOM.

        A test is only orderable if its service names a department, so these can
        be billed and never ordered — the oldest shape of the bug this screen
        exists to end. Shown only when there are some, with the one thing worth
        doing about them: say which room does it.
      */}
      {orphans.length > 0 && (
        <section className="card overflow-hidden border-amber/40">
          <div className="border-b border-ink/8 px-5 py-3">
            <p className="mono-label">Not in any department</p>
            <p className="field-hint">
              These are priced but cannot be ordered. A test is only orderable from the room that
              does it. Say which room, or switch it off.
            </p>
          </div>
          <ul className="divide-y divide-ink/6">
            {orphans.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-5 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold text-ink">{t.name}</span>
                  <span className="block font-mono text-[11.5px] text-ink-40">{t.code}</span>
                </span>
                <span className="font-mono text-[13.5px] tabular-nums text-ink">
                  {formatPaise(t.pricePaise)}
                </span>
                <select
                  className="field-input max-w-[180px] !py-1.5"
                  value=""
                  disabled={busy === `move-${t.id}` || active.length === 0}
                  onChange={(e) => {
                    if (e.target.value) void moveTest(t, e.target.value);
                  }}
                  aria-label={`Which department does ${t.name}`}
                >
                  <option value="">Move to…</option>
                  {active.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-ghost !py-1.5 !text-[13px]"
                  disabled={busy === `off-${t.id}`}
                  onClick={() =>
                    void run(
                      `off-${t.id}`,
                      () => api.setServiceActive(t.id, !t.isActive),
                      'Could not change that test.',
                    )
                  }
                >
                  {t.isActive ? 'Switch off' : 'Switch on'}
                </button>
                <button
                  type="button"
                  className="btn-ghost !py-1.5 !text-[13px] !text-coral-text"
                  disabled={busy === `delete-${t.id}`}
                  onClick={() => void deleteTest(t)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Only when there is something in it. An empty "Retired" heading is a
          question nobody asked. */}
      {retired.length > 0 && (
        <section className="card overflow-hidden">
          <div className="border-b border-ink/8 px-5 py-3">
            <p className="mono-label">Retired</p>
            <p className="field-hint">
              Not offered when ordering a test. Still named on everything already sent there.
            </p>
          </div>
          <ul className="divide-y divide-ink/8">
            {retired.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="min-w-0 flex-1 text-[14px] text-ink-60">
                  {d.name}
                  <span className="ml-2 text-[12px] text-ink-40">
                    {d.tests.length} {d.tests.length === 1 ? 'test' : 'tests'} priced
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-secondary !py-1.5 !text-[13px]"
                  disabled={busy === d.id}
                  onClick={() =>
                    void run(
                      d.id,
                      () => api.updateDepartment(d.id, { isActive: true }),
                      'Could not bring it back.',
                    )
                  }
                >
                  <IconCheck size={14} />
                  Bring back
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
