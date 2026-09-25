# Running the nightly collector on AWS

One small EC2 box in Paris (`eu-west-3`) replaces GitHub's hosted runner. The
workflow, secrets, logs and Sunday full sweep do not change; only the address
the requests leave from does.

Why this box, in one line each:
- **EU address** — Green-Acres renders prices in the visitor's currency and a
  US runner got dollars (1 366 of 3 556 stored prices, found 2026-09-24).
- **Fixed address** (Elastic IP) — what SeLoger/AVIV and Figaro need to
  allowlist us, the way LuxuryEstate already does by header.
- **One hop to a residential proxy** for Figaro and JamesEdition only, which
  filter datacentre ranges wholesale (see `proxy` in `runner/browser.ts`).
  An EC2 address is a datacentre address too: **test before assuming**, step 4.

## 1. Launch (AWS console, 5 minutes)

- Region **Europe (Paris) eu-west-3**.
- AMI **Ubuntu Server 24.04 LTS**, instance **t3.small** (2 vCPU, 2 GB — the
  bootstrap adds 2 GB swap), storage **30 GB gp3**.
- Key pair: create one, keep the `.pem`.
- Security group: inbound **SSH (22) from your IP only**. Nothing else
  inbound; the runner only makes outbound connections.
- After launch: **Elastic IPs → Allocate → Associate** with the instance.
  That address is the one to give portals.

## 2. Bootstrap (on the box, once)

```
ssh -i key.pem ubuntu@<elastic-ip>
curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/aws/bootstrap-runner.sh -o bootstrap.sh
bash bootstrap.sh <RUNNER_TOKEN> https://github.com/<org>/<repo>
```

`RUNNER_TOKEN`: GitHub → repo → Settings → Actions → Runners → *New
self-hosted runner* → Linux → the token in the `./config.sh` line (one hour).

## 3. Point the workflow here (GitHub, 1 minute)

Settings → Secrets and variables → Actions:
- **Variables**: `PMA_RUNNER` = `self-hosted`. (Delete it, or set
  `ubuntu-latest`, to go back to GitHub's runners — that is the rollback.)
- **Secrets**, later, when Mark has the proxy account:
  `PMA_RESIDENTIAL_PROXY` = `http://user:pass@gate.provider:port`.

## 4. Measure before paying for a proxy

From the box, our own collectors print a verdict on this address in under a
minute each — no stealth, our user-agent, and they stop on the first refusal:

```
cd ~/actions-runner/_work/<repo>/<repo>   # after the first workflow run, or git clone
export CRAWLER_USER_AGENT="PortalMonitoringAgent/1.0 (+https://leadestate.com; suleiman@leadestate.com)"
node scripts/jamesedition-collect.mjs --limit=5
node scripts/superimmo-collect.mjs --limit=5
```

- Served → that portal needs no proxy from here; leave `proxyEnv` unset for it.
- 403 with a Cloudflare ray id → the address class is filtered, as expected;
  set `config.proxyEnv: "PMA_RESIDENTIAL_PROXY"` on that source in `seed.ts`,
  `npm run db:seed`, add the secret, run the same script with
  `HTTPS_PROXY=<proxy url>` to confirm, then a `limit=20` workflow run.

Superimmo answers 429 from every address; a proxy will not change that and
must not be tried for it. Its answer is the delta pass (already configured)
plus a night per full sweep.

## 5. Cost

t3.small on-demand in eu-west-3 ≈ USD 17/month running 24/7, Elastic IP free
while attached, 30 GB gp3 ≈ USD 3. The runner idles between passes; stopping
the instance by schedule would cut it to ≈ USD 6 but the runner must be up at
21:00 UTC, so leave it on until that is worth the automation.
