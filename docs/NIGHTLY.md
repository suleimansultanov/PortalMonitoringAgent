# The nightly run

One command, safe to hand to a scheduler:

```bash
npm run nightly
```

It collects every **enabled** source, one process at a time, clusters the
result, and leaves a summary a person can read in ten seconds.

```bash
npm run nightly -- --force              # rehearse: ignore the enabled flag
npm run nightly -- --sources=figaro,smc # a subset
npm run nightly -- --parallel=2         # two portals at once, never two passes at one portal
```

## First: preflight

```bash
npm run nightly -- --check
```

Seconds, no portal touched. It verifies the database, lists every source with
its crawl delay, fetch mode, subscribed communes and nightly refresh ceiling,
checks that Playwright's Chromium is actually on disk, that `logs/` is writable,
and that the user-agent still names you rather than pretending to be a browser.

Every one of those fails the same way on night one as on night ninety, and
without this each would be found an hour into a run, one source at a time, in a
log read the next morning. The Chromium check is the sharpest: five of seven
sources need a real browser, and without the binary each walks its entire
discovery phase before failing on its first listing.

Run it after any change to the environment — a new `DATABASE_URL`, a machine
that has never collected before, a Node upgrade that emptied the browser cache.

## Before the first scheduled night: switch the sources on

`npm run db:seed` inserts every source with `enabled = false` and never turns it
back on, and `npm run collect` has always passed `force: true`. So the project
can collect happily by hand for weeks while a scheduler would find nothing at
all to do.

```sql
update portal_sources set enabled = true
where key in ('green-acres', 'superimmo', 'etreproprio', 'smc', 'figaro', 'luxuryestate');
```

`npm run nightly` refuses to report a quiet success when the list comes back
empty — it says so and exits 1 — but it is easier to switch them on than to
read about it at eight in the morning.

## The schedule

```bash
./scripts/install-nightly.sh              # 03:00 daily, this Mac
./scripts/install-nightly.sh --uninstall
launchctl kickstart -k gui/$(id -u)/com.leadestate.pma-nightly   # run it now
```

A user LaunchAgent, not a system daemon: it runs as you, with your files and
your network, which is what a collector reading your own database needs. No
sudo, nothing outside your home directory.

03:00 local — outside the hours a French property portal has real visitors, and
inside the 01:00–05:00 CET window LuxuryEstate asked for. Asleep at 03:00 means
the job runs on wake; powered off means at next login. A missed night is
collected late rather than skipped, because the diff is computed fresh every
pass and a late pass catches up on its own.

`scripts/nightly.sh` is what the agent actually calls, and it exists for three
things that bite only under a scheduler:

- **PATH.** launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin`. Node from
  Homebrew or nvm is on neither, so the job would die with "npm: command not
  found" at 03:00 and the first sign would be an empty `logs/` a week later.
- **The environment.** Next loads `.env.local` for the app; nothing loads it for
  a launchd job.
- **Sleep.** This is a laptop. Without `caffeinate` the machine suspends
  mid-crawl, the browser session dies with it, and the portal sees us vanish
  part-way through a pass we asked permission for.

It also appends one line per night to `logs/history.log`. The per-night
directory holds the detail; that file is the only place that answers "has this
been running at all?" in one screen, which is the question that comes up most.

## Pointing the collector at Supabase

`DATABASE_URL` is the only thing that changes — the collector does not care
where Postgres is. Two traps specific to this repository:

**SSL is only configured under `NODE_ENV=production`** (`db/client.ts`). The
nightly runs from the CLI, where it is not set, so the `ssl` option is absent.
Put `?sslmode=require` in the connection string, or the connection is refused
or silently unencrypted. `npm run nightly -- --check` is how you find out in two
seconds instead of at 03:00.

**Pick the pooler deliberately.** The pool sets `statement_timeout` as a startup
parameter, and PgBouncer in transaction mode rejects unknown startup parameters
with `unsupported startup parameter: statement_timeout`. If `--check` fails that
way, use the session pooler for the collector. The 10-second `query_timeout` is
also worth watching once queries cross a network rather than a loopback —
clustering reads every listing in a commune at once.

**Take a backup first.** There are no backups on the Supabase free plan:
`./scripts/dump-data.sh backup-$(date +%F).sql`.

Once this is done `sync-to-supabase.sh` leaves the daily cycle — the collector
fills the database the client is already looking at.

## What it leaves behind

```
logs/2026-09-01/summary.txt     twelve lines. Did the night work?
logs/2026-09-01/summary.json    the same, for an alert or a graph
logs/2026-09-01/figaro.log      every line that source printed
logs/2026-09-01/nightly.log     the orchestrator's own narration
logs/latest -> 2026-09-01
```

Three files because there are three questions, asked at three magnitudes: *did
the night work* / *which source* / *what exactly*. A Superimmo pass prints
thousands of lines, and a summary living inside them is one nobody reads by the
second week — at which point "the night was quiet" goes back to being the only
signal, which is the failure this exists to prevent. A blocked crawl is quiet
too.

Thirty nights are kept, then dropped.

## Reading a failure

`summary.txt` grades each source `ok` / `warn` / `FAILED`:

- **FAILED** — the pass did not finish: aborted by the sanity guard, threw, or
  stopped part-way through fetching. The picture of that portal is incomplete.
  This is the only condition that sets a non-zero exit code.
- **warn** — individual listings could not be fetched, or nobody subscribes to
  the source. Some of that is ordinary: a URL that 404s between discovery and
  ingestion is a listing that sold this afternoon, and LuxuryEstate refusing 43
  of 1688 on 31 August was a good run. The ratio is printed; judge it.
- **ok** — clean.

Each row carries its `run_id`, which is the join back into `portal_runs`. Files
answer "what happened last night"; the table answers "how often has this portal
cut us off this month", and that is the one that decides whether we write to the
portal.

**A trap worth knowing:** a pass whose fetching stopped early is still recorded
as `status = 'done'` in `portal_runs`, with the reason only in `error`
(run.ts, step 7). Query `where error is not null`, not `where status <> 'done'`.

## Why the night is a predictable length now

Nightly cost is discovery (fixed, every index page, every night) plus new
listings (usually dozens) plus refreshes of pages we already hold. The third
used to be unbounded: everything past `REFRESH_AFTER_DAYS = 7` came due at once,
and because the corpus was collected in a burst it would have gone stale in a
burst — every LuxuryEstate listing fetched on 31 August, all 1645 due on
7 September, two and a quarter hours of re-fetching pages that had not changed.
Superimmo's 2800 at ten seconds is seven and three quarter hours, which is not a
night.

A matching content hash does not save that time: `unchanged` in `ingest.ts` is
only reachable after the page has been downloaded.

So the refresh queue is now ordered oldest-first and capped by a time budget —
`refreshBudgetMinutes` in a source's config, default 45. New listings are never
capped. The cost is that a listing may go longer than seven days between
refreshes; the alternative is a pass that overruns and gets killed part-way.

`summary.txt` prints the leftover as `backlog`. **A backlog that does not come
down over several nights means the budget is too small for that portal** — that
is the number to watch.

## Where it should run

Undecided. The script is host-agnostic on purpose: cron on a server, launchd on
a laptop and a CI job all invoke the same command and read the same files, so
this is a scheduling decision rather than a rewrite.

Two things bear on it. Raw pages are an asset — `.pages/` is 4.7 GB and
`npm run reparse` is built on it — so a runner with an ephemeral disk needs S3
configured first. And several portals granted access on the understanding they
could identify our traffic, and one asked to verify it at their end — which is
easier from a fixed address. Read the IP note at the top of
`.github/workflows/collect.yml` before choosing.
