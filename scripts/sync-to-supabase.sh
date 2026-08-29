#!/usr/bin/env bash
#
# Push the locally collected market data to the deployed database.
#
#   ./scripts/sync-to-supabase.sh "postgresql://…session-pooler…:5432/postgres"
#
# Source is DATABASE_URL from .env.local (the local Postgres the collector
# writes to). Target is the argument. Run it whenever the demo should show what
# has been collected since last time.
#
# WHAT IT DOES NOT TOUCH, AND WHY
#
# `users`, `clients` and `settings` are left alone on the target.
#
#   users    — accounts exist only where people log in. Copying the local table
#              over would delete the account you signed in with, and the second
#              sync would lock you out of your own demo. This is the trap this
#              script exists to prevent.
#   clients  — configuration, seeded once. Its UUID is the anchor that `buyers`
#              and `market_reports` point at; recreating it on either side
#              breaks every one of those references.
#   settings — encrypted with ENCRYPTION_KEY, and per-environment by nature.
#
# Everything else is replaced wholesale: emptied, then reloaded. The collected
# market is a derived artefact, so there is nothing on the target worth merging
# with — and a merge would silently keep rows that no longer exist locally.

set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-${SUPABASE_URL:-}}"
if [ -z "$TARGET" ]; then
  echo "Usage: ./scripts/sync-to-supabase.sh \"<session pooler connection string>\"" >&2
  exit 1
fi
case "$TARGET" in
  postgresql://*|postgres://*) ;;
  *) echo "The target must start with postgresql:// — got: ${TARGET%%:*}…" >&2; exit 1 ;;
esac

SOURCE="$(grep '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
if [ -z "$SOURCE" ]; then
  echo "DATABASE_URL is not set in .env.local" >&2
  exit 1
fi

if command -v pg_dump >/dev/null 2>&1; then
  run_dump() { pg_dump "$SOURCE" "$@"; }
  run_psql()  { psql "$TARGET" "$@"; }
else
  echo "pg_dump not on PATH — using the postgres:16 image."
  DOCKER_SOURCE="${SOURCE//localhost/host.docker.internal}"
  DOCKER_SOURCE="${DOCKER_SOURCE//127.0.0.1/host.docker.internal}"
  run_dump() { docker run --rm postgres:16 pg_dump "$DOCKER_SOURCE" "$@"; }
  run_psql()  { docker run --rm -i postgres:16 psql "$TARGET" "$@"; }
fi

# Parents first. The same order is used to empty and to fill; emptying happens
# in one statement, so the order there does not matter, but keeping one list
# means there is one place to edit when a table is added.
TABLES=(
  portal_sources
  client_sources
  portal_runs
  portal_agencies
  properties
  portal_snapshots
  portal_listings
  portal_listing_events
  buyers
  buyer_matches
  market_reports
)

DUMP="$(mktemp -t pma-sync).sql"
trap 'rm -f "$DUMP"' EXIT

echo "── dumping from local ───────────────────────────────"
: > "$DUMP"
for t in "${TABLES[@]}"; do
  run_dump --data-only --no-owner --no-privileges --table="public.$t" >> "$DUMP"
  printf '  %-24s\n' "$t"
done
echo "  $(du -h "$DUMP" | cut -f1)"

echo
echo "── emptying the target ──────────────────────────────"
# One TRUNCATE for all of them: Postgres refuses to truncate a table another
# table references unless that one is going too, and listing them together
# satisfies it without CASCADE — which would have reached `users` through
# `clients` and quietly deleted the accounts.
JOINED=$(IFS=,; echo "${TABLES[*]}")
run_psql -v ON_ERROR_STOP=1 -c "TRUNCATE TABLE $JOINED;"

echo
echo "── loading ──────────────────────────────────────────"
run_psql -v ON_ERROR_STOP=1 -f - < "$DUMP" > /dev/null

echo
echo "── what landed ──────────────────────────────────────"
run_psql -c "select 'portal_listings' t, count(*) from portal_listings
             union all select 'properties', count(*) from properties
             union all select 'buyers', count(*) from buyers
             union all select 'users (untouched)', count(*) from users;"
