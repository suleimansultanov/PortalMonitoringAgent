# PortalMonitoringAgent — project index (for Claude & devs)

Market intelligence agent for real estate agencies. Collects listings from
property portals, deduplicates the same property across them, tracks what
changes over time, and matches new stock against a client's buyers.

First client: **Med-Estates**, 14 communes in the Gulf of Saint-Tropez.
Built as a product, not a one-off — see "Tenancy" below.

> Read this file before grepping the tree. Keep it in sync when tables, routes
> or lib modules change. Background research lives in
> `../LeadEstateVault/vault/Portal-Monitoring-Research.md` — per-portal findings,
> robots.txt verdicts, legal position.

## Stack
- **Framework:** Next.js 15 App Router, React 19, TypeScript, Tailwind v4.
- **DB:** Postgres (Supabase) via **Drizzle ORM** (`src/lib/db/schema.ts`).
- **Migrations:** hand-written idempotent SQL in `drizzle/`, applied by
  `src/lib/db/migrate.ts`. **`drizzle-kit generate` is not used** — see the
  comment at the top of the migrate script.
- **Jobs:** Inngest. **Storage:** S3 for raw pages. **Auth:** next-auth v5, see below.
- **Parsing:** cheerio. Structured markup first, selectors last.

## Tenancy — the load-bearing decision
Market data is shared, client data is scoped.

`portal_listings`, `properties`, `portal_agencies` and the event log carry **no
client column**. A villa is the same villa whoever is watching it. Only
`clients`, `client_sources` and (later) prospects and reports are per-client.

Two clients on the same coast therefore means **one crawl, not two** — which
matters, because several portals granted written permission on the
understanding that we would be reasonable about load.

## Pipeline
1. **Discover** — per source, list what is live in the client's communes.
   Sitemap where one exists, index-crawl otherwise.
2. **Diff** — against yesterday's set. New → fetch. Gone → `delisted`. Same →
   fetch only if stale or the index shows a price change.
3. **Fetch** — store the page in S3 with a content hash. Never parse here.
4. **Parse** — one adapter per engine. JSON-LD → meta → selectors.
5. **Normalise** — EUR, INSEE, m², agency identity.
6. **Resolve identity** — merge listings into `properties`. See below.
7. **Emit events** — append-only. Every metric is derived from this.

## Deduplication
No portal publishes usable coordinates (the one that does rounds to a postcode
centroid). Two better signals were found instead:

- **Agency mandate reference.** Several portals publish it. The same reference
  appears on unrelated portals for the same property — verified: `Réf 70880`
  (Swixim) on both SeLoger and Etreproprio. Exact match, no threshold.
- **Description text.** Agencies write once in their CRM and it syndicates
  verbatim. Shingle/MinHash similarity is the fallback where no reference exists.

Every merge stores `match_confidence` and `match_signals` so it can be
questioned and reversed.

## Portal traps — these each cost real money to learn
- **Never use `sku` as a listing key.** Maisons et Appartements puts the
  *agency* id there. Keys come from the URL.
- **JamesEdition: take `@type: Product` only.** Ten anonymous `House` blocks per
  page are the "similar listings" widget; a naive parser invents ten phantoms.
- **Prices from markup, never from the page.** JamesEdition renders EUR as USD
  for display. Parsing the screen invents a price change on every FX move.
- **Propriétés Le Figaro geo is a postcode centroid.** Store it, never match on
  it. Also filter out the `/location-vacances/` branch — that is holiday rental.
- **Superimmo serves an intermittent CAPTCHA.** Do not build around it; the
  route is a partner agreement. Med-Estates already advertises there.

## Events — there is no `sold`
A portal shows a listing *disappearing*. That happens when it sells, when the
owner withdraws it, when the agency's subscription lapses, and when it moves to
a competitor. We cannot tell which. Anything in the UI implying otherwise must
be labelled an estimate.

Partial fix available: **DVF** (data.gouv.fr) publishes real French transaction
prices, geolocated, back to 2014. Asking price next to what actually sold is
stronger than anything a portal can give.

## The abort guard — do not remove
If a source returns far fewer listings than yesterday, the run **aborts and
emits no `delisted` events** (`portal_runs.aborted_reason`). A blocked crawl
otherwise looks like the entire market delisting overnight. That takes a week to
notice and months to clean out of the reports.

**Its blind spot, and the rule that covers it.** The guard only sees *how many*
listings came back, never *from where*. A pass over two communes returns a
healthy count and passes the guard — and then delists every other commune,
because they were absent from `discovered`. So the baseline in `run.ts` is
filtered to the communes the pass actually visited (`inThisPass`). Any future
change that narrows what a run looks at — a commune subset, a price band, a
single agency — has to narrow the baseline the same way, or it will delist
everything outside its own window while the guard reports success.

## Auth — closed by default
Every page and every API route is behind a login. The rule lives in
`src/middleware.ts`, not in the individual files: a check that must be
remembered on each new screen is one that will eventually be forgotten on one,
and the forgotten one is the leak.

The config is **split in two on purpose**:

- `src/lib/auth/config.ts` — edge-safe. No database, no Node built-ins. This is
  what `middleware.ts` imports. Putting a `pg` or `bcryptjs` import in here
  breaks the build with an error that names neither file.
- `src/lib/auth/index.ts` — Node only. The Credentials provider, bcrypt, and
  the query against `users`.

Exempt paths are listed in `PUBLIC_PREFIXES` and in the middleware matcher.
**`/api/inngest` must stay exempt** — it authenticates with its own signing key
and has no cookie; putting a login in front of it does not harden anything, it
silently stops the job runner.

Sessions are JWTs, so `users.active = false` stops the *next* sign-in, not the
session already in a browser. Rotating `AUTH_SECRET` is what ends every session
now. Accounts are created from the terminal — there is no sign-up page:

```
npm run user:create -- --email=… --role=admin   # prints a generated password once
npm run user:create -- --list
npm run user:create -- --email=… --deactivate
```

Deploying the app for a client: `docs/DEPLOY.md`.

## Commands
`npm run dev` · `build` · `typecheck` (run after edits) · `db:migrate` ·
`db:studio` · `test` · `user:create`

## Gotchas
- **`ENCRYPTION_KEY` must be identical across local, preview and production.**
  They share one database. A mismatch makes every encrypted setting unreadable
  and surfaces as "Unsupported state". This has already bitten the sibling
  project; do not repeat it.
- Zod-parse at every DB and network boundary — no `as` casts on fetched data.
- Honour each source's `crawl_delay_ms`. It comes from their robots.txt.
- `portal_sources.permission_note` records *why* we are allowed to collect from
  a source. Fill it in. The day someone asks, the answer needs to be next to the
  thing doing the collecting.

## Related
- **LeadEstateVault** (`../LeadEstateVault/vault`) — sibling project. The db
  client, S3 helpers, settings store, crypto and auth guards were ported from
  there, along with the Inngest patterns (`syncFathomCalls`, `extractCallCard`)
  that this pipeline mirrors.
