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

-- Rate limits: fixed-window counters, one row per bucket.
--
-- Until 2026-10-15 nothing limited /api/v1 or the login. In Postgres because
-- the app runs on Vercel, where a counter in a function's memory counts one
-- request and is gone. One upsert per request: a bucket in its window adds
-- one, a bucket from an older window restarts at 1, so the table holds one
-- row per key, per address and per email+address tried, never one per
-- request. Buckets are HMACs, not emails. The limits, and why they are
-- generous, are in src/lib/api/rateLimit.ts; rows a day old are pruned there.

CREATE TABLE IF NOT EXISTS "rate_limits" (
  "bucket"       text PRIMARY KEY,
  "window_start" timestamp with time zone NOT NULL,
  "count"        integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "rate_limits_window_idx" ON "rate_limits" ("window_start");

-- The /api/v1 request journal.
--
-- Nothing recorded who called the client API or what it answered, so a key
-- being guessed, a revoked key still polling, or an app pulling every second
-- were invisible. One row per request, answered or refused: the key (null
-- when none was accepted — those are the rows worth reading), the path, the
-- status, the address, the time it took. Append-only; rows past 90 days are
-- pruned by src/lib/api/rateLimit.ts.
--
--   select at, ip, path, status from api_request_log
--   where key_id is null order by at desc limit 50;

CREATE TABLE IF NOT EXISTS "api_request_log" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "at"          timestamp with time zone NOT NULL DEFAULT now(),
  "key_id"      uuid REFERENCES "client_api_keys" ("id") ON DELETE SET NULL,
  "path"        text NOT NULL,
  "status"      integer NOT NULL,
  "ip"          text,
  "duration_ms" integer
);

CREATE INDEX IF NOT EXISTS "api_request_log_at_idx" ON "api_request_log" ("at");
CREATE INDEX IF NOT EXISTS "api_request_log_key_at_idx" ON "api_request_log" ("key_id", "at");
