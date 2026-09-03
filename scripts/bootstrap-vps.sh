#!/bin/bash
#
# Turn a bare Ubuntu 24.04 box into something that can run a night's collection.
#
#   apt-get update && apt-get install -y git
#   git clone https://github.com/suleimansultanov/PortalMonitoringAgent.git
#   cd PortalMonitoringAgent && bash scripts/bootstrap-vps.sh
#
# It installs, it does not configure. When it finishes there is still no
# .env.local on the box — the database URL and the R2 keys are secrets and they
# come from the operator's machine, not from a script in a public repository.
# The last thing printed is the scp line that brings them over.
#
# Written for the question "does this address get 403 from Figaro or not".
# A throwaway box that answers that costs less than a cent, so this script
# optimises for arriving at the answer quickly, not for a hardened host.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

say() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "run this as root — a fresh Hetzner box logs you in as root anyway" >&2
  exit 1
fi

# ── 1. Node ───────────────────────────────────────────────────────────────
# Ubuntu 24.04 ships Node 18 in its own repository. Next 15 and the tsx loader
# both want newer, and the failure mode if you skip this is a syntax error deep
# inside a dependency that reads like a broken package rather than an old runtime.
say "node 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

# ── 2. The application ────────────────────────────────────────────────────
say "npm ci"
npm ci

# ── 3. Chromium ───────────────────────────────────────────────────────────
# Three of the six portals only exist after JavaScript runs. `npm ci` does NOT
# fetch the browser — playwright's postinstall is absent from the lockfile
# (hasInstallScript: false), which is exactly how the first GitHub Actions run
# failed. --with-deps pulls the ~40 shared libraries a headless Chromium needs
# on a server with no desktop installed.
say "chromium"
npx playwright install --with-deps chromium

# ── 4. Where the secrets go ───────────────────────────────────────────────
say "done — one thing left"
cat <<EOF

The box is ready but blind: there is no .env.local, so it has no database and
no R2 bucket. Bring yours over from your own machine, in ONE line, from the
repo directory on your Mac:

    scp .env.local root@$(hostname -I 2>/dev/null | awk '{print $1}'):$REPO/.env.local

Then, here:

    cd $REPO
    npm run db:info                                                # can it see Supabase?
    npm run collect -- --source=figaro --communes=83119 --skip-resolve

That last command is the whole point. The same commune, the same code, three
addresses:

    your laptop at home     321 collected of 326 stated, zero 403
    GitHub Actions           59 collected, 403 from page 3 onward
    this box                  ?

EOF
