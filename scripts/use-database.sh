#!/usr/bin/env bash
#
# Point .env.local at a database, once, so nothing else has to.
#
#   ./scripts/use-database.sh
#
# Asks for the connection string with the input hidden and percent-encodes the
# password before writing it. Both of those matter, and both were learned the
# expensive way during the Supabase move:
#
#   - A `!` in a password is history expansion in zsh, even inside double
#     quotes. The shell substitutes an old command into the middle of the
#     password and the connection fails naming a host nobody typed. Three runs
#     were lost to it. Reading the string never goes through the shell.
#
#   - libpq (psql, pg_dump) splits a URI on the FIRST `@`; node splits on the
#     last. A password containing `@` therefore works in half the tooling and
#     fails in the other half. Encoded once here, both agree forever.
#
# Deliberately NOT adding sslmode: `pg` in node reads it as verify-full and
# fails against the Supabase pooler's certificate, and it would override the
# ssl config in db/client.ts that exists precisely to handle that. Node gets TLS
# from there; psql gets it from PGSSLMODE on the commands that need it.
#
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] || { echo "No .env.local here." >&2; exit 1; }

if [ -t 0 ]; then
  printf 'Connection string (input hidden): '
  read -rs RAW
  printf '\n'
else
  read -r RAW
fi
[ -n "$RAW" ] || { echo "Nothing entered." >&2; exit 1; }

ENCODED="$(node -e '
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
' "$RAW")"

# Kept, because the previous value is the only way back if the new one is wrong
# and the old one is not written down anywhere else.
cp .env.local ".env.local.before-$(date +%F-%H%M)"

python3 - "$ENCODED" <<'PY'
import io, sys, re
url = sys.argv[1]
p = ".env.local"
s = io.open(p, encoding="utf-8").read()
if re.search(r'(?m)^DATABASE_URL=', s):
    s = re.sub(r'(?m)^DATABASE_URL=.*$', "DATABASE_URL=" + url, s, count=1)
else:
    s = s.rstrip() + "\nDATABASE_URL=" + url + "\n"
io.open(p, "w", encoding="utf-8").write(s)
PY

# Host and database only. The password is the thing this script exists to keep
# out of terminals, so it does not get echoed back at the end of it.
node -e '
  const u = new URL(process.argv[1]);
  console.log("\n  .env.local now points at:");
  console.log("    host " + u.hostname + ":" + (u.port || 5432));
  console.log("    db   " + u.pathname.replace("/", "") + "   user " + u.username + "\n");
' "$ENCODED"

echo "  Previous value saved next to it. Check with:  npm run db:info"
