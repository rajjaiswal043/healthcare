'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError, type Promotion } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/format';
import { IconAlert, IconCheck, IconInfo, IconSearch, IconX } from '@/components/icons';

/**
 * The clinic's discounts — FR-PRO-01.
 *
 * Until now these existed only over the API, which meant a clinic could not set
 * one up without somebody running curl. This is the screen the administrator
 * uses instead.
 *
 * THE RULE THAT SHAPES THIS PAGE: a promotion that has ever been applied can be
 * switched off, but never edited and never deleted. An invoice from March has to
 * keep explaining itself in September, and it explains itself by naming a row
 * that has not moved since. So a used promotion shows no edit button at all —
 * the screen reflects the rule rather than offering an action the API will
 * refuse.
 *
 * MONEY IS INTEGER PAISE UNDER THE HOOD. Rupees exist only in an input's text
 * and in what is printed on screen. A percentage is different — it is a whole
 * number 1 to 100 and never touches paise at all.
 */

const TODAY = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

type Filter = 'all' | 'usable' | 'off';

interface Draft {
  name: string;
  description: string;
  /** Percent (1–100) for PERCENTAGE, rupees for FLAT. */
  value: string;
  capRupees: string;
  validFrom: string;
  validTo: string;
}

function draftFrom(p: Promotion): Draft {
  return {
    name: p.name,
    description: p.description ?? '',
    value:
      p.type === 'CUSTOM'
        ? ''
        : p.type === 'PERCENTAGE'
          ? String(p.value)
          : ((p.value ?? 0) / 100).toFixed(2),
    capRupees: p.maxDiscountPaise === null ? '' : (p.maxDiscountPaise / 100).toFixed(2),
    validFrom: p.validFrom,
    validTo: p.validTo ?? '',
  };
}

/** What a promotion is worth, in words, for the list row. */
function worth(p: Promotion): string {
  /**
   * CUSTOM is worth nothing in particular, and saying so is the honest row.
   *
   * Formatting it like the other two produced "₹0.00 off", which is not a
   * shorthand — it is a false statement about a promotion that will in fact
   * discount whatever the desk types. A row nobody can act on is better than a
   * row that reads correctly and is wrong.
   */
  if (p.type === 'CUSTOM') return 'Amount set at billing';

  const base = p.type === 'PERCENTAGE' ? `${p.value}% off` : `${formatPaise(p.value ?? 0)} off`;
  return p.maxDiscountPaise === null
    ? base
    : `${base}, capped at ${formatPaise(p.maxDiscountPaise)}`;
}

/** Is this promotion usable at the desk right now? */
function isUsableToday(p: Promotion): boolean {
  const today = TODAY();
  if (!p.isActive) return false;
  if (p.validFrom > today) return false;
  if (p.validTo && p.validTo < today) return false;
  return true;
}

function windowLabel(p: Promotion): string {
  const today = TODAY();
  if (p.validFrom > today) return `starts ${p.validFrom}`;
  if (p.validTo && p.validTo < today) return `ended ${p.validTo}`;
  return p.validTo ? `until ${p.validTo}` : 'no end date';
}

export default function PromotionsPage() {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState({
    code: '',
    name: '',
    description: '',
    type: 'PERCENTAGE' as 'PERCENTAGE' | 'FLAT' | 'CUSTOM',
    value: '',
    capRupees: '',
    validFrom: TODAY(),
    validTo: '',
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // No `applicable=true` — the administrator needs to see the expired and
      // switched-off ones too, to bring one back.
      setPromotions((await api.promotions()).promotions);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.error.message : 'Could not load the promotions.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return promotions.filter((p) => {
      if (filter === 'usable' && !isUsableToday(p)) return false;
      if (filter === 'off' && p.isActive) return false;
      if (needle === '') return true;
      return (
        p.code.toLowerCase().includes(needle) ||
        p.name.toLowerCase().includes(needle) ||
        (p.description?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [promotions, query, filter]);

  async function run(key: string, action: () => Promise<unknown>, fallback: string) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      // The API's own sentence, wherever there is one — PROMOTION_IN_USE and
      // CODE_IN_USE both say something the administrator can act on, and a
      // generic "could not save" would throw that away.
      setError(err instanceof ApiRequestError ? err.error.message : fallback);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Percent or rupees → what the API wants.
   *
   * Three returns, not two. `undefined` means "this type has no value" and is
   * what CUSTOM sends; `null` still means "the text is not a number" and is an
   * error. Collapsing the two would make an unparseable percentage look like a
   * custom promotion.
   */
  function valueFor(
    type: 'PERCENTAGE' | 'FLAT' | 'CUSTOM',
    text: string,
  ): number | null | undefined {
    if (type === 'CUSTOM') return undefined;
    if (type === 'FLAT') return parseRupeesToPaise(text);

    const percent = Number(text.trim());
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) return null;
    return percent;
  }

  async function create() {
    const isCustom = newRow.type === 'CUSTOM';
    const value = valueFor(newRow.type, newRow.value);
    if (value === null) {
      setError(
        newRow.type === 'PERCENTAGE'
          ? 'A percentage promotion is a whole number between 1 and 100.'
          : 'That amount is not a number.',
      );
      return;
    }

    // A cap is meaningless on CUSTOM and refused by the server and the database
    // alike, so the form does not carry one even if something was typed before
    // the type was switched.
    let cap: number | undefined;
    if (!isCustom && newRow.capRupees.trim() !== '') {
      const parsed = parseRupeesToPaise(newRow.capRupees);
      if (parsed === null || parsed < 1) {
        setError('A cap is an amount in rupees. Leave it blank for no cap.');
        return;
      }
      cap = parsed;
    }

    if (newRow.validTo && newRow.validTo < newRow.validFrom) {
      setError('A promotion cannot end before it begins.');
      return;
    }

    await run(
      'new',
      async () => {
        await api.createPromotion({
          code: newRow.code.trim().toUpperCase(),
          name: newRow.name.trim(),
          ...(newRow.description.trim() ? { description: newRow.description.trim() } : {}),
          type: newRow.type,
          ...(value === undefined ? {} : { value }),
          ...(cap === undefined ? {} : { maxDiscountPaise: cap }),
          validFrom: newRow.validFrom,
          ...(newRow.validTo ? { validTo: newRow.validTo } : {}),
        });
        setAdding(false);
        setNewRow({
          code: '',
          name: '',
          description: '',
          type: 'PERCENTAGE',
          value: '',
          capRupees: '',
          validFrom: TODAY(),
          validTo: '',
        });
      },
      'Could not create that promotion.',
    );
  }

  async function save(promotion: Promotion) {
    if (!draft) return;

    const value = valueFor(promotion.type, draft.value);
    if (value === null) {
      setError(
        promotion.type === 'PERCENTAGE'
          ? 'A percentage promotion is a whole number between 1 and 100.'
          : 'That amount is not a number.',
      );
      return;
    }

    let cap: number | undefined;
    if (promotion.type !== 'CUSTOM' && draft.capRupees.trim() !== '') {
      const parsed = parseRupeesToPaise(draft.capRupees);
      if (parsed === null || parsed < 1) {
        setError('A cap is an amount in rupees. Leave it blank for no cap.');
        return;
      }
      cap = parsed;
    }

    if (draft.validTo && draft.validTo < draft.validFrom) {
      setError('A promotion cannot end before it begins.');
      return;
    }

    await run(
      promotion.id,
      async () => {
        // `code` and `type` are not sent: the API refuses to change either, and
        // offering the field would be offering something that cannot happen.
        await api.updatePromotion(promotion.id, {
          name: draft.name.trim(),
          description: draft.description.trim(),
          ...(value === undefined ? {} : { value }),
          ...(cap === undefined ? {} : { maxDiscountPaise: cap }),
          validFrom: draft.validFrom,
          ...(draft.validTo ? { validTo: draft.validTo } : {}),
        });
        setEditing(null);
        setDraft(null);
      },
      'Could not save that promotion.',
    );
  }

  const usableCount = promotions.filter(isUsableToday).length;
  const offCount = promotions.filter((p) => !p.isActive).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="mt-2 font-display text-[30px] font-bold">
            Discounts the clinic <em className="accent-words">offers</em>
          </h1>
          <p className="mt-1 max-w-[62ch] text-[14px] text-ink-60">
            Set these up in advance so the finance desk applies a known discount rather than
            inventing one. Every use records who applied it and who authorised it.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setAdding((v) => !v)}>
          <IconCheck size={16} />
          Add a promotion
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
          <p className="mono-label mb-3">New promotion</p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label>
              <span className="field-label">Code</span>
              <input
                className="field-input font-mono"
                value={newRow.code}
                onChange={(e) => setNewRow({ ...newRow, code: e.target.value })}
                placeholder="CAMP50"
                autoFocus
              />
              <span className="field-hint">Typed at the billing desk. Never changes.</span>
            </label>

            <label className="lg:col-span-2">
              <span className="field-label">What it is for</span>
              <input
                className="field-input"
                value={newRow.name}
                onChange={(e) => setNewRow({ ...newRow, name: e.target.value })}
                placeholder="Free eye camp, September"
              />
              <span className="field-hint">Read by whoever approves it later.</span>
            </label>

            <label>
              <span className="field-label">Type</span>
              <select
                className="field-input"
                value={newRow.type}
                onChange={(e) =>
                  setNewRow({
                    ...newRow,
                    type: e.target.value as 'PERCENTAGE' | 'FLAT' | 'CUSTOM',
                    // Percent and rupees are different units, so a half-typed
                    // value must not carry across. The cap is cleared for the
                    // same reason and one more: CUSTOM may not have one at all,
                    // and a figure left in a hidden field would be sent.
                    value: '',
                    capRupees: '',
                  })
                }
              >
                <option value="PERCENTAGE">Percentage off</option>
                <option value="FLAT">Flat amount off</option>
                <option value="CUSTOM">Custom</option>
              </select>
              {newRow.type === 'CUSTOM' && (
                <span className="field-hint">
                  The amount is typed on the bill, each time. For the discount a clinic cannot
                  decide in advance.
                </span>
              )}
            </label>

            {/* Both hidden for CUSTOM: neither is a question that has an answer
                before there is a bill, and the server refuses either if sent. */}
            <label className={newRow.type === 'CUSTOM' ? 'hidden' : undefined}>
              <span className="field-label">
                {newRow.type === 'PERCENTAGE' ? 'Percent off' : 'Rupees off'}
              </span>
              <input
                className="field-input font-mono"
                value={newRow.value}
                onChange={(e) => setNewRow({ ...newRow, value: e.target.value })}
                inputMode="decimal"
                placeholder={newRow.type === 'PERCENTAGE' ? '50' : '200'}
              />
              <span className="field-hint">
                {newRow.type === 'PERCENTAGE'
                  ? '1 to 100. 100 is allowed — that is the “don’t charge this patient” case.'
                  : 'Larger than the bill simply reduces it to zero.'}
              </span>
            </label>

            <label className={newRow.type === 'CUSTOM' ? 'hidden' : undefined}>
              <span className="field-label">Maximum discount</span>
              <input
                className="field-input font-mono"
                value={newRow.capRupees}
                onChange={(e) => setNewRow({ ...newRow, capRupees: e.target.value })}
                inputMode="decimal"
                placeholder="No cap"
              />
              <span className="field-hint">
                Optional, in rupees. So “50% off” cannot become ₹4,000.
              </span>
            </label>

            <label>
              <span className="field-label">Valid from</span>
              <input
                type="date"
                className="field-input font-mono"
                value={newRow.validFrom}
                onChange={(e) => setNewRow({ ...newRow, validFrom: e.target.value })}
              />
            </label>

            <label>
              <span className="field-label">Valid to</span>
              <input
                type="date"
                className="field-input font-mono"
                value={newRow.validTo}
                onChange={(e) => setNewRow({ ...newRow, validTo: e.target.value })}
              />
              <span className="field-hint">Leave blank for no end date.</span>
            </label>

            <label className="sm:col-span-2 lg:col-span-3">
              <span className="field-label">Notes</span>
              <input
                className="field-input"
                value={newRow.description}
                onChange={(e) => setNewRow({ ...newRow, description: e.target.value })}
                placeholder="Optional"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy === 'new' || !newRow.code.trim() || !newRow.name.trim()}
              onClick={() => void create()}
            >
              {busy === 'new' ? 'Saving…' : 'Create it'}
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
            placeholder="Search by code or name"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['all', `All ${promotions.length}`],
              ['usable', `Usable today ${usableCount}`],
              ['off', `Switched off ${offCount}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={[
                'rounded-pill border-[1.5px] px-3 py-1 text-[13px] font-semibold transition-colors',
                filter === key
                  ? 'border-clinical bg-clinical text-white'
                  : 'border-ink/12 bg-white text-ink-60 hover:border-ink/25 hover:text-ink',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {promotions.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="font-display text-[17px] font-bold">No promotions yet</p>
          <p className="mx-auto mt-1.5 max-w-[54ch] text-[13.5px] text-ink-60">
            Until one exists, the finance desk has nothing to apply — and a discount stays what it
            is today, a verbal instruction and a hand-written note.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((promotion) => {
            const isEditing = editing === promotion.id && draft !== null;
            const used = !promotion.editable;

            return (
              <li key={promotion.id} className={`card ${promotion.isActive ? '' : 'opacity-75'}`}>
                {isEditing ? (
                  <div className="p-5">
                    <p className="mono-label mb-3">
                      Editing {promotion.code} ·{' '}
                      {promotion.type === 'PERCENTAGE' ? 'percentage' : 'flat amount'}
                    </p>

                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <label className="lg:col-span-2">
                        <span className="field-label">What it is for</span>
                        <input
                          className="field-input"
                          value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        />
                      </label>

                      <label>
                        <span className="field-label">
                          {promotion.type === 'PERCENTAGE' ? 'Percent off' : 'Rupees off'}
                        </span>
                        <input
                          className="field-input font-mono"
                          value={draft.value}
                          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                          inputMode="decimal"
                        />
                      </label>

                      <label>
                        <span className="field-label">Maximum discount</span>
                        <input
                          className="field-input font-mono"
                          value={draft.capRupees}
                          onChange={(e) => setDraft({ ...draft, capRupees: e.target.value })}
                          inputMode="decimal"
                          placeholder="No cap"
                        />
                      </label>

                      <label>
                        <span className="field-label">Valid from</span>
                        <input
                          type="date"
                          className="field-input font-mono"
                          value={draft.validFrom}
                          onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })}
                        />
                      </label>

                      <label>
                        <span className="field-label">Valid to</span>
                        <input
                          type="date"
                          className="field-input font-mono"
                          value={draft.validTo}
                          onChange={(e) => setDraft({ ...draft, validTo: e.target.value })}
                        />
                      </label>

                      <label className="sm:col-span-2 lg:col-span-3">
                        <span className="field-label">Notes</span>
                        <input
                          className="field-input"
                          value={draft.description}
                          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                        />
                      </label>
                    </div>

                    <p className="field-hint">
                      The code and the type cannot be changed — both would turn this into a
                      different promotion under the same row, and every past report would re-group.
                    </p>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busy === promotion.id}
                        onClick={() => void save(promotion)}
                      >
                        {busy === promotion.id ? 'Saving…' : 'Save'}
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
                  <div className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[15px] font-bold text-ink">
                            {promotion.code}
                          </span>
                          {!promotion.isActive && (
                            <span className="mono-label !text-ink-40">switched off</span>
                          )}
                          {promotion.isActive && !isUsableToday(promotion) && (
                            <span className="mono-label !text-ink-40">out of date</span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[14.5px] text-ink">{promotion.name}</p>
                        {promotion.description && (
                          <p className="mt-0.5 text-[13px] text-ink-40">{promotion.description}</p>
                        )}
                      </div>

                      <div className="text-right">
                        <p className="font-mono text-[15px] font-semibold text-ink tabular-nums">
                          {worth(promotion)}
                        </p>
                        <p className="mono-label mt-0.5">
                          {promotion.validFrom} · {windowLabel(promotion)}
                        </p>
                      </div>
                    </div>

                    {used && (
                      <div className="mt-3 flex items-start gap-2.5 rounded-panel border border-ink/12 bg-bg-soft p-3 text-[13px] text-ink-60">
                        <span className="mt-0.5 shrink-0">
                          <IconInfo size={15} />
                        </span>
                        <span>
                          This promotion has been applied to{' '}
                          <strong>
                            {promotion.timesApplied} bill
                            {promotion.timesApplied === 1 ? '' : 's'}
                          </strong>
                          , so it can only be switched off, not edited. An invoice from March has to
                          keep explaining itself in September.
                        </span>
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {/* No edit button at all for a used promotion — the screen
                          reflects the rule rather than offering an action the
                          API is going to refuse. */}
                      {!used && (
                        <button
                          type="button"
                          className="btn-secondary text-[13px]"
                          onClick={() => {
                            setEditing(promotion.id);
                            setDraft(draftFrom(promotion));
                          }}
                        >
                          Edit
                        </button>
                      )}

                      <button
                        type="button"
                        className="btn-ghost text-[13px]"
                        disabled={busy === promotion.id}
                        onClick={() =>
                          void run(
                            promotion.id,
                            () => api.setPromotionActive(promotion.id, !promotion.isActive),
                            'Could not change that promotion.',
                          )
                        }
                      >
                        {promotion.isActive ? (
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

                      {!used && <span className="mono-label">never used</span>}
                    </div>
                  </div>
                )}
              </li>
            );
          })}

          {shown.length === 0 && (
            <li className="text-[13.5px] text-ink-60">Nothing matches that.</li>
          )}
        </ul>
      )}

      <p className="max-w-[68ch] text-[12.5px] text-ink-40">
        There is no delete. A promotion is switched off and kept, because reporting groups by
        promotion and a removed one makes last month’s discounts unexplainable. Applying a promotion
        is a separate permission from setting one up — the finance desk applies what exists here and
        cannot invent one.
      </p>
    </div>
  );
}
