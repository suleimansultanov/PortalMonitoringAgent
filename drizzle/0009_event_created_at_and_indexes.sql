-- When WE recorded an event, apart from when it happened.
--
-- /api/v1/events walked (occurred_at, id). Reparse writes the events it finds
-- with occurred_at = the snapshot's fetch time — the past — so an event
-- recorded today could sort before a client's cursor and be stepped over for
-- ever (REVIEW §2). The cursor now walks created_at, which only moves forward.
-- Existing rows take their occurred_at: for them the two have always been the
-- same instant, so a cursor issued before this migration still points at the
-- same place in the walk.

ALTER TABLE "portal_listing_events" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
UPDATE "portal_listing_events" SET "created_at" = "occurred_at" WHERE "created_at" IS NULL;
ALTER TABLE "portal_listing_events" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "portal_listing_events" ALTER COLUMN "created_at" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "portal_listing_events_created_cursor_idx"
  ON "portal_listing_events" ("created_at", "id");

-- The refresh queue: per source, active, oldest last_seen_at first (REVIEW 1.2).
-- Also the index every "active listings of this source" read was missing.
CREATE INDEX IF NOT EXISTS "portal_listings_source_status_seen_idx"
  ON "portal_listings" ("source_id", "status", "last_seen_at");

-- The snapshot walk: active properties of a commune, by id (REVIEW §3).
CREATE INDEX IF NOT EXISTS "properties_active_commune_id_idx"
  ON "properties" ("commune_insee", "id") WHERE "status" = 'active';

-- The client's own agency, under every name the portals print it with.
--
-- On a property the client itself is selling, /api/v1 serves only the client's
-- own listings, not other agencies' duplicates of it (Med-Estates, 2026-10-15).
-- Applied to production with the earlier wording of this comment; the column
-- is unchanged. Names, normalised as portal_agencies
-- normalises them, because the same agency is a different row per portal
-- spelling — "Med-Estates", and on Green-Acres the agent, "Mark Voncken".
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "own_agency_names" text[] NOT NULL DEFAULT '{}';
