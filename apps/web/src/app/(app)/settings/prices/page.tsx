'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError, type PricedService } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/format';
import { IconAlert, IconCheck, IconSearch, IconX } from '@/components/icons';

/**
 * What the clinic charges for — FR-PRC-01.
 *
 * THE WHOLE LIST, ON ONE SCREEN. An administrator pricing a clinic is comparing
 * forty numbers against each other, not editing one in isolation, so nothing
 * here paginates and nothing hides behind a modal. Search narrows; it does not
 * navigate.
 *
 * MONEY IS INTEGER PAISE UNDER THE HOOD. Rupees exist in exactly two places on
 * this page: the text in an input, and the text on the screen. `parseRupeesToPaise`
 * converts on the way in and `formatPaise` on the way out — a float never
 * reaches the API and never reaches the column.
 *
 * WHAT THIS SCREEN CANNOT DO, ON PURPOSE: change a bill that has already been
 * raised. Invoice lines copy the name and the price at the moment of billing, so
 * a price put up today leaves every past invoice — and every reprint of its
 * receipt — reading what was actually charged. That is FR-PRC-03, and it is a
 * property of the data model rather than of this page; the page simply has no
 * path to an invoice line.
 */

const CATEGORIES = ['CONSULTATION', 'PROCEDURE', 'DIAGNOSTIC', 'CONSUMABLE', 'OTHER'] as const;

const CATEGORY_LABEL: Record<string, string> = {
  CONSULTATION: 'Consultations',
  PROCEDURE: 'Procedures',
  DIAGNOSTIC: 'Diagnostics',
  CONSUMABLE: 'Consumables',
  OTHER: 'Other',
};

interface Draft {
  name: string;
  category: string;
  departmentId: string;
  rupees: string;
  taxPercent: string;
}

export default function PricesPage() {
  const [services, setServices] = useState<PricedService[]>([]);
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(true);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState({
    code: '',
    name: '',
    category: 'CONSULTATION',
    departmentId: '',
    rupees: '',
    taxPercent: '0',
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.priceList();
      setServices(data.services);
      setDepartments(data.departments);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.error.message : 'Could not load the prices.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Grouped, then filtered — never the other way round.
   *
   * A search that empties a category should still leave the heading out rather
   * than showing "Procedures" above nothing, so the filter runs first and the
   * grouping is built from what survived.
   */
  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const matching = services.filter((s) => {
      if (!showInactive && !s.isActive) return false;
      if (needle === '') return true;
      return (
        s.name.toLowerCase().includes(needle) ||
        s.code.toLowerCase().includes(needle) ||
        (s.department?.name.toLowerCase().includes(needle) ?? false)
      );
    });

    return CATEGORIES.map((category) => ({
      category,
      rows: matching.filter((s) => s.category === category),
    })).filter((g) => g.rows.length > 0);
  }, [services, query, showInactive]);

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

  function startEditing(service: PricedService) {
    setEditing(service.id);
    setDraft({
      name: service.name,
      category: service.category,
      departmentId: service.department?.id ?? '',
      rupees: (service.pricePaise / 100).toFixed(2),
      taxPercent: String(service.taxRateBasisPoints / 100),
    });
  }

  async function save(service: PricedService) {
    if (!draft) return;

    const pricePaise = parseRupeesToPaise(draft.rupees);
    if (pricePaise === null) {
      setError('That price is not a number.');
      return;
    }

    const taxPercent = Number(draft.taxPercent);
    if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
      setError('A tax rate is between 0 and 100.');
      return;
    }

    await run(
      service.id,
      async () => {
        await api.upsertService({
          // The code identifies the row for the upsert and is never edited — it
          // is what past reports group by.
          code: service.code,
          name: draft.name.trim(),
          category: draft.category,
          pricePaise,
          taxRateBasisPoints: Math.round(taxPercent * 100),
          departmentId: draft.departmentId === '' ? null : draft.departmentId,
          // `isActive` is deliberately NOT sent. Editing a price must not
          // revive a service somebody withdrew — that was the bug.
        });
        setEditing(null);
        setDraft(null);
      },
      'Could not save that price.',
    );
  }

  async function addService() {
    const pricePaise = parseRupeesToPaise(newRow.rupees);
    if (pricePaise === null) {
      setError('That price is not a number.');
      return;
    }

    const taxPercent = Number(newRow.taxPercent || '0');
    if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
      setError('A tax rate is between 0 and 100.');
      return;
    }

    await run(
      'new',
      async () => {
        await api.upsertService({
          code: newRow.code.trim().toUpperCase(),
          name: newRow.name.trim(),
          category: newRow.category,
          pricePaise,
          taxRateBasisPoints: Math.round(taxPercent * 100),
          departmentId: newRow.departmentId === '' ? null : newRow.departmentId,
        });
        setAdding(false);
        setNewRow({
          code: '',
          name: '',
          category: 'CONSULTATION',
          departmentId: '',
          rupees: '',
          taxPercent: '0',
        });
      },
      'Could not add that service.',
    );
  }

  const activeCount = services.filter((s) => s.isActive).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">
            What the clinic <em className="accent-words">charges</em>
          </h1>
          <p className="mt-1 max-w-[62ch] text-[14px] text-ink-60">
            Every priced item, in one list. A price change applies to bills raised from now on —
            everything already billed keeps the price it was billed at.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setAdding((v) => !v)}>
          <IconCheck size={16} />
          Add a service
        </button>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-card border border-coral/30 bg-coral/8 p-3.5 text-[13.5px] text-coral-text"
        >
          <span className="mt-0.5 shrink-0">
            <IconAlert size={16} />
          </span>
          <span>{error}</span>
        </div>
      )}

      {adding && (
        <section className="card p-5">
          <p className="mono-label mb-3">New service</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label>
              <span className="field-label">Code</span>
              <input
                className="field-input font-mono"
                value={newRow.code}
                onChange={(e) => setNewRow({ ...newRow, code: e.target.value })}
                placeholder="XRAY-KNEE"
                autoFocus
              />
              <span className="field-hint">Never changes. Reports group by it.</span>
            </label>
            <label>
              <span className="field-label">Name on the bill</span>
              <input
                className="field-input"
                value={newRow.name}
                onChange={(e) => setNewRow({ ...newRow, name: e.target.value })}
                placeholder="X-ray, knee"
              />
            </label>
            <label>
              <span className="field-label">Category</span>
              <select
                className="field-input"
                value={newRow.category}
                onChange={(e) => setNewRow({ ...newRow, category: e.target.value })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Department</span>
              <select
                className="field-input"
                value={newRow.departmentId}
                onChange={(e) => setNewRow({ ...newRow, departmentId: e.target.value })}
              >
                <option value="">None</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Price in rupees</span>
              <input
                className="field-input font-mono"
                value={newRow.rupees}
                onChange={(e) => setNewRow({ ...newRow, rupees: e.target.value })}
                inputMode="decimal"
                placeholder="500"
              />
            </label>
            <label>
              <span className="field-label">Tax %</span>
              <input
                className="field-input font-mono"
                value={newRow.taxPercent}
                onChange={(e) => setNewRow({ ...newRow, taxPercent: e.target.value })}
                inputMode="decimal"
              />
              <span className="field-hint">
                Zero for most clinics — clinical care is GST-exempt.
              </span>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy === 'new' || !newRow.code.trim() || !newRow.name.trim()}
              onClick={() => void addService()}
            >
              {busy === 'new' ? 'Saving…' : 'Add it'}
            </button>
            <button
              type="button"
              className="btn-ghost text-[13px]"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex min-w-[240px] flex-1 items-center">
          <span className="pointer-events-none absolute left-3.5 text-ink-20">
            <IconSearch size={16} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="field-input-icon"
            placeholder="Search by name, code or department"
            autoComplete="off"
          />
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink-60">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show switched-off
        </label>
        <span className="mono-label">
          {activeCount} priced · {services.length - activeCount} off
        </span>
      </div>

      {services.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="font-display text-[17px] font-bold">Nothing is priced yet</p>
          <p className="mx-auto mt-1.5 max-w-[52ch] text-[13.5px] text-ink-60">
            Until something is priced, no bill is raised and the front desk lets every patient
            through. That is deliberate — a clinic can use the software before its pricing is
            settled — but the finance desk has nothing to charge for.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map((group) => (
            <section key={group.category} className="card overflow-hidden">
              <div className="border-b border-ink/8 px-5 py-2.5">
                <p className="mono-label">
                  {CATEGORY_LABEL[group.category]} · {group.rows.length}
                </p>
              </div>

              <ul className="divide-y divide-ink/6">
                {group.rows.map((service) => {
                  const isEditing = editing === service.id && draft !== null;

                  return (
                    <li key={service.id} className={service.isActive ? '' : 'bg-bg-soft'}>
                      {isEditing ? (
                        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
                          <label className="lg:col-span-2">
                            <span className="field-label">Name</span>
                            <input
                              className="field-input"
                              value={draft.name}
                              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            />
                          </label>
                          <label>
                            <span className="field-label">Category</span>
                            <select
                              className="field-input"
                              value={draft.category}
                              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                            >
                              {CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {CATEGORY_LABEL[c]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span className="field-label">Department</span>
                            <select
                              className="field-input"
                              value={draft.departmentId}
                              onChange={(e) => setDraft({ ...draft, departmentId: e.target.value })}
                            >
                              <option value="">None</option>
                              {departments.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <label>
                              <span className="field-label">₹</span>
                              <input
                                className="field-input font-mono"
                                value={draft.rupees}
                                onChange={(e) => setDraft({ ...draft, rupees: e.target.value })}
                                inputMode="decimal"
                              />
                            </label>
                            <label>
                              <span className="field-label">Tax %</span>
                              <input
                                className="field-input font-mono"
                                value={draft.taxPercent}
                                onChange={(e) => setDraft({ ...draft, taxPercent: e.target.value })}
                                inputMode="decimal"
                              />
                            </label>
                          </div>

                          <div className="flex items-end gap-2 lg:col-span-5">
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={busy === service.id}
                              onClick={() => void save(service)}
                            >
                              {busy === service.id ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              className="btn-ghost text-[13px]"
                              onClick={() => {
                                setEditing(null);
                                setDraft(null);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14.5px] font-semibold text-ink">
                              {service.name}
                              {!service.isActive && (
                                <span className="mono-label ml-2 !text-ink-40">switched off</span>
                              )}
                            </p>
                            <p className="truncate text-[12.5px] text-ink-40">
                              <span className="font-mono">{service.code}</span>
                              {service.department ? ` · ${service.department.name}` : ''}
                              {service.taxRateBasisPoints > 0
                                ? ` · ${service.taxRateBasisPoints / 100}% tax`
                                : ''}
                            </p>
                          </div>

                          <span className="shrink-0 font-mono text-[15px] font-semibold text-ink tabular-nums">
                            {formatPaise(service.pricePaise)}
                          </span>

                          <div className="flex shrink-0 gap-1">
                            <button
                              type="button"
                              className="btn-ghost text-[13px]"
                              onClick={() => startEditing(service)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn-ghost text-[13px]"
                              disabled={busy === service.id}
                              onClick={() =>
                                void run(
                                  service.id,
                                  () => api.setServiceActive(service.id, !service.isActive),
                                  'Could not change that service.',
                                )
                              }
                            >
                              {service.isActive ? (
                                <>
                                  <IconX size={14} />
                                  Switch off
                                </>
                              ) : (
                                <>
                                  <IconCheck size={14} />
                                  Switch on
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {grouped.length === 0 && (
            <p className="text-[13.5px] text-ink-60">Nothing matches “{query.trim()}”.</p>
          )}
        </div>
      )}

      <p className="max-w-[68ch] text-[12.5px] text-ink-40">
        A service the clinic no longer offers is switched off, never deleted — reporting groups by
        service, and a deleted one makes last month’s figures unexplainable. A doctor’s own
        consultation fee overrides the price here and is set on{' '}
        <span className="text-ink-60">Doctors and hours</span>.
      </p>
    </div>
  );
}
