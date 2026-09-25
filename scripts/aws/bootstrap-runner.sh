#!/usr/bin/env bash
# Turn a fresh Ubuntu 24.04 EC2 instance into the nightly collector's runner.
#
#   Run ONCE, as ubuntu, on the box:
#     curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/aws/bootstrap-runner.sh | bash -s -- <RUNNER_TOKEN> <REPO_URL>
#   or copy the file over and: bash bootstrap-runner.sh <RUNNER_TOKEN> <REPO_URL>
#
#   RUNNER_TOKEN: GitHub → repo → Settings → Actions → Runners → New self-hosted
#                 runner → the token shown under "Configure" (valid one hour).
#   REPO_URL:     https://github.com/<org>/<repo>
#
# WHAT IT DOES. Installs Node 22, the system libraries Chromium needs, and the
# GitHub Actions runner as a systemd service labelled `pma`. After that the
# existing workflow runs here unchanged the moment the repo variable
# PMA_RUNNER is set to `self-hosted` — secrets stay in GitHub, logs and the
# summary stay in the Actions tab, and flipping the variable back to
# `ubuntu-latest` is the whole rollback.
#
# WHY A RUNNER AND NOT A CRON. Nothing about the nightly pass is rewritten:
# same workflow, same secrets, same Sunday full sweep. The box only changes
# where the requests leave from — an EU address that Green-Acres shows euros
# to, fixed (Elastic IP) so portals can allowlist it, and one hop from the
# residential proxy for the two portals that filter datacentre ranges.
#
# Sizing that worked: t3.small (2 vCPU, 2 GB) with the 2 GB swap below, 30 GB
# gp3. Chromium is the only memory user and the pass is sequential.
set -euo pipefail

TOKEN="${1:?runner token}"
REPO="${2:?repo url, e.g. https://github.com/org/repo}"
RUNNER_VERSION="${RUNNER_VERSION:-2.329.0}"

echo "── system packages"
sudo apt-get update -y
sudo apt-get install -y curl git unzip jq ca-certificates

echo "── swap (2 GB), so a 2 GB instance survives Chromium"
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "── node 22 (official tarball: works on any Ubuntu, including ones NodeSource has not catalogued yet)"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  ARCH=$(uname -m); case "$ARCH" in x86_64) NA=x64;; aarch64) NA=arm64;; *) echo "unsupported arch $ARCH"; exit 1;; esac
  NODE_VERSION="${NODE_VERSION:-22.20.0}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NA}.tar.xz" -o /tmp/node.tar.xz
  sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz
fi
node -v && npm -v

echo "── chromium system libraries (once; the workflow then installs the browser itself)"
if ! npx --yes playwright@1.62.1 install-deps chromium; then
  echo "playwright does not know this Ubuntu release yet — installing the same libraries by name"
  sudo apt-get install -y libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2t64 libatspi2.0-0t64 libx11-xcb1 libxcb1 libxext6 libxi6 libxtst6 \
    fonts-liberation fonts-noto-color-emoji xvfb 2>&1 | tail -3 || true
fi

echo "── github actions runner ${RUNNER_VERSION}"
mkdir -p "$HOME/actions-runner" && cd "$HOME/actions-runner"
if [ ! -f run.sh ]; then
  ARCH=$(uname -m); case "$ARCH" in x86_64) A=x64;; aarch64) A=arm64;; *) echo "unsupported arch $ARCH"; exit 1;; esac
  curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${A}-${RUNNER_VERSION}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
fi
./config.sh --unattended --url "$REPO" --token "$TOKEN" --name "pma-eu-$(hostname)" --labels pma --work _work --replace
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
sudo ./svc.sh status | head -5

echo
echo "done. Next:"
echo "  1. GitHub → repo → Settings → Secrets and variables → Actions → Variables: PMA_RUNNER = self-hosted"
echo "  2. (optional) Secrets: PMA_RESIDENTIAL_PROXY = http://user:pass@gate.provider:port"
echo "  3. Actions → Nightly collection → Run workflow with sources=green-acres, limit=20 — a twenty-second smoke test from this address"
echo "  Public IP of this box (attach an Elastic IP so it never changes): $(curl -fsS https://checkip.amazonaws.com || true)"
