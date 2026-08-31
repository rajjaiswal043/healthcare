-- =============================================================================
-- DROPPING A DEFAULT PRISMA DOES NOT KNOW ABOUT
--
-- 20260827090000 gave `diagnostic_order.updated_at` a `DEFAULT now()`, which
-- reads as obviously correct and is exactly one thing too many: the column is
-- `@updatedAt` in the schema, and Prisma maintains it from the client on every
-- write without emitting a database default. `migrate:check` therefore reported
-- drift — the same column, described differently.
--
-- Nothing about behaviour changes. Every insert goes through Prisma, which
-- supplies the value; the default was never reached. What changes is that the
-- schema and the migrations agree again, which is the only way a drift check
-- stays worth reading.
-- =============================================================================

ALTER TABLE "diagnostic_order" ALTER COLUMN "updated_at" DROP DEFAULT;
