-- The meter reserves before it sends.
--
-- Until 2026-10-15 a paid page was written to the ledger AFTER the response
-- came back. A crash between the two lost the page from the count, and two
-- processes (the nightly runner and the Mac) could both read the total and
-- both send. Now a `reserve` row of the page size goes in BEFORE the request
-- and a `settle` row with the difference after it; a request that never
-- settles stays counted at the worst case. `request_id` pairs the two.
--
-- Rows written before this migration have no kind: they are settled history.

ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "request_id" text;

CREATE INDEX IF NOT EXISTS "api_usage_request_idx" ON "api_usage" ("request_id") WHERE "request_id" IS NOT NULL;

-- Where a changes-only source stands, per commune.
--
-- Stream.Estate V1 reads a commune's stock once and then only what changed
-- since its last complete walk of that commune. The watermark has to be per
-- commune: a pass stopped at the cap after four communes must not leave the
-- other eight reading "changes" to a stock they never had, nor re-paying the
-- four. `state` is the adapter's own JSON ({ stockedAt, stockCursor,
-- changesSince }); the runner does not read it.

CREATE TABLE IF NOT EXISTS "source_commune_state" (
  "source_key"    text NOT NULL,
  "commune_insee" text NOT NULL,
  "state"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("source_key", "commune_insee")
);
