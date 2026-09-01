#!/bin/bash
#
# What the scheduler actually calls. `npm run nightly` with the things a
# scheduler does not give you for free.
#
#   ./scripts/nightly.sh              collect
#   ./scripts/nightly.sh --check      preflight only, touches no portal
#
# THREE THINGS THIS EXISTS FOR, all of which bite only under a scheduler and
# never when a person runs the command by hand:
#
#   1. PATH. launchd hands a job /usr/bin:/bin:/usr/sbin:/sbin and nothing else.
#      Node from Homebrew or nvm is on neither, so the job dies with
#      "npm: command not found" at 03:00 and the first sign is an empty logs
#      directory a week later.
#   2. The environment. A login shell reads .env.local through the app; a
#      launchd job reads nothing at all.
#   3. Sleep. This is a laptop. Without caffeinate the machine suspends
#      mid-crawl, the browser session dies with it, and the portal sees us
#      disappear part-way through a pass we asked permission for.
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

# ── 1. Find node ──────────────────────────────────────────────────────────
# Homebrew (both architectures), then whatever nvm has, newest last so it wins.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for dir in "$HOME"/.nvm/versions/node/*/bin; do
  [ -d "$dir" ] && export PATH="$dir:$PATH"
done

if ! command -v npm >/dev/null 2>&1; then
  echo "[nightly.sh] npm is not on PATH. PATH=$PATH" >&2
  echo "[nightly.sh] add the directory holding node to the loop above." >&2
  exit 127
fi

# ── 2. Load the environment ───────────────────────────────────────────────
# `set -a` exports everything the file defines. Comments and blank lines are
# fine; quoted values are not unquoted, which is why DATABASE_URL should be
# written without quotes in .env.local.
if [ -f "$REPO/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO/.env.local"
  set +a
else
  echo "[nightly.sh] no .env.local — the run will have no DATABASE_URL" >&2
fi

mkdir -p "$REPO/logs"
HISTORY="$REPO/logs/history.log"
STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S')"
STARTED_EPOCH="$(date +%s)"

# ── 3. Run, awake ─────────────────────────────────────────────────────────
# -i prevents idle sleep, -m keeps the disk spinning. Not -d: there is no
# reason to keep the display on for a crawl.
CAFFEINATE=""
command -v caffeinate >/dev/null 2>&1 && CAFFEINATE="caffeinate -im"

# shellcheck disable=SC2086
$CAFFEINATE npm run nightly -- "$@"
CODE=$?

# ── 4. One line per night, whatever happened ──────────────────────────────
# The per-night directory holds the detail; this file is the only place that
# answers "has it been running at all?" in one screen. That question comes up
# more often than any other, and a directory listing answers it badly.
ELAPSED=$(( $(date +%s) - STARTED_EPOCH ))
VERDICT="$(node -e "
  try {
    const s = require('$REPO/logs/latest/summary.json');
    const bad = s.sources.filter(x => x.grade !== 'ok').map(x => x.sourceKey + ':' + x.grade);
    process.stdout.write(s.verdict + (bad.length ? '  ' + bad.join(' ') : ''));
  } catch { process.stdout.write('no summary'); }
" 2>/dev/null || echo "no summary")"

printf '%s  exit=%-3s %-5s  %sm  %s\n' \
  "$STARTED_AT" "$CODE" "$([ "$CODE" -eq 0 ] && echo ok || echo FAIL)" \
  "$(( ELAPSED / 60 ))" "$VERDICT" >> "$HISTORY"

exit $CODE
