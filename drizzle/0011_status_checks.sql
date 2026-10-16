-- CHECK constraints on every status-like column.
--
-- Until 2026-10-15 these were free text. A typo in a writer — 'delisted ' with
-- a space, 'Active', a new event type spelled two ways — would create a state
-- that every filter silently ignores: `status = 'active'` would not see the
-- row and nothing would say why. Now the write fails, loudly, at the line
-- that made it.
--
-- The allowed values are the ones the code writes (src/lib/db/schema.ts, the
-- runner, the matcher, the meter, the API); src/lib/db/checks.test.ts holds
-- each list to the union type it comes from, so a new value added in code
-- without a migration fails the tests before it fails the nightly. Before
-- writing each one, the live database was asked for its distinct values on
-- 2026-10-15 and every existing row satisfied it — this migration runs at the
-- start of the nightly workflow and must not stop it:
--
--   users.role                     admin (1)
--   portal_sources.discovery_mode  index (13)
--   portal_runs.mode               scheduled (297), manual (21), backfill (44)
--   portal_runs.status             done (289), aborted (61), error (12)
--   properties.status              active (7 392), delisted (6 453)
--   portal_listings.status         active (24 084), delisted (5 102)
--   portal_listings.parse_status   ok (23 509), partial (5 676), failed (1)
--   portal_listing_events.type     listed (29 186), delisted (6 360),
--                                  price_changed (2 565), updated (1 866),
--                                  relisted (1 252)
--   buyers.criteria_source         manual (10)
--   buyer_matches.status           new (3 711)
--   market_reports.kind            adhoc (1)
--   api_usage.kind                 NULL (2)
--
-- Free text from the portals (`availability`, `property_type`) is not ours to
-- constrain and is left alone. Each block checks pg_constraint first, so the
-- file can run twice.

-- 'admin' | 'member' — lib/auth/users.ts `Role`; the CLI refuses anything else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_role_check"
      CHECK ("role" IN ('admin', 'member'));
  END IF;
END $$;

-- 'sitemap' | 'index' — portals/types.ts `discoveryMode`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'portal_sources_discovery_mode_check' AND conrelid = 'portal_sources'::regclass) THEN
    ALTER TABLE "portal_sources" ADD CONSTRAINT "portal_sources_discovery_mode_check"
      CHECK ("discovery_mode" IN ('sitemap', 'index'));
  END IF;
END $$;

-- 'scheduled' | 'manual' | 'backfill' — runner/run.ts `RunOptions.mode`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'portal_runs_mode_check' AND conrelid = 'portal_runs'::regclass) THEN
    ALTER TABLE "portal_runs" ADD CONSTRAINT "portal_runs_mode_check"
      CHECK ("mode" IN ('scheduled', 'manual', 'backfill'));
  END IF;
END $$;

-- 'running' at insert, then 'done' | 'partial' | 'aborted' | 'error' — runner/run.ts.
-- (`RunSummary.status` also has 'disabled', which is returned and never written.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'portal_runs_status_check' AND conrelid = 'portal_runs'::regclass) THEN
    ALTER TABLE "portal_runs" ADD CONSTRAINT "portal_runs_status_check"
      CHECK ("status" IN ('running', 'done', 'partial', 'aborted', 'error'));
  END IF;
END $$;

-- 'active' | 'delisted' — never 'sold' (CLAUDE.md, "Events — there is no sold").
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'properties_status_check' AND conrelid = 'properties'::regclass) THEN
    ALTER TABLE "properties" ADD CONSTRAINT "properties_status_check"
      CHECK ("status" IN ('active', 'delisted'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'portal_listings_status_check' AND conrelid = 'portal_listings'::regclass) THEN
    ALTER TABLE "portal_listings" ADD CONSTRAINT "portal_listings_status_check"
      CHECK ("status" IN ('active', 'delisted'));
  END IF;
END $$;

-- 'ok' | 'partial' | 'failed' — runner/ingest.ts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'portal_listings_parse_status_check' AND conrelid = 'portal_listings'::regclass) THEN
    ALTER TABLE "portal_listings" ADD CONSTRAINT "portal_listings_parse_status_check"
      CHECK ("parse_status" IN ('ok', 'partial', 'failed'));
  END IF;
END $$;

-- runner/events.ts `ListingEvent.type`, and /api/v1/events serves exactly these.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'portal_listing_events_type_check' AND conrelid = 'portal_listing_events'::regclass) THEN
    ALTER TABLE "portal_listing_events" ADD CONSTRAINT "portal_listing_events_type_check"
      CHECK ("type" IN ('listed', 'price_changed', 'delisted', 'relisted', 'availability_changed', 'updated'));
  END IF;
END $$;

-- 'fields' | 'extracted' | 'manual' — how far to trust a buyer's criteria (schema.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'buyers_criteria_source_check' AND conrelid = 'buyers'::regclass) THEN
    ALTER TABLE "buyers" ADD CONSTRAINT "buyers_criteria_source_check"
      CHECK ("criteria_source" IN ('fields', 'extracted', 'manual'));
  END IF;
END $$;

-- 'new' | 'seen' | 'sent' | 'dismissed' — the matcher writes 'new', PATCH /api/matches the rest.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'buyer_matches_status_check' AND conrelid = 'buyer_matches'::regclass) THEN
    ALTER TABLE "buyer_matches" ADD CONSTRAINT "buyer_matches_status_check"
      CHECK ("status" IN ('new', 'seen', 'sent', 'dismissed'));
  END IF;
END $$;

-- 'monthly' | 'weekly' | 'adhoc' — reports/generate.ts writes 'monthly' or 'adhoc'.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'market_reports_kind_check' AND conrelid = 'market_reports'::regclass) THEN
    ALTER TABLE "market_reports" ADD CONSTRAINT "market_reports_kind_check"
      CHECK ("kind" IN ('monthly', 'weekly', 'adhoc'));
  END IF;
END $$;

-- portals/streamV1.ts `LedgerKind`. NULL stays allowed: rows from before
-- 2026-10-15 carry no kind and are settled history (drizzle/0008).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'api_usage_kind_check' AND conrelid = 'api_usage'::regclass) THEN
    ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_kind_check"
      CHECK ("kind" IS NULL OR "kind" IN ('count', 'reserve', 'settle', 'legacy'));
  END IF;
END $$;
