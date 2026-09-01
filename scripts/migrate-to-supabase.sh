#!/usr/bin/env bash
#
# Move the database to a fresh Supabase project.
#
#   ./scripts/migrate-to-supabase.sh
#
# It asks for the connection string with the input hidden, so the password never
# reaches your shell history. `SUPABASE_DATABASE_URL=… ./scripts/migrate-to-supabase.sh`
# works too, for a non-interactive run.
#
# Runs the steps that are mechanical and STOPS before the two that are
# decisions: switching the sources on, and the sync that truncates the target.
# Those are printed for you to run when you have looked at what came before.
#
# Source is DATABASE_URL from .env.local — the local Postgres holding the
# collected market. Do not repoint that file until the very end; several steps
# below read from it, and one of them would otherwise dump the new empty
# database over itself.
#
set -euo pipefail
cd "$(dirname "$0")/.."

# The connection string carries the database password, so it is READ, not passed
# as an argument.
#
# An argument would be written to ~/.zsh_history in the clear and visible in
# `ps` to every process on the machine for as long as this runs — which is
# worse than it sounds, because a shell history file is plain text, is backed
# up, and outlives whatever reason there was to be careless once.
#
# Passing it as $1 still works for a non-interactive run; the prompt is what
# happens when you do not.
TARGET="${1:-${SUPABASE_DATABASE_URL:-}}"
if [ -z "$TARGET" ]; then
  if [ -t 0 ]; then
    printf 'Session pooler connection string (input hidden): '
    read -rs TARGET
    printf '\n'
  else
    echo "No connection string. Pass it as an argument, in SUPABASE_DATABASE_URL," >&2
    echo "or run this in a terminal so it can ask." >&2
    exit 1
  fi
fi
if [ -z "$TARGET" ]; then
  echo "Nothing entered." >&2
  exit 1
fi
case "$TARGET" in
  postgresql://*|postgres://*) ;;
  *) echo "The target must start with postgresql:// — got: ${TARGET%%:*}…" >&2; exit 1 ;;
esac
case "$TARGET" in
  *localhost*|*127.0.0.1*)
    echo "That target is the local database. This script moves data TO the new one." >&2
    exit 1 ;;
esac
# The pooler in transaction mode rejects the statement_timeout the pool sends as
# a startup parameter. Session pooler is 5432; 6543 is the transaction one.
case "$TARGET" in
  *:6543/*) echo "warning: :6543 is the TRANSACTION pooler. Use the session pooler (:5432)." >&2 ;;
esac
# ── Normalise the connection string ──────────────────────────────────────
#
# NODE AND PSQL DISAGREE ABOUT WHERE A PASSWORD ENDS, and a password containing
# `@` is where that disagreement surfaces.
#
# `pg` in node parses the URI with WHATWG rules and splits on the LAST `@`, so
# it connects. libpq — which is `psql` and `pg_dump` — splits on the FIRST, and
# takes the remainder of the password plus the real host as the hostname. Half
# the steps in this script then work and half fail, with an error that names a
# hostname nobody typed.
#
# So the password is percent-encoded here, once, and every step below uses the
# normalised string. Already-encoded passwords are left alone.
TARGET="$(node -e '
  const raw = process.argv[1];
  const m = raw.match(/^(postgres(?:ql)?:\/\/)(.*)$/s);
  if (!m) { process.stdout.write(raw); process.exit(0); }
  const at = m[2].lastIndexOf("@");
  if (at === -1) { process.stdout.write(raw); process.exit(0); }
  const userinfo = m[2].slice(0, at);
  const rest = m[2].slice(at + 1);
  const colon = userinfo.indexOf(":");
  if (colon === -1) { process.stdout.write(raw); process.exit(0); }
  const user = userinfo.slice(0, colon);
  const pass = userinfo.slice(colon + 1);
  let already = false;
  try { already = decodeURIComponent(pass) !== pass; } catch { already = false; }
  const enc = already ? pass : encodeURIComponent(pass);
  process.stdout.write(m[1] + user + ":" + enc + "@" + rest);
' "$TARGET")"

# ── sslmode is deliberately NOT in the connection string ─────────────────
#
# It means two different things to the two clients that read this string.
#
# To libpq — psql, pg_dump — `require` is "encrypt, do not verify the chain".
# To `pg-connection-string` today it is an alias for `verify-full`, which DOES
# verify, and Supabase's pooler presents a certificate that does not chain to a
# root Node trusts. The result is SELF_SIGNED_CERT_IN_CHAIN on every node step
# while psql is perfectly happy — from one string, in one script.
#
# Worse, a parsed connection string OVERRIDES the explicit `ssl` config in
# db/client.ts, so putting sslmode here silently cancels the
# `rejectUnauthorized: false` that file sets on purpose, with the reason
# written above it.
#
# So: nothing in the string. Node gets TLS from client.ts. libpq gets it from
# PGSSLMODE on the individual psql/pg_dump calls below, where `require` has the
# meaning we actually want.
if printf '%s' "$TARGET" | grep -q 'sslmode='; then
  echo "  note: sslmode= in the connection string will be honoured by node as"
  echo "        verify-full and will fail against the Supabase pooler. Remove it."
fi

SOURCE="$(grep '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
[ -n "$SOURCE" ] || { echo "DATABASE_URL is not set in .env.local" >&2; exit 1; }

command -v pg_dump >/dev/null 2>&1 || {
  echo "pg_dump is not on PATH. sync-to-supabase.sh has a docker fallback if you need one." >&2
  exit 1; }

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# psql pipes anything taller than the window through a pager and waits there.
# In a script that reads as "it hung", and in a non-interactive run — cron, CI,
# a colleague piping the output to a file — it would wait for a keypress that
# never comes.
export PSQL_PAGER=cat
export PAGER=cat

step "1/6  backing up the local database"
# Skippable, because this script is re-run after a failure more often than not
# and the local database has not changed in between.
if [ "${SKIP_BACKUP:-}" = "1" ]; then
  echo "  skipped (SKIP_BACKUP=1)"
else
  BACKUP="backup-local-$(date +%F-%H%M).sql"
  ./scripts/dump-data.sh "$BACKUP"
  echo "  → $BACKUP   (set SKIP_BACKUP=1 to skip this on a re-run)"
fi

step "2/6  checking the target answers, and that the override takes"
# If this prints localhost, .env.local won the argument with the environment
# and every step below would silently run against the wrong database.
DATABASE_URL="$TARGET" npm run --silent db:info

step "3/6  applying migrations (and row level security)"
DATABASE_URL="$TARGET" npm run --silent db:migrate

step "4/6  carrying the clients row across, UUID intact"
# Before the seed, and this is the order that matters. The seed would mint a new
# UUID for the client; the market data being synced later carries the local one,
# and its children (client_sources, buyers, market_reports) would then point at
# a client that does not exist.
if PGSSLMODE=require psql "$TARGET" -tAc "select 1 from clients limit 1" | grep -q 1; then
  echo "  clients already present on the target — skipping"
else
  pg_dump "$SOURCE" --data-only --no-owner --no-privileges --table=public.clients \
    | PGSSLMODE=require psql "$TARGET" -v ON_ERROR_STOP=1 >/dev/null
  echo "  copied"
fi
PGSSLMODE=require psql "$TARGET" -c "select id, slug, array_length(commune_insee,1) as communes from clients;"

step "5/6  seeding sources and configuration"
DATABASE_URL="$TARGET" npm run --silent db:seed

step "6/6  verifying"
PGSSLMODE=require psql "$TARGET" -c "
  select tablename, rowsecurity as rls
  from pg_tables where schemaname='public' order by 1;"
echo "  Every row above must say 't'. Any 'f' is a table left open to the Data API:"
echo "    alter table <name> enable row level security;"

cat <<'NEXT'

── what is left, and why it is not automatic ──────────────────────

  1. Switch the sources on. A decision: it is what makes the scheduler
     start touching portals.

       update portal_sources set enabled = true
       where key in ('green-acres','superimmo','etreproprio','smc','figaro','luxuryestate');

  2. Load the market. This TRUNCATES the market tables on the target
     before loading, so it is not something to run without looking.

       ./scripts/sync-to-supabase.sh "<the same connection string>"

  3. An account and an API key.

       DATABASE_URL="<target>" npm run user:create -- --email=… --role=admin
       DATABASE_URL="<target>" npm run key:create -- --client=med-estates --name=production

  4. Only now, point .env.local at the new database, then:

       npm run nightly -- --check

NEXT
