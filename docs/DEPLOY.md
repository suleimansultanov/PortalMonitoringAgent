# Deploying the client-facing app

The app is the dashboard and `/api/v1`, which the client's own application
reads (`API.md`). It runs on Vercel. The **collector** is not deployed with it:
it runs every night on GitHub Actions (`.github/workflows/collect.yml`) and
writes into the same database the app reads. See `SCALING.md` for why that
split is deliberate.

> The app never touches S3: gallery images are hotlinked `og:image` URLs stored
> in the rows themselves. It reads what the nightly wrote and writes only its
> own rows (sign-ins, match status, when a key was last used). So a deployment
> needs a database and nothing else.

---

## One database

Since 2026-08-29 there is **one** Postgres, on Supabase, and everything uses it:

| Who | Where its connection string lives | Pooler |
|---|---|---|
| The deployed app and `/api/v1` | Vercel environment variable `DATABASE_URL` | transaction (6543) |
| The nightly collector | GitHub Actions secret `DATABASE_URL` | session (5432) |
| Scripts, migrations and `psql` on the operator's machine | `DATABASE_URL` in `.env.local` | session (5432) |

Nothing is copied between databases and there is no sync step. What the
nightly writes is what the client reads, from the moment it is written.

Three consequences, each of which has a cost if it is forgotten:

- **`.env.local` is production.** Every `npm run` command that writes —
  `db:seed`, `reparse`, `db:reset-data`, `user:create`, `key:create` — acts on
  the client's live data. There is no staging copy to try a change on first,
  which is why the abort guard in `runner/run.ts` matters more now than it did.
- **`ENCRYPTION_KEY` must be identical in all three places.** `settings` is
  encrypted with it. A different key anywhere makes every encrypted setting
  unreadable there, and the error says "Unsupported state" while pointing at
  nothing (`CLAUDE.md`, Gotchas).
- **The backup is a command.** The Supabase Free plan takes none; see §8.

Before 2026-08-29 the collector wrote to a Postgres on the laptop, and
`scripts/sync-to-supabase.sh` pushed the market across: it emptied eleven
tables on the target and reloaded them. Its source was `.env.local`, which has
been production ever since, and it asked for no confirmation. Pointed at
production it would have truncated those tables and reloaded them from a
temporary dump deleted on exit — a load that failed half-way left the market
empty, with no copy anywhere. It was removed on 2026-10-15, together with
`scripts/migrate-to-supabase.sh`, which prepared a new database for it and
ended by telling you to run it. Moving to a new database is §3.

---

## 0. Whose accounts, and what it costs

Standing up the first deployment on a personal Supabase and Vercel account is
fine, and moving it to Lead Estate later is cheap — **provided two decisions are
made correctly now**, because they are the two that cannot be undone by a
transfer. Both are in §1 and §4; they are repeated here because they are easy to
skip past.

| | Free | Paid |
|---|---|---|
| **Vercel** | Hobby — but the fair-use terms restrict it to **non-commercial, personal use**. A demo for a paying client is commercial. | Pro, $20 / developer seat / month |
| **Supabase** | 500 MB database, 2 projects, and **the project pauses after one week of inactivity** | Pro, $25 / month — 8 GB, never pauses |

The pause is the one that bites. A client who opens the link nine days after the
meeting gets a dead page, and the impression is that the product broke. For a
demo shown and discussed within the week, free is fine. For a link left with the
client, it is not.

### Moving to Lead Estate later

**Supabase** supports transferring a project between organisations, Free
included. The conditions that matter:

- The transfer **cannot cross regions.** Whatever region is chosen in §1 is the
  region it stays in, forever. Choose the one Lead Estate would want.
- A project with an **active GitHub integration cannot be transferred.** Do not
  connect Supabase's GitHub integration to this project. It is not needed — the
  migrations run from the repo by hand.
- The receiving organisation must be under its project cap (two on Free).

**Vercel** does not need a transfer at all. The repository is the source of
truth, so re-importing it under the Lead Estate team takes about five minutes;
the only manual part is re-entering the three environment variables from §4.

Nothing about the data has to be redone in either case.

---

## 1. Supabase project

Only when there is no database yet, or when the one there is being replaced
(§3). Today's deployment already has one.

Pick a European region and write down which one — **a project transfer cannot
change it**, so the choice outlives whoever owns the account, and the Vercel
function region in §4 has to match it.

The first project was created in **`eu-west-1` (Ireland)**. Frankfurt
(`eu-central-1`) would sit marginally closer to the Var, but the difference is
a few milliseconds and not worth recreating a project over. What matters is
that both halves agree.

Save the database password when it is shown; it is not shown again.

From **Project Settings → Database** take two connection strings:

- **Session pooler** (port 5432) — for `.env.local`, the GitHub secret, `psql`,
  `pg_dump` and migrations.
- **Transaction pooler** (port 6543) — for the app. This is what goes in Vercel.

They are not interchangeable. Migrations through the transaction pooler fail in
ways that look like network errors.

**No `sslmode=` in either string.** `db/client.ts` turns TLS on by itself for
any host that is not loopback; an `sslmode` in the string overrides that and
breaks it. `NIGHTLY.md` has the detail.

Do **not** enable the GitHub integration — see §0.

## 2. The schema

```bash
npm run db:migrate
```

Hand-written, idempotent migrations from `drizzle/`, applied in order and
recorded in `_migrations`. With `.env.local` pointing at production, that is
where they go. For a database not yet in `.env.local`, prefix the command with
`DATABASE_URL="<session pooler string>"` and check with `npm run db:info` that
the override took.

**The nightly applies migrations too.** `collect.yml` runs `db:migrate` before
every night, so a merged migration reaches the database that night even if
nobody runs it by hand. Vercel deploys `main` the moment it is pushed, though,
and the app does not migrate. Code that needs a new column is live before the
night that would add it — so run `npm run db:migrate` before pushing that code,
not after.

## 3. Moving to a new database

For replacing the database — a new project, a new account, a new region. Not
for anything routine.

```bash
./scripts/dump-data.sh backup-$(date +%F).sql
DATABASE_URL="<new session pooler string>" npm run db:migrate
PGSSLMODE=require psql "<new session pooler string>" -v ON_ERROR_STOP=1 -f backup-YYYY-MM-DD.sql
```

The dump reads `.env.local` (the current database) and holds every table:
accounts, the client and its subscriptions, API keys, the Stream.Estate V1
meter and its per-commune state, and the market. It dumps **one table at a
time, in foreign-key order**: a data-only dump has no deferred constraints, so
a row pointing at a table that has not been loaded yet is rejected outright,
and `pg_dump` gives no promise that it will honour the order of `--table`
flags. `src/lib/db/dumpData.test.ts` checks the list against the schema.

**Do not run `db:seed` on the new database first.** The dump already holds
every row the seed would write, under the UUIDs everything else points at. A
seeded row with a fresh UUID stops the load on the first duplicate.

`ON_ERROR_STOP=1` matters. Without it psql reports failures and carries on, and
you end up with a database silently missing a table — which then reads as a
quiet market rather than a failed import. `PGSSLMODE=require` gives psql
encryption without chain verification, which is what the Supabase pooler needs.

Check before trusting it: `DATABASE_URL="<new session pooler string>" npm run
db:info` must report the same row counts as `npm run db:info` against the old
one. Anything lower means part of the load failed.

Then switch all three places in one sitting: `.env.local` with
`./scripts/use-database.sh` (it prompts with the input hidden and
percent-encodes the password), the GitHub secret `DATABASE_URL`, and Vercel's
`DATABASE_URL` (the new project's transaction pooler). If the region changed,
`vercel.json` moves with it (§4).

**Do it outside the nightly's hours, and check Actions first.** Anything written
to the old database between the dump and the switch is not in the new one. A
night's collection can be run again; an `api_usage` row cannot — a lost V1
meter row is money the cap no longer counts. The schedule is 21:00 UTC and
GitHub starts it between 00:30 and 03:30 UTC.

## 4. Vercel

Import the GitHub repository, then set three environment variables for
Production **and** Preview:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **transaction** pooler string (port 6543) |
| `ENCRYPTION_KEY` | **copy the existing value from `.env.local` verbatim** |
| `AUTH_SECRET` | a fresh one: `npx auth secret` |

`ENCRYPTION_KEY` is not a free choice. It is the key the rows in `settings`
were encrypted with, and the same value sits in `.env.local` and in the GitHub
secret `ENCRYPTION_KEY`: one database, one key. A different key here makes
them unreadable on the deployment, and the error says "Unsupported state"
while pointing at nothing.

`AUTH_SECRET` is the opposite — it may and should differ per environment. It
only signs session cookies. Changing it signs everyone out of that environment.

`vercel.json` pins functions to **`dub1` (Dublin)**, because the Supabase
project sits in `eu-west-1`, Ireland. The platform default is `iad1`,
Washington DC — leave it there and every database query crosses the Atlantic
and comes back.

**These two must be kept in step.** Hobby allows one region, which is all this
needs. If the database is ever recreated elsewhere, move this with it:
`eu-central-1` → `fra1`, `eu-west-3` → `cdg1`, `eu-west-2` → `lhr1`.

Nothing else is needed. S3, Stream.Estate keys and the crawler variables belong
to the collector, which does not run here.

## 5. Accounts, and the client's key

There is no sign-up page. With `.env.local` pointing at the database:

```bash
npm run user:create -- --email=mark@med-estates.com --role=admin
```

The generated password is printed once. Run the same command again to reset it.

The client's application authenticates to `/api/v1` with a key, not an
account:

```bash
npm run key:create -- --client=med-estates --name="production"
```

Printed once; hand it over by a channel that is not chat. `API.md` has the
rest — rotation, `key:list`, `key:revoke`.

## 6. Check before sending the link

- Open the deployment signed out. It must land on `/login` and show nothing else.
- `curl -s -o /dev/null -w '%{http_code}' <url>/api/properties` → **401**, not 200.
- `curl -s -o /dev/null -w '%{http_code}' <url>/api/v1/status` without a key → **401**.
- Sign in. The overview should show last night's collection, and the warning
  banner about test buyers — that banner is doing its job, leave it.
- Check one listing page renders its gallery. Broken images mean the portal
  moved the files, not that the deployment is wrong.

## 7. The collector

`collect.yml` reads its database from the repository secret `DATABASE_URL`,
which is the **session** pooler string of this same database — the collector
holds a connection across a whole pass, which the transaction pooler will not
give it. The other secrets it needs are listed in the workflow's `env:` blocks.

Read the IP-address warning at the top of that workflow before changing where
it runs, and `NIGHTLY.md` for what a night leaves behind and how to read it.

## 8. Backups

**There are no backups on the Supabase Free plan.** Before anything that
rewrites rows in bulk — `reparse`, a migration, a first run against a new
source — take one:

```bash
./scripts/dump-data.sh backup-$(date +%F).sql
```

It reads `.env.local`, so it dumps production, and only reads. The file is a
copy of other people's listings plus the client's accounts and key hashes:
`.gitignore` keeps `backup-*.sql` out of the repository, and it should not
travel further than the machine that made it.

Restoring is §3 with the dump you already have: into a migrated, unseeded
database, with `ON_ERROR_STOP=1`.
