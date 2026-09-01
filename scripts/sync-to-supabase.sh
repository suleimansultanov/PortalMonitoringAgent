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

# ── The connection string is READ, not typed on the command line ─────────
#
# Three separate runs of this migration were lost to the same thing: a `!` in
# the password is history expansion in zsh, even inside double quotes, so the
# shell silently substitutes an old command into the middle of the password and
# the connection fails naming a host or a port nobody typed. It is not a
# mistake anyone learns their way out of — the fix is to stop putting the
# string through a shell.
#
# An argument still works for scripted use.
TARGET="${1:-${SUPABASE_URL:-}}"
if [ -z "$TARGET" ]; then
  if [ -t 0 ]; then
    printf 'Target connection string (input hidden): '
    read -rs TARGET
    printf '\n'
  else
    echo "Usage: ./scripts/sync-to-supabase.sh   (it will ask)" >&2
    echo "   or: SUPABASE_URL=… ./scripts/sync-to-supabase.sh" >&2
    exit 1
  fi
fi
[ -n "$TARGET" ] || { echo "Nothing entered." >&2; exit 1; }

# ── Percent-encode the password ──────────────────────────────────────────
#
# libpq splits a URI on the FIRST `@` and takes everything after it as the
# host; node splits on the last. A password containing `@` therefore works in
# half the tooling and fails in the other half, with an error that names a
# hostname or a port that was never typed.
TARGET="$(node -e '
  const raw = process.argv[1];
  const m = raw.match(/^(postgres(?:ql)?:\/\/)(.*)$/s);
  if (!m) { process.stdout.write(raw); process.exit(0); }
  const at = m[2].lastIndexOf("@");
  if (at === -1) { process.stdout.write(raw); process.exit(0); }
  const userinfo = m[2].slice(0, at), rest = m[2].slice(at + 1);
  const colon = userinfo.indexOf(":");
  if (colon === -1) { process.stdout.write(raw); process.exit(0); }
  const user = userinfo.slice(0, colon), pass = userinfo.slice(colon + 1);
  let already = false;
  try { already = decodeURIComponent(pass) !== pass; } catch { already = false; }
  process.stdout.write(m[1] + user + ":" + (already ? pass : encodeURIComponent(pass)) + "@" + rest);
' "$TARGET")"

# NOTE: PGSSLMODE is deliberately NOT exported here. It is set on the calls that
# talk to the TARGET only — see run_psql below. Exported, it also reaches the
# pg_dump reading the LOCAL database, which is a plain Postgres with no TLS, and
# that fails with "server does not support SSL, but SSL was required".
# A pager in a script waits for a keypress that a script will never give it.
export PSQL_PAGER=cat
export PAGER=cat
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
  # The target crosses the public internet; `require` here is libpq's meaning —
  # encrypt, do not verify the chain — which is what the Supabase pooler needs.
  run_psql()  { PGSSLMODE=require psql "$TARGET" "$@"; }
  # The collector's own database, for the sync stamp at the end. `settings` is
  # not one of the tables this script copies — it holds encrypted values keyed
  # to an environment — so the two sides are written separately and on purpose.
  run_psql_local() { psql "$SOURCE" "$@"; }
else
  echo "pg_dump not on PATH — using the postgres:16 image."
  DOCKER_SOURCE="${SOURCE//localhost/host.docker.internal}"
  DOCKER_SOURCE="${DOCKER_SOURCE//127.0.0.1/host.docker.internal}"
  run_dump() { docker run --rm postgres:16 pg_dump "$DOCKER_SOURCE" "$@"; }
  run_psql()  { docker run --rm -i -e PGSSLMODE=require postgres:16 psql "$TARGET" "$@"; }
  run_psql_local() { docker run --rm -i postgres:16 psql "$DOCKER_SOURCE" "$@"; }
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

echo
echo "── stamping the sync ────────────────────────────────"
# Written on BOTH sides, and after the load rather than before.
#
# The hosted copy is what the Sources screen reads, so that one has to say when
# the data behind it actually arrived. The local copy exists so the same screen
# tells the truth when run against the collector's own database.
#
# Stamped last on purpose: a timestamp written before a load that then fails
# would claim the site is current while it is showing yesterday's market, which
# is the exact failure the screen exists to make visible.
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for target in remote local; do
  if [ "$target" = "remote" ]; then RUN=run_psql; else RUN=run_psql_local; fi
  $RUN -v ON_ERROR_STOP=1 -c "
    insert into settings (key, value, encrypted, updated_at)
    values ('last_sync_at', '$STAMP', false, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();" > /dev/null
done
echo "  $STAMP"
