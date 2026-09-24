'use client';

import { useState } from 'react';
import type { Invoice, Promotion } from '@/lib/api';
import { formatPaise, parseRupeesToPaise } from '@/lib/format';
import { Banner } from './banner';
import { IconX } from './icons';

/**
 * The class strings for each layout, written out whole so Tailwind finds them.
 *
 * `grid` is the Finance Desk's, unchanged — see the long note inside the panel
 * for why every track is fixed. `stacked` keeps the same rules (top-aligned,
 * the hint reserved so the row cannot jump) in two columns from `sm` up, which
 * is where the dialog stops being full-screen and settles at 512px: Promotion
 * beside Authorised by, Amount off beside Apply.
 */
const LAYOUTS = {
  grid: {
    row: 'grid grid-cols-1 items-start gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto]',
    hint: 'field-hint block md:min-h-[2lh]',
    applyLabel: 'field-label invisible hidden md:block',
  },
  stacked: {
    row: 'grid grid-cols-1 items-start gap-2 sm:grid-cols-2',
    hint: 'field-hint block sm:min-h-[2lh]',
    applyLabel: 'field-label invisible hidden sm:block',
  },
} as const;

/**
 * Applying a discount the administrator already set up.
 *
 * The approver is mandatory and is a person, not free text. Without it the
 * record shows the finance person gave away money and shows nothing about the
 * instruction they were following — and the person most exposed by that gap is
 * the finance person, which is why the field cannot be skipped.
 */
export function PromotionPanel({
  invoice,
  promotions,
  approvers,
  approversBlocked,
  busy,
  onApply,
  onUndo,
  layout = 'grid',
}: {
  invoice: Invoice;
  promotions: Promotion[];
  approvers: Array<{ id: string; fullName: string }>;
  approversBlocked: boolean;
  busy: boolean;
  onApply: (input: {
    promotionId: string;
    authorisedByUserId: string;
    customDiscountPaise?: number;
  }) => void;
  onUndo: () => void;
  /**
   * `grid` — the Finance Desk's single row of four fixed tracks, for a full
   * page width. `stacked` — two columns, for a narrow container such as the
   * 512px payment dialog, where four tracks would leave each dropdown about
   * 110px and cut the promotion codes off.
   *
   * Chosen by the caller rather than measured: the breakpoints below follow the
   * SCREEN, not the box the panel sits in, so a narrow box on a wide screen
   * cannot tell it is narrow.
   */
  layout?: 'grid' | 'stacked';
}) {
  const skin = LAYOUTS[layout];
  const [promotionId, setPromotionId] = useState('');
  const [authorisedByUserId, setAuthorisedByUserId] = useState('');
  /** Rupees as typed, for a CUSTOM promotion. Empty until somebody enters one. */
  const [customRupees, setCustomRupees] = useState('');

  const selected = promotions.find((p) => p.id === promotionId) ?? null;
  const isCustom = selected?.type === 'CUSTOM';

  /**
   * What this discount is worth, shown before it is applied.
   *
   * For PERCENTAGE and FLAT this repeats the server's arithmetic, which is a
   * duplicate and is worth it: the desk is about to reduce a bill and should see
   * by how much first. It is rounded the same way (`Math.round` on basis points)
   * so the preview and the invoice cannot disagree by a paisa. The SERVER
   * remains the authority — this figure is never sent for those two types.
   *
   * `subtotalPaise` rather than `totalPaise` because a discount applies to the
   * charges, which is what the server discounts too.
   */
  const previewPaise = (() => {
    if (!selected || selected.type === 'CUSTOM') return null;

    const raw =
      selected.type === 'PERCENTAGE'
        ? Math.round((invoice.subtotalPaise * ((selected.value ?? 0) * 100)) / 10000)
        : (selected.value ?? 0);

    const capped =
      selected.maxDiscountPaise === null ? raw : Math.min(raw, selected.maxDiscountPaise);
    return Math.max(0, Math.min(capped, invoice.subtotalPaise));
  })();

  const customPaise = parseRupeesToPaise(customRupees);

  /**
   * The cap the desk sees. The server refuses anything above the bill with a
   * message naming both figures — this only keeps them from getting there.
   */
  const customTooLarge = customPaise !== null && customPaise > invoice.subtotalPaise;
  const customReady = isCustom ? customPaise !== null && customPaise >= 1 && !customTooLarge : true;

  /**
   * A promotion is on the bill — the application row, not the money.
   *
   * `discountPaise` is the wrong question: it moves whenever charges change,
   * and while declines were written as line discounts this widget offered to
   * "take off" a discount that had never been applied.
   */
  if (invoice.activePromotionApplicationId) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-panel border border-clinical/25 bg-clinical-tint px-4 py-3">
        <p className="text-[13.5px] text-clinical-text">
          <span className="font-semibold">{formatPaise(invoice.discountPaise)}</span> discount
          applied. The fee still reads {formatPaise(invoice.subtotalPaise)}.
        </p>
        <button type="button" className="btn-ghost text-[13px]" disabled={busy} onClick={onUndo}>
          <IconX size={14} />
          Take it off
        </button>
      </div>
    );
  }

  if (promotions.length === 0) {
    return (
      <p className="field-hint mt-4">
        No discounts are set up, or none is valid today. An administrator adds them in settings.
      </p>
    );
  }

  return (
    <div className="mt-4 rounded-panel border border-ink/10 bg-bg-soft p-3.5">
      <p className="mono-label mb-2.5">Discount</p>

      {approversBlocked ? (
        <Banner tone="error">
          A discount needs the person who authorised it named, and the list of staff could not be
          loaded. Try again, or ask an administrator to apply it.
        </Banner>
      ) : (
        /* A grid with FIXED tracks, not a wrapping flex row — the row used to
           move every time the state changed, and each of these is one of the
           three reasons it did:

           1. The Amount column was sized by its content. `min-w-[150px]` with
              no basis made its width whatever its widest line was, and that
              line was the hint underneath — "Pick a discount first." /
              "Worked out from the promotion." / "Up to ₹600.00." — a different
              length in every state. The two `flex-1` columns absorbed the
              difference, so picking a promotion resized all three fields.
              Measured: the Amount input went 286 → 346 → 275px wide and the
              Authorised-by dropdown slid 38px sideways.

           2. `flex-wrap` turned that into a line break. When the Amount
              column was at its widest, Apply no longer fitted and dropped to a
              second line — a full-row jump, the worst of the three.

           3. `items-end` bottom-aligned the COLUMNS, and only the Amount
              column has a hint beneath it, so its input sat one hint-line
              higher than the two dropdowns (27px) in every state.

           So: the two dropdowns share the free space equally and can never be
           pushed by their text — `minmax(0, 1fr)` rather than `1fr`, because a
           plain `1fr` track has a minimum of the select's min-content, which is
           its LONGEST OPTION, and a long promotion code would have widened it.
           The Amount column is a fixed 10rem whatever it says. The row is
           aligned by its top, so the labels line up and the hint hangs below
           the input instead of lifting it. Below `md` it stacks, one field per
           line, which is stable by construction. */
        <div className={skin.row}>
          <label className="min-w-0">
            <span className="field-label">Promotion</span>
            <select
              className="field-input"
              value={promotionId}
              onChange={(e) => {
                setPromotionId(e.target.value);
                // A figure typed against one promotion must not survive into
                // another, where it would be either wrong or refused.
                setCustomRupees('');
              }}
            >
              <option value="">None</option>
              {promotions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} —{' '}
                  {p.type === 'CUSTOM'
                    ? 'custom amount'
                    : p.type === 'PERCENTAGE'
                      ? `${p.value}%`
                      : formatPaise(p.value ?? 0)}
                </option>
              ))}
            </select>
          </label>

          <label className="min-w-0">
            <span className="field-label">Authorised by</span>
            <select
              className="field-input"
              value={authorisedByUserId}
              onChange={(e) => setAuthorisedByUserId(e.target.value)}
            >
              <option value="">Who approved it?</option>
              {approvers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          </label>

          {/* THE AMOUNT — one box, two behaviours.
              Locked for a promotion that carries its own value, because the
              figure is the administrator's and the desk may not overrule it
              here. Editable for CUSTOM, because there is nothing to overrule:
              the amount does not exist until somebody types it. Keeping it as
              one box rather than two means the desk always looks in the same
              place to find out what this bill is losing. */}
          <label className="min-w-0">
            <span className="field-label">Amount off</span>
            <input
              className="field-input font-mono tabular-nums"
              inputMode="decimal"
              readOnly={!isCustom}
              disabled={!promotionId}
              aria-label={isCustom ? 'Discount amount in rupees' : 'Discount amount, calculated'}
              value={
                isCustom
                  ? customRupees
                  : previewPaise === null
                    ? ''
                    : (previewPaise / 100).toFixed(2)
              }
              onChange={(e) => setCustomRupees(e.target.value)}
              placeholder={isCustom ? '0.00' : ''}
            />
            {/* Two lines reserved, whichever sentence is showing. In a fixed
                10rem column the longest of the three wraps and the shortest
                does not, and without the reservation the row — and everything
                under it — grew and shrank by a line as the state changed. */}
            <span className={skin.hint}>
              {!promotionId
                ? 'Pick a discount first.'
                : isCustom
                  ? `Up to ${formatPaise(invoice.subtotalPaise)}.`
                  : 'Worked out from the promotion.'}
            </span>
          </label>

          {/* The button sits under an invisible copy of a field label, so on
              a top-aligned row it lands on the same line as the three controls
              rather than on the labels above them. Hidden when stacked, where
              there is no row to line up with. */}
          <div>
            <span aria-hidden="true" className={skin.applyLabel}>
              Apply
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !promotionId || !authorisedByUserId || !customReady}
              onClick={() =>
                onApply({
                  promotionId,
                  authorisedByUserId,
                  // Sent for CUSTOM and for nothing else — the server refuses it
                  // on a promotion that carries its own value.
                  ...(isCustom && customPaise !== null ? { customDiscountPaise: customPaise } : {}),
                })
              }
            >
              Apply
            </button>
          </div>
        </div>
      )}

      {/* Said before the request rather than after the refusal. The server
          refuses this too, naming both figures — this is so the desk does not
          have to be refused to find out. */}
      {customTooLarge && (
        <p className="field-hint mt-2 text-coral-text">
          That is more than the bill. This bill is {formatPaise(invoice.subtotalPaise)}.
        </p>
      )}

      <p className="field-hint">
        The fee stays as it is and the discount shows as a reduction, so the clinic can always say
        how much it gave away.
      </p>
    </div>
  );
}
