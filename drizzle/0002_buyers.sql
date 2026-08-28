-- Buyers and matches — the client side of the product.
--
-- Hand-written and idempotent, same convention as 0001. Written before we know
-- how Med-Estates stores buyer criteria in GoHighLevel, because the CRM decides
-- how these columns get FILLED, not what they should be. Everything downstream —
-- the matcher, the API, the screens — is written against this shape and does not
-- change when the answer arrives.

-- ── Buyers ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "buyers" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id"       uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,

  -- TEST DATA. True for the invented buyers seeded so the matcher could be
  -- built ahead of the real ones. A column rather than a naming convention so
  -- that removing them is one exact statement, and so every client-facing query
  -- can filter on something the database enforces.
  "is_test_data"    boolean NOT NULL DEFAULT false,

  "name"            text NOT NULL,
  "email"           text,
  "phone"           text,
  "crm_contact_id"  text,
  "agent"           text,

  "budget_min_eur"  bigint,
  "budget_max_eur"  bigint,

  "commune_insee"   text[] NOT NULL DEFAULT '{}',

  "bedrooms_min"    integer,
  "rooms_min"       integer,
  "area_min_m2"     integer,
  "land_min_m2"     integer,

  "property_types"  text[] NOT NULL DEFAULT '{}',

  -- Two lists, not one: a missing must-have disqualifies, a missing
  -- nice-to-have only lowers the score and gets said out loud.
  "must_have"       text[] NOT NULL DEFAULT '{}',
  "nice_to_have"    text[] NOT NULL DEFAULT '{}',

  -- The original CRM text, verbatim, so an extraction can be checked rather
  -- than trusted.
  "notes_raw"       text,
  -- 'fields' | 'extracted' | 'manual'
  "criteria_source" text NOT NULL DEFAULT 'manual',

  "active"          boolean NOT NULL DEFAULT true,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "buyers_client_idx" ON "buyers" ("client_id", "active");
CREATE INDEX IF NOT EXISTS "buyers_test_idx"   ON "buyers" ("is_test_data");

-- NULLS NOT DISTINCT: most buyers have no CRM id yet, and without this every
-- one of those NULLs counts as unique, so the constraint would allow unlimited
-- duplicates of exactly the rows it exists to protect.
CREATE UNIQUE INDEX IF NOT EXISTS "buyers_crm_unique"
  ON "buyers" ("client_id", "crm_contact_id") NULLS NOT DISTINCT;

-- ── Matches ────────────────────────────────────────────────────────────────

-- Keyed on the PROPERTY, not the listing: the same villa on four portals is one
-- thing to show an agent. Proposing it four times is how a useful feature turns
-- into noise people switch off.
CREATE TABLE IF NOT EXISTS "buyer_matches" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "buyer_id"         uuid NOT NULL REFERENCES "buyers"("id") ON DELETE CASCADE,
  "property_id"      uuid NOT NULL REFERENCES "properties"("id") ON DELETE CASCADE,

  "score"            integer NOT NULL,

  -- Why it matched and why it did not, ready for the screen to render as
  -- sentences. An agent will not act on a number they cannot check.
  "reasons"          jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 'new' | 'seen' | 'sent' | 'dismissed'
  "status"           text NOT NULL DEFAULT 'new',
  "dismissed_reason" text,
  "draft_message"    text,

  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "buyer_matches_pair_unique"
  ON "buyer_matches" ("buyer_id", "property_id");
CREATE INDEX IF NOT EXISTS "buyer_matches_buyer_idx"
  ON "buyer_matches" ("buyer_id", "status", "score" DESC);
CREATE INDEX IF NOT EXISTS "buyer_matches_status_idx"
  ON "buyer_matches" ("status", "created_at" DESC);
