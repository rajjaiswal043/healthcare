-- The rules that make CUSTOM a type rather than a hole.
--
-- `value` is meaningless for a discount whose amount is typed at the desk, and
-- the honest representation of a meaningless number is NULL rather than 0 — 0
-- already means "a discount worth nothing", which is a different thing and one
-- the CHECK below still refuses.

-- Nullable for CUSTOM's sake. The per-type CHECK keeps it mandatory for the two
-- types that still need it, so nothing is loosened for them.
ALTER TABLE "promotion" ALTER COLUMN "value" DROP NOT NULL;

-- Rewritten rather than extended: the constraint enumerates every type, which is
-- what makes an unhandled type impossible to insert. Adding a branch is the only
-- correct way to grow it.
ALTER TABLE "promotion" DROP CONSTRAINT promotion_value_within_bounds;

ALTER TABLE "promotion" ADD CONSTRAINT promotion_value_within_bounds CHECK (
  ("type" = 'PERCENTAGE' AND "value" BETWEEN 1 AND 100)
  OR
  ("type" = 'FLAT' AND "value" BETWEEN 1 AND 100000000)
  OR
  -- Both columns absent, enforced here rather than only hidden by the form. A
  -- cap on a promotion whose amount is typed at the desk would be a rule the UI
  -- never shows and the person typing cannot see — it would silently shrink the
  -- amount they entered, which is the one thing a manual amount must not do.
  ("type" = 'CUSTOM' AND "value" IS NULL AND "max_discount_paise" IS NULL)
);

COMMENT ON COLUMN "promotion"."value" IS
  '1-100 for PERCENTAGE, paise for FLAT, NULL for CUSTOM (amount is entered at billing).';
