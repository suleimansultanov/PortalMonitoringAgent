#!/bin/bash
#
# Install (or remove) the 03:00 launchd job on this Mac.
#
#   ./scripts/install-nightly.sh
#   ./scripts/install-nightly.sh --uninstall
#
# A user LaunchAgent, not a system daemon: it runs as you, with your files and
# your network, which is what a collector reading your own database needs. It
# also means no sudo and nothing left behind outside your home directory.
#
set -euo pipefail

LABEL="com.leadestate.pma-nightly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$REPO/scripts/nightly.sh</string>
  </array>

  <key>WorkingDirectory</key><string>$REPO</string>

  <!--
    03:00 local time. Well outside the hours a French property portal has real
    visitors, and inside the 01:00-05:00 CET window LuxuryEstate asked for.

    If the Mac is asleep at 03:00 the job runs on wake. If it is powered off it
    runs at next login. Either way a missed night is collected late rather than
    skipped - which is what we want, because the diff is computed fresh every
    pass and a late pass catches up on its own.
  -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>0</integer>
  </dict>

  <!--
    Anything the script writes before its own logging is set up - a missing
    node, an unreadable .env.local - lands here. Without it those failures are
    invisible: the job "ran", produced nothing, and left no trace.
  -->
  <key>StandardOutPath</key><string>$REPO/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/launchd.err.log</string>

  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo "installed $LABEL — 03:00 daily"
echo "  plist:    $PLIST"
echo "  check:    launchctl list | grep pma-nightly"
echo "  run now:  launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  remove:   $REPO/scripts/install-nightly.sh --uninstall"
