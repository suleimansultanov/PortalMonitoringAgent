#!/usr/bin/env bash
#
# Dump the collected data so it can be loaded into a fresh database.
#
#   ./scripts/dump-data.sh [output.sql]
#
# Reads DATABASE_URL from .env.local — the same connection string the collector
# uses, rather than one typed from memory. A psql session and the collector
# disagreeing about whether a table exists has already cost an evening here.
#
# WHY ONE pg_dump PER TABLE
#
# A data-only dump carries no deferred constraints: the rows are simply COPYed
# in, and a foreign key pointing at a table that has not been loaded yet is
# rejected on the spot. So the load order has to be parents first.
#
# pg_dump does NOT promise to honour the order of `--table` flags — it sorts
# objects internally, and alphabetical order puts `buyer_matches` before
# `buyers`, which fails. Dumping each table separately and appending in the
# order below is the version that cannot silently reorder itself.

set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${1:-pma-data.sql}"

if [ ! -f .env.local ]; then
  echo "No .env.local here. Run this from the repo, with DATABASE_URL set." >&2
  exit 1
fi

URL="$(grep '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
if [ -z "$URL" ]; then
  echo "DATABASE_URL is not set in .env.local" >&2
  exit 1
fi

# Prefer a local pg_dump; fall back to the postgres image already on this
# machine. Inside a container `localhost` means the container, so the host has
# to be rewritten — this is the single most common way this step fails.
if command -v pg_dump >/dev/null 2>&1; then
  run_dump() { pg_dump "$URL" "$@"; }
else
  echo "pg_dump not on PATH — using the postgres:16 image instead."
  DOCKER_URL="${URL//localhost/host.docker.internal}"
  DOCKER_URL="${DOCKER_URL//127.0.0.1/host.docker.internal}"
  run_dump() { docker run --rm postgres:16 pg_dump "$DOCKER_URL" "$@"; }
fi

# Parents first. Adding a table? Put it after everything it references.
TABLES=(
  clients
  users
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
  settings
)

: > "$OUT"
for t in "${TABLES[@]}"; do
  printf '\n-- ── %s ───────────────────────────────────────────\n' "$t" >> "$OUT"
  run_dump --data-only --no-owner --no-privileges --table="public.$t" >> "$OUT"
  printf '  %-24s done\n' "$t"
done

echo
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "Load it into the new database with ON_ERROR_STOP so a failure cannot pass"
echo "as success:"
echo
echo "  psql \"<session pooler string>\" -v ON_ERROR_STOP=1 -f $OUT"
