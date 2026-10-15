-- The Listings screen's order, with a tiebreaker.
--
-- The screen pages with OFFSET over `first_listed_at DESC`, which is not
-- unique: a backfill stamps hundreds of properties in one pass. Postgres may
-- return tied rows in a different order on every query, so page two repeated
-- some of page one and skipped others. The query now orders by
-- (first_listed_at DESC, id DESC), a total order, and this index serves it
-- for the active rows the screen shows. No row had a null first_listed_at on
-- 2026-10-15.

CREATE INDEX IF NOT EXISTS "properties_active_listed_idx"
  ON "properties" ("first_listed_at" DESC, "id" DESC)
  WHERE "status" = 'active';
