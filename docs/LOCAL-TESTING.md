# Running a collection locally

No S3, no Vercel, no Inngest. Postgres in Docker and one command.

## 1. Database

```bash
docker run -d --name pma-pg \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:16
```

## 2. `.env.local`

Three lines are enough. With no S3 configured, fetched pages go to `.pages/` on
disk — which is the whole point of the local fallback: needing an object store
before you can run the collector once is how nobody ever runs it locally.

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
ENCRYPTION_KEY=<64 hex chars>
AUTH_SECRET=<32+ random chars>
```

Generate both:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
npx auth secret                                                            # AUTH_SECRET
```

`AUTH_SECRET` signs the session cookie. Changing it signs everyone out
immediately — which is also the only way to end a session before it expires,
because sessions are JWTs and are not stored anywhere we could delete from.

## 3. Schema and seed

```bash
npm install       # picks up the server-only stub — see below
npm run db:migrate
npm run db:seed
npm run user:create -- --email=you@example.com --role=admin
```

The last command prints a generated password once. There is no sign-up page —
every screen and every API route is behind a login, so without a user you get
the login form and nothing else.

The seed prints a coverage report. All three sources should read 12/12
communes. Anything less is a commune that will be silently absent from the
product, and it will look like a quiet market rather than a bug.

## 4. Smoke test

Start small. One commune, twenty listings, about a minute:

```bash
npm run collect -- --source=smc --limit=20 --communes=83101
```

Then widen:

```bash
npm run collect -- --source=smc --communes=83101,83119
npm run collect -- --source=all --limit=50
```

## 5. What to look at

The run ends with a report. **The null rates matter more than the counts.** A
run that "succeeded" while returning no price for two thirds of its listings
has not succeeded — that is precisely what a half-broken parser looks like from
the outside, and the counts will look fine.

Anything above 30% missing is flagged. Expect some legitimately: Etreproprio
publishes no floor area in its markup, so a share of its listings will have
none.

Then **open five listings side by side with the live pages.** Wrong-but-plausible
is the failure mode that survives longest — a price parsed from the wrong
element still looks like a price.

## 6. Useful queries

```sql
-- Did anything get merged across portals?
select p.title, p.source_count, p.price_eur
from properties p
where p.source_count > 1
order by p.source_count desc;

-- Why were two listings considered the same property?
select l.external_id, l.match_confidence, l.match_signals
from portal_listings l
where l.property_id = '<id>';

-- What did the run think it was doing?
select status, seen_count, new_count, gone_count, failed_count, aborted_reason
from portal_runs order by started_at desc limit 5;
```

## Notes

**The `server-only` stub.** `scripts/server-only-stub` replaces the real
package, which throws unless resolved under React's `react-server` condition.
That behaviour is right inside the app and fatal in a script — every one of
these commands imports modules marked `server-only` and would die on the first
import. Next.js enforces the server boundary itself, so the substitution costs
nothing. The Vault project does the same thing for the same reason.

**Where pages land.** `.pages/` locally, S3 when `S3_ENDPOINT` and `S3_BUCKET`
are set. The collector prints which on startup.

**Sources are seeded disabled.** The CLI runs them anyway when named directly —
the flag guards the scheduler, not a person who typed the command.

**Re-running is safe.** Everything is keyed on `(source, external id)`, so a
second run updates rather than duplicates. Re-run the seed after editing a
commune slug and the config updates in place.
