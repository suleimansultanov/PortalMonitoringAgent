# Deploying the client-facing app

For showing the product to Med-Estates. The **collector** is not deployed — it
keeps running from a laptop or a GitHub Action, writing into the same database
the app reads. See `SCALING.md` for why that split is deliberate.

> The app is read-only over the database. It never touches S3: gallery images
> are hotlinked `og:image` URLs stored in the rows themselves. So a deployment
> needs a database and nothing else.

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

Pick a European region and write down which one — **a project transfer cannot
change it**, so the choice outlives whoever owns the account, and the Vercel
function region in §4 has to match it.

The first project was created in **`eu-west-1` (Ireland)**. Frankfurt
(`eu-central-1`) would sit marginally closer to the Var, but the difference is
a few milliseconds and not worth recreating a project over. What matters is
that both halves agree.

Save the database password when it is shown; it is not shown again.

From **Project Settings → Database** take two connection strings:

- **Session pooler** (port 5432) — for `psql`, `pg_dump` and migrations.
- **Transaction pooler** (port 6543) — for the app. This is what goes in Vercel.

They are not interchangeable. Migrations through the transaction pooler fail in
ways that look like network errors.

Do **not** enable the GitHub integration — see §0.

## 2. Create the schema

From the repo, pointing at Supabase for one command only:

```bash
DATABASE_URL="<session pooler string>" npm run db:migrate
```

This runs the same hand-written migrations as local, in order. It is also the
first real test that the migration runner works against Supabase, which is worth
knowing before there is data to lose.

## 3. Move the collected data across

Two and a half thousand properties already exist in the local Postgres.
Re-crawling to fill Supabase would be about 47 minutes and a gigabyte of
somebody else's pages for data we already hold — do not do it.

```bash
./scripts/dump-data.sh          # writes pma-data.sql
```

The script reads `DATABASE_URL` from `.env.local` — the same string the
collector uses, not one typed from memory — and dumps **one table at a time, in
foreign-key order**. That is not fussiness: a data-only dump has no deferred
constraints, so a row pointing at a table that has not been loaded yet is
rejected outright, and `pg_dump` gives no promise that it will honour the order
of `--table` flags. Alphabetically, `buyer_matches` comes before `buyers`, which
fails. Adding a table to the schema means adding it to the list in the script,
after everything it references.

Load it:

```bash
psql "<session pooler string>" -v ON_ERROR_STOP=1 -f pma-data.sql
```

`ON_ERROR_STOP=1` matters. Without it psql reports failures and carries on, and
you end up with a database silently missing a table — which then reads as a
quiet market rather than a failed import.

Check before trusting it:

```bash
psql "<session pooler string>" -c \
  "select 'properties' t, count(*) from properties
   union all select 'portal_listings', count(*) from portal_listings
   union all select 'buyers', count(*) from buyers;"
```

The counts must match what `npm run db:info` reports locally. Anything lower
means part of the load failed.

## 4. Vercel

Import the GitHub repository, then set three environment variables for
Production **and** Preview:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **transaction** pooler string (port 6543) |
| `ENCRYPTION_KEY` | **copy the existing value from `.env.local` verbatim** |
| `AUTH_SECRET` | a fresh one: `npx auth secret` |

`ENCRYPTION_KEY` is not a free choice. Rows in `settings` were encrypted with
the local key and travelled across in the dump; a different key here makes them
unreadable, and the error says "Unsupported state" while pointing at nothing.

`AUTH_SECRET` is the opposite — it may and should differ per environment. It
only signs session cookies. Changing it signs everyone out of that environment.

`vercel.json` pins functions to **`dub1` (Dublin)**, because the Supabase
project sits in `eu-west-1`, Ireland. The platform default is `iad1`,
Washington DC — leave it there and every database query crosses the Atlantic
and comes back.

**These two must be kept in step.** Hobby allows one region, which is all this
needs. If the database is ever recreated elsewhere, move this with it:
`eu-central-1` → `fra1`, `eu-west-3` → `cdg1`, `eu-west-2` → `lhr1`.

Nothing else is needed. S3, Inngest and the crawler variables belong to the
collector, which does not run here.

## 5. Create the first account

There is no sign-up page. After the first successful deploy:

```bash
DATABASE_URL="<session pooler string>" npm run user:create -- \
  --email=mark@med-estates.com --role=admin
```

The generated password is printed once. Run the same command again to reset it.

## 6. Check before sending the link

- Open the deployment signed out. It must land on `/login` and show nothing else.
- `curl -s -o /dev/null -w '%{http_code}' <url>/api/properties` → **401**, not 200.
- Sign in. The overview should show the same property count as local, and the
  warning banner about test buyers — that banner is doing its job, leave it.
- Check one listing page renders its gallery. Broken images mean the portal
  moved the files, not that the deployment is wrong.

## 7. Afterwards: point the collector at Supabase

Until this is done, nightly collection still writes to the laptop and the
deployed app never changes. Set `DATABASE_URL` in the repository's GitHub
Actions secrets to the session pooler string, and the workflow in
`.github/workflows/collect.yml` fills the same database the client is looking at.

Read the IP-address warning at the top of that workflow first.

## 8. Keeping the demo up to date

The collector writes to the local Postgres; the deployed app reads Supabase.
They do not talk to each other, so the demo shows whatever was last pushed:

```bash
./scripts/sync-to-supabase.sh "<session pooler string>"
```

Empties the market tables on the target and reloads them from local. Run it
after a night of collecting, after `reparse`, or before showing anything to
anyone.

It deliberately leaves `users`, `clients` and `settings` on the target alone.
Accounts exist only where people log in — copying the local `users` table over
would delete the account you signed in with, and you would discover it at the
worst moment. `clients` is the UUID that `buyers` and `market_reports` hang
off, and recreating it on either side breaks both.

**There are no backups on the Supabase Free plan.** Before anything that
rewrites rows in bulk, take one — it is the same script that built the first
load:

```bash
./scripts/dump-data.sh backup-$(date +%F).sql
```
