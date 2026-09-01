-- API keys for client instances.
--
-- The collector is not customer-facing; a client instance is a machine talking
-- to it, and a session cookie is a browser mechanism. This is how the other
-- half of the product identifies itself.
--
-- WHAT IS STORED, AND WHAT IS NOT
--
-- The key itself is never stored. Only its SHA-256 hash, which is all that is
-- needed to recognise it. A key is high-entropy random, not a password, so a
-- plain fast hash is the right tool: bcrypt and friends exist to make guessing
-- a human-chosen secret expensive, and there is nothing to guess here. The
-- expensive hash would only be a per-request cost on a path that runs on every
-- call.
--
-- `prefix` is the first few characters, kept in the clear so a key can be
-- identified in a list, in a log line, and by whoever is holding it — without
-- which "revoke the one that leaked" has no way to name which one that is.

CREATE TABLE IF NOT EXISTS "client_api_keys" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id"    uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,

  -- Who or what holds it: "med-estates production", "staging". Rotation means
  -- two live keys at once, and without a label they are indistinguishable.
  "name"         text NOT NULL,
  "prefix"       text NOT NULL,
  "key_hash"     text NOT NULL,

  -- Answers "is this key still in use?" before anyone revokes it. Written on
  -- use, so it is deliberately allowed to be approximate.
  "last_used_at" timestamp with time zone,

  -- Revoked rather than deleted: a key that turns up in a log a month later
  -- should still be identifiable as ours and as withdrawn.
  "revoked_at"   timestamp with time zone,
  "expires_at"   timestamp with time zone,

  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);

-- The lookup path: hash the presented key, find this row. Unique because two
-- clients sharing a hash would mean a collision we should hear about loudly.
CREATE UNIQUE INDEX IF NOT EXISTS "client_api_keys_hash_unique"
  ON "client_api_keys" ("key_hash");

CREATE INDEX IF NOT EXISTS "client_api_keys_client_idx"
  ON "client_api_keys" ("client_id");

-- Events are read by cursor: (occurred_at, id) ascending, filtered by type.
-- The existing indexes are keyed on listing and property; a client instance
-- walks the table in time order across every property it may see, which is a
-- different access pattern and deserves its own index.
CREATE INDEX IF NOT EXISTS "portal_listing_events_cursor_idx"
  ON "portal_listing_events" ("occurred_at", "id");
