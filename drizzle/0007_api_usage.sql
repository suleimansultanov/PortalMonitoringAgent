-- What a metered API was asked, and what it cost.
--
-- Stream.Estate V1 bills per item returned, on the client's card: 15 000 a
-- month on his plan and EUR 0.003 each beyond it. The meter in
-- src/lib/portals/streamV1.ts refuses a paid request before sending it when
-- the period's total plus the page would pass the cap — and the period's
-- total has to survive the nightly runner, whose disk does not. So: one row
-- per request, appended before the next one is sent, summed per period.
--
-- Append-only, like the event log. A row is never updated: a request that
-- failed in transit is written with `uncertain = true` and the page size as
-- its cost, because it may have been billed and nobody will ever know.
-- Their dashboard is the bill; this table is how we stay under it.

CREATE TABLE IF NOT EXISTS "api_usage" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The source the key belongs to: "stream-estate-v1".
  "source_key"  text NOT NULL,
  "at"          timestamp with time zone NOT NULL DEFAULT now(),
  -- A page (paid) or a count (free).
  "paid"        boolean NOT NULL,
  -- The query, canonical. Never the key.
  "query"       text NOT NULL,
  "items"       integer NOT NULL DEFAULT 0,
  "uncertain"   boolean NOT NULL DEFAULT false,
  "note"        text
);

CREATE INDEX IF NOT EXISTS "api_usage_source_at_idx" ON "api_usage" ("source_key", "at");
