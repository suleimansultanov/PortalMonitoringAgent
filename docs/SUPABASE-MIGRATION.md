# Moving to the leadestate Supabase

Production currently runs on a **personal** Supabase project, and the collector
writes to a Postgres on the laptop. Both move: one database, in the leadestate
account, written by the collector and read by the API.

## The approach, and why not a straight copy

We **rebuild on the new project from the local database**, not clone the
personal one.

The local Postgres is the more complete of the two — the deployed demo has only
ever seen what `sync-to-supabase.sh` last pushed, and the handoff of 31 August
records it as two days behind. Cloning the personal project would move a stale
copy and then need the fresh data pushed on top anyway.

Everything the local database does not hold is either reproducible in one
command (`db:seed`, `user:create`) or small enough to carry by hand.

## Before you start: what only exists on the old project

`sync-to-supabase.sh` deliberately never touches `users`, `clients` or
`settings`, so nothing has been copying them either way. Run this **against the
personal Supabase** and look at it before going further:

```sql
select 'users' t, count(*) from users
union all select 'buyers',        count(*) from buyers
union all select 'buyer_matches', count(*) from buyer_matches
union all select 'market_reports',count(*) from market_reports
union all select 'settings',      count(*) from settings;
```

Accounts are recreated with a command. Seeded test buyers are recreated with
`npm run seed:buyers`. Anything else with a real count is data somebody made,
and it needs a plan before you continue.

## Steps

**1. Back up both sides.** There are no backups on the Supabase free plan.

```bash
./scripts/dump-data.sh backup-local-$(date +%F).sql
# and a dump of the personal project, from its dashboard or with pg_dump
```

**2. Create the project** in the leadestate account. Keep it in the same region
as the Vercel deployment — `DEPLOY.md` §4 explains why those two must stay in
step.

**3. Carry `ENCRYPTION_KEY` across unchanged.** Not a formality: `settings`
rows are encrypted with it, and a different key makes every one of them
unreadable with an error that says `Unsupported state` and points nowhere near
the cause. Copy the existing value.

**4. Keep `.env.local` pointing at the LOCAL database, and pass the new one
per command.**

This is the step most likely to go wrong, and it goes wrong quietly.
`sync-to-supabase.sh` and `dump-data.sh` read `DATABASE_URL` from `.env.local`
as their **source** — the local Postgres holding the collected market. Repoint
that file now and step 7 dumps the new empty database over itself.

So: hold the target in a shell variable, and switch `.env.local` only at the
very end.

```bash
export SUPA="postgresql://…session-pooler…:5432/postgres"
```

**No `sslmode` in the string, deliberately.** It means different things to the
two clients that read it: to libpq (`psql`, `pg_dump`) `require` is "encrypt,
do not verify the chain"; to `pg-connection-string` it is currently an alias for
`verify-full`, which does verify — and Supabase's pooler presents a certificate
that does not chain to a root Node trusts. Putting it here fails every node step
with `SELF_SIGNED_CERT_IN_CHAIN` while psql keeps working, from one string.

It also overrides the explicit `ssl` config in `db/client.ts`, cancelling the
`rejectUnauthorized: false` that file sets on purpose.

Node gets TLS from `client.ts`, which decides by host. Give libpq its own with
`PGSSLMODE=require` on the individual `psql` and `pg_dump` commands.

**Check the override actually takes before relying on it**, because the scripts
load `.env.local` through `@next/env` and a pre-set variable winning is a
behaviour, not a guarantee:

```bash
DATABASE_URL="$SUPA" npm run db:info
```

It must report the Supabase host. If it reports `localhost`, the file won an
argument with the environment — edit `.env.local` for steps 5–6 and put it back
before step 7.

**5. Build the schema.**

```bash
DATABASE_URL="$SUPA" npm run db:migrate
```

**5a. Carry the `clients` row across BEFORE seeding, with its UUID intact.**

This step is not optional and the order matters. `sync-to-supabase.sh` copies
`client_sources`, `buyers`, `buyer_matches` and `market_reports` — every one of
which references `clients.id` — while deliberately never copying `clients`
itself. `npm run db:seed` on an empty database mints a **new** UUID for the
client, so the sync in step 7 would then load children pointing at a client that
does not exist, and abort on the foreign key (`ON_ERROR_STOP=1` is set).

Take the row from the **local** database, because that is where the market data
being synced comes from and its children carry that UUID:

```bash
pg_dump "$LOCAL_URL" --data-only --no-owner --table=public.clients   | psql "$NEW_URL" -v ON_ERROR_STOP=1
```

**5b. Now seed.**

```bash
DATABASE_URL="$SUPA" npm run db:seed
```

Safe in this order: the seed matches on `clients.slug`, finds the row you just
loaded, and leaves its id alone. It also no longer overwrites the client's
commune list — see the note in `seed.ts`.

**6. Switch the sources on.** `seed.ts` inserts every source disabled and never
turns one back on, which is how a scheduler ends up collecting nothing and
reporting success:

```sql
update portal_sources set enabled = true
where key in ('green-acres','superimmo','etreproprio','smc','figaro','luxuryestate');
```

**7. Push the collected market** from the laptop:

```bash
./scripts/sync-to-supabase.sh "$SUPA"
```

Source is `.env.local` — still the local database, which is the point of step 4.

**8. Recreate the accounts and issue a key.**

```bash
DATABASE_URL="$SUPA" npm run user:create -- --email=mark@med-estates.com --role=admin
DATABASE_URL="$SUPA" npm run key:create -- --client=med-estates --name="production"
```

**9. Switch `.env.local` over, then check.**

Now, and not before: the collector should write to Supabase from here on.

```bash
npm run nightly -- --check
```

**Confirm RLS actually landed on every table.** The dashboard toggle enables it
on tables created *after* it was switched on, so this is the check that the
ordering held:

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by 1;
```

Every row must say `true`. Any `false` is a table the trigger did not reach:
`alter table <name> enable row level security;`

It will name a wrong connection string, a missing Chromium, a source with no
subscriber, and an empty enabled list — in seconds, rather than an hour into a
run.

**10. Move Vercel** to the new `DATABASE_URL` and confirm the property count
matches what step 7 pushed.

## Traps

**Pooler choice.** The pool sends `statement_timeout` as a startup parameter,
and PgBouncer in transaction mode rejects unknown startup parameters —
`unsupported startup parameter: statement_timeout`. If step 9 fails that way,
use the session pooler for the collector. It is the right choice for a
long-running process anyway.

**The 10-second query timeout** was set against a loopback connection. Once
queries cross a network it is worth watching: clustering reads every listing in
a commune at once, and that is the query most likely to find the ceiling first.

**Nothing merges.** `sync-to-supabase.sh` empties the market tables on the
target and reloads them. That is correct for derived data and destructive for
anything else, which is why it leaves `users`, `clients` and `settings` alone.

**It is a sync, not a migration.** It assumes both sides already agree on the
`clients` row. That assumption holds between two databases that have been in
step for months and fails on a database created this morning — which is what
step 5a exists for.

## After

The collector fills the database the client is already looking at, so
`sync-to-supabase.sh` leaves the daily cycle. It stays useful for one thing:
reloading a target after a bulk change.

Raw pages remain on the laptop in `.pages/`. They move to object storage when
the collector does — see [Architecture](https://github.com/suleimansultanov/PortalMonitoringAgent)
and `docs/NIGHTLY.md`.
