-- Data health: one row per check per run, for one client's feed.
--
-- The client's app judges our feed every night and until 2026-11-04 we learned
-- what it found from a screenshot. `npm run health` runs the same rules on our
-- side (src/lib/health/). These rows are its memory: a few checks compare
-- tonight with their own last week, and the next screen reads them.
--
-- Two verdicts per row and either can be null: `vault_status` is what the
-- client's rules conclude, `our_status` is what we conclude. Scoped to a client
-- because the feed is: what a client is sent depends on its communes, its
-- subscribed sources and its own agency. Derived and rebuilt every night, so
-- it is left out of the backup (scripts/dump-data.sh). Rows past 60 days are
-- pruned by src/lib/health/run.ts.

CREATE TABLE IF NOT EXISTS "data_health_checks" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id"    uuid NOT NULL REFERENCES "clients" ("id") ON DELETE CASCADE,
  "ran_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "check_key"    text NOT NULL,
  "source"       text NOT NULL DEFAULT '',
  "vault_status" text,
  "our_status"   text,
  "value"        double precision,
  "expected"     text NOT NULL,
  "message"      text NOT NULL,
  "note"         text,
  "detail"       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "data_health_checks_client_ran_idx"
  ON "data_health_checks" ("client_id", "ran_at");

-- 'green' | 'amber' | 'red' | 'unknown' — lib/health/rules.ts `Status`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'data_health_checks_vault_status_check' AND conrelid = 'data_health_checks'::regclass) THEN
    ALTER TABLE "data_health_checks" ADD CONSTRAINT "data_health_checks_vault_status_check"
      CHECK ("vault_status" IN ('green', 'amber', 'red', 'unknown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'data_health_checks_our_status_check' AND conrelid = 'data_health_checks'::regclass) THEN
    ALTER TABLE "data_health_checks" ADD CONSTRAINT "data_health_checks_our_status_check"
      CHECK ("our_status" IN ('green', 'amber', 'red', 'unknown'));
  END IF;
END $$;
