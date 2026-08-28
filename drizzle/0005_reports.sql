-- Market reports — frozen snapshots, not live queries.
--
-- The Reports screen recomputed everything from current data, so it could only
-- answer "what does the market look like today". "What did June look like" had
-- no answer at all: the rows active in June have since changed price, been
-- delisted, or come back.
--
-- Part of that IS reconstructable from portal_listing_events, which is
-- append-only for exactly this reason. But not all of it — a property first seen
-- in July says nothing about June, and OUR OWN COVERAGE changed underneath. A
-- commune showing fewer listings in June than July usually means "we had not
-- crawled it yet", not "the market was thinner".
--
-- So a report is frozen at generation, WITH the coverage it was generated under
-- recorded beside it. A number that was right when written stays right, and a
-- month-on-month comparison carries the caveat that makes it honest.

CREATE TABLE IF NOT EXISTS "market_reports" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id"             uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,

  -- 'monthly' | 'weekly' | 'adhoc'
  "kind"                  text NOT NULL DEFAULT 'monthly',
  "period_start"          timestamp with time zone NOT NULL,
  "period_end"            timestamp with time zone NOT NULL,
  -- "August 2026". Stored so a list of reports needs no date formatting.
  "label"                 text NOT NULL,

  -- Headline figures, so the index page renders without opening each report.
  "active_count"          integer NOT NULL DEFAULT 0,
  "new_count"             integer NOT NULL DEFAULT 0,
  "delisted_count"        integer NOT NULL DEFAULT 0,
  "price_cut_count"       integer NOT NULL DEFAULT 0,
  "median_price_eur"      bigint,
  "median_price_per_m2"   integer,
  "median_days_on_market" integer,

  "communes"              jsonb NOT NULL DEFAULT '[]'::jsonb,
  "agencies"              jsonb NOT NULL DEFAULT '[]'::jsonb,
  "movements"             jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- What the numbers could NOT see, recorded at generation time: how many
  -- communes had been crawled, which sources were enabled. Without this,
  -- comparing two months silently compares two different coverages, and "the
  -- market grew 40%" turns out to mean "we switched a portal on".
  "coverage"              jsonb NOT NULL DEFAULT '{}'::jsonb,
  "warnings"              text[] NOT NULL DEFAULT '{}',

  "generated_at"          timestamp with time zone NOT NULL DEFAULT now()
);

-- One report per client per kind per period. Regenerating a month must replace
-- it, not stack a second copy beside it.
CREATE UNIQUE INDEX IF NOT EXISTS "market_reports_period_unique"
  ON "market_reports" ("client_id", "kind", "period_start");
CREATE INDEX IF NOT EXISTS "market_reports_client_idx"
  ON "market_reports" ("client_id", "period_start" DESC);
