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
- **Jobs:** GitHub Actions — `.github/workflows/collect.yml` runs
  `src/lib/portals/nightly.ts`. (Inngest was removed on 2026-10-15: nothing
  sent it an event.) **Storage:** S3 for raw pages. **Auth:** next-auth v5, see below.
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

**The rule the client agreed to (2026-10-15):** same price to the euro, same
commune, floor areas within 20%, plots within 20% where both state one — houses
only; flats keep the Carrez band. The cluster guard (`splitIncoherent`) judges
from the median and by majority of rows, not by one row's plot or type: on
2026-10-18, 126 of 149 remaining duplicates were one odd row deciding for a
whole cluster. Measure any rule change dry first (`npm run dedup:check`), then
`npm run dedup:audit` — it replays the resolve over what is stored and lists
pairs the rules call one house that are still two. Flats keep the Carrez band,
but a gap of one square metre or less never vetoes a text-backed pair (portals
round 51,97 to 51; 89 cards the client hid as duplicates on 2026-11-08 were
this), and never helps a measurements-only one. The same line is in every
nightly summary; its first number (anomalies) should stay near zero. Two
narrower rules were tried and reverted with numbers on 2026-10-19; the notes
are beside the constants in `score.ts`.

**Switched-off collectors join by mandate only** (`staleSourceIds` in
`clusterCandidates`, 2026-10-26). Their rows stay active forever at the price
they had when the collector stopped; by size or text that stale price glued
homes now at different prices into one card — 53 listings of about a dozen
homes in one Sainte-Maxime property, Med-Estates' own among them. Measured dry
before it went in: +135 cards back, ~13 new duplicates, welded 18 → 5.

## Portal traps — these each cost real money to learn
- **Never use `sku` as a listing key.** Maisons et Appartements puts the
  *agency* id there. Keys come from the URL.
- **JamesEdition: take `@type: Product` only.** Ten anonymous `House` blocks per
  page are the "similar listings" widget; a naive parser invents ten phantoms.
- **Prices from markup, never from the page.** JamesEdition renders EUR as USD
  for display. Parsing the screen invents a price change on every FX move.
- **Propriétés Le Figaro geo is a postcode centroid.** Store it, never match on
  it. Also filter out the `/location-vacances/` branch — that is holiday rental.
- **Green-Acres renders for the visitor.** From a US address (the GitHub
  runner) the headline price is in dollars and sizes are in sq ft / acres. Never
  store the headline unless the page says EUR: read `offers` in the JSON-LD,
  else their "Prix en euros" line. Convert imperial by the unit printed beside
  the figure. 535 listings went without a price for three weeks over this.
  **Its icons are `<svg>` since 2026-10-16** (they were `<em>`): sizes are read
  off the icon CLASS on any tag. A tag-specific selector nulled floor area, plot
  and rooms on every new Green-Acres and Vizzit page for ten nights (1 592
  listings) while the parse reported only "partial".
- **Figaro Immobilier's results carry Propriétés Le Figaro listings** (`isPlf`,
  `recordLink` on proprietes.lefigaro.fr) — about a third of every commune.
  They belong to the `figaro` source; filing them under both counts one
  advert as two portals'. Its commune token for Le Plan-de-la-Tour has no
  article (`plan+de+la+tour+83120`); `le+plan…` answers 410.
- **Vizzit is Green-Acres' engine with twice the catalogue**, not a mirror.
  Same ids, same page, same parser (`adapters/vizzit.ts` reuses it) — so a fix
  to one is a fix to both, and so is a break. **A quarter of its index is other
  portals' adverts** (idealista, SeLoger, Rightmove, Belles Demeures…), the
  portal printed where the agency goes, and the GitHub runner is answered 410
  for every one of them: ~1 000 a night for ten nights, "new" again each time
  because a failed page is never stored. They are marked `syndicatedFrom` and
  left unfetched; a 404/410 on a listing never held is `unserved`, not a
  failure. Agencies' own sites are NOT marked — some of those are served.
- **An advert names its neighbours.** "À 15 minutes de Saint-Tropez" sent a home
  in Sainte-Maxime to Saint-Tropez, because `resolveCommune` searched the text too:
  Bien'ici states every place as "Sainte-Maxime - Sémaphore - Nartelle", never a
  bare name, so 362 of its 3 032 live rows were filed under the wrong commune, and
  the client found them (2026-11-05). The stated place decides; the text is only
  for a district of that commune. A wrong commune also blocks every merge. A
  stored row is not re-filed by a better rule until its page changes:
  `npx tsx src/lib/portals/recommune.ts` replays the rule over what is stored (dry
  unless `--apply`), moving a property whole so it keeps its id.
- **Zoopla Overseas leads with sterling and has no agencies.** Store only the
  listing's own EUR figure (`currencyCode`), never the pound. Every listing is
  syndicated by Properstar in English: do not store it as the agency, and
  expect weak deduplication — price, surface and commune are all there is.
- **Stream.Estate is an aggregator, not a portal.** Its rows are stored under
  `stream-estate`, but the advert is on Belles Demeures, Leboncoin, Idealista…
  Show the portal read off the URL (`portalOf.ts`), never their source slug:
  they file every `.co.uk` domain as `co` — Rightmove hid behind it.
- **Stream.Estate V1 is billed per property returned, on the client's card.**
  15 000 a month, EUR 0.003 each beyond. Every request goes through the meter
  in `portals/streamV1.ts` (ledger in `api_usage`, cap checked before each
  paid page, no retries); nothing may call `api.stream.estate` around it. The
  `stream-estate-v1` source reads the stock once and then changes only
  (`changesOnly`): no full sweep, ever — four of them would be the month.
  So V1's copy of an unchanged advert keeps the date it was first read. Where
  V2 carries the same portal on the same card, the feed sends the copy seen most
  recently (`servedListings`); until 2026-11-10 it sent whichever came first, and
  37 % of SeLoger read as "not re-checked for 14 days" from rows read last night.
- **Etreproprio's "similar listings" widget is not the gallery.** Its pictures
  sit under the same `/classified/image/` path, as `<img data-nuxt-img
  src="/_ipx/…">`: other homes, in Clamart or Istres. Taken as photos, they reached
  751 of the client's cards and were the cover of 13, and the client's contract
  refused all 764 under whichever portal led the card, SeLoger first (fixed
  2026-11-07). Keep only absolute `https://` photos; never make `/_ipx/` absolute.
- **Superimmo serves an intermittent CAPTCHA.** Do not build around it; the
  route is a partner agreement. Med-Estates already advertises there.
- **A gulf agency's homes abroad arrive filed under its own town.** Immocenter
  (Le Plan-de-la-Tour) sells Phuket; Vizzit and Stream.Estate V1 both placed
  its villas in 83094, V1 with the agency's coordinates. The client saw them
  (2026-10-27). `abroad.ts` reads the advert's own URL and text; ingest keeps
  such a row in no commune and on no property. Grow its list only after
  running the marker over the whole table — "pierre de Bali" is a pool stone.

## Data health — what the client will conclude, on our side first
The client's app (vault, written by Tomaz, `src/lib/ops/data-health*.ts`) judges
our feed every night on Settings → Data health. `src/lib/health/` runs the same
rules here, as of vault commit eaed31c: `npm run health` reads only, and the
nightly stores a run and adds one line to the summary (`data_health_checks`,
drizzle/0012, kept 60 days). It reports only: in the nightly it runs after the
collectors, the resolve and the audit, and a failure or a run past 15 minutes
turns the line into `FAILED` while the night carries on to its summary.

Every row has **two verdicts**. `vault` is the client's rule at the client's
threshold, copied warts and all so it can be checked against their screen.
`ours` differs only where we measured the rule misreading the collector, and
`note` says how. Do not "fix" a `vault` verdict: if their rule changes, update it
and the commit named in `rules.ts`.

The feed is read through `snapshot()`, the function behind /api/v1/properties, so
it judges what the client is sent. The ten-second limit on every query is why the
history reads one commune at a time. About 40 MB and 90 s; `--feed=<file>`
re-judges a saved feed for nothing.

Only the portal block is copied (17 kinds of check, 157 of the client's 196 rows
on 2026-11-03). Not reproducible: "kept the last good value" and the ×5 price
hold, which need the last read the client stored.

Calibrated 2026-11-04 against the client's screen of the same evening, on the same
night's data. Exact: all 24 "not re-checked" rows, all 26 "new listings" rows,
6 556 properties, 26 portals, the 5 red portals. Within a row: bedrooms. Close:
values dropped 774 / 779 theirs first, price per m² 96 of 4 344 / 93 of 4 312,
duplicates hidden 1 573 of 6 663 / 1 494 of 6 556 (their count includes the agency's
own 107 Apimo cards, which never reach our feed). Known gaps: 48 "kept" rows, and
four portals of one or three contract rows, because two aggregators' rows tie on
`lastSeenAt` and the winner is whichever the read returned first. If a change moves
these apart with nothing changed on the client's side, suspect the copy.

**Triage and the morning retry (2026-11-10).** Each run is compared with the
last one stored (`triage.ts`): *needs a look* is flagged by `ours`, marked NEW
when the run before did not flag it; *explained* is flagged by the client's rule
only, and its note says why; *cleared* was flagged before and is by neither now.
That is the `triage:` line in the summary; a NEW row, or a check that failed,
also opens (or comments on) a GitHub issue labelled `data-health` — job
`report-health` in collect.yml, from `logs/latest/health-alert.txt` — because a
green night's summary is read by nobody. Our new-listings verdict compares the
last three nights with the same three nights of up to four earlier weeks
(`sameNightsOfWeek`): portals publish little over the weekend, and a seven-day
median reads every Monday as a broken collector. A source whose night aborted
or errored after a good night is collected once more, twenty minutes after the
night ends (`.github/workflows/retry.yml` on `workflow_run`; the 06:30 UTC cron
is only a fallback, GitHub started it at 14:36 on 2026-11-11). Rule in
`portals/retryRule.ts`, rehearse with
`npx tsx src/lib/portals/retryAborted.ts --at=<iso>`; a hand run with `probe`
proves the job may dispatch, collecting nothing. It is never retried after
two failures running, never outside the hours it asked for (LuxuryEstate), and
never if it is V1 (billed per item) or Superimmo.

## Events — there is no `sold`
A portal shows a listing *disappearing*. That happens when it sells, when the
owner withdraws it, when the agency's subscription lapses, and when it moves to
a competitor. We cannot tell which. Anything in the UI implying otherwise must
be labelled an estimate.

Partial fix available: **DVF** (data.gouv.fr) publishes real French transaction
prices, geolocated, back to 2014. Asking price next to what actually sold is
stronger than anything a portal can give.

**A repost is not a new listing.** Some feeds re-issue one advert under a new id
every few days (Bien'ici's `mgc-` ids for BONAPARTE PROMOTION TOULON: one lot,
eight ids from 1 Oct to 8 Nov). Ingest therefore lets a listing seen for the
first time take over the row of the same source's advert it repeats (same
agency, title, price to the euro, floor area, commune): first one this pass is
about to delist (`IngestDeps.departing`, the swap inside one night), else one
delisted in the last 14 days (`relisted`, `payload.repostOf`). The row keeps
its id, history and card; old ids go to `raw.previousExternalIds`. Rows stored
before 2026-11-08 were left as they are.

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

**The opposite failure: a row the index never shows again.** Where a portal's
index is itself a window (Vizzit Sainte-Maxime: 479 of the 1 470 it states), the
commune is marked incomplete every night, so nothing in it is delisted for being
unseen, and the refresh queue only takes what the index showed. A row outside
the window was never looked at again: 1 585 Vizzit rows unseen for 14 days on
2026-11-08, half of them gone from the portal. Adapters that parse their own
listing pages set `verifyUnseenPerNight` (Vizzit 300, Etreproprio 150): that
many shielded rows past the refresh window are re-read by their stored URL each
night, oldest first; 200 refreshes them, 404/410 delists them by name, unless
nearly every answer is "gone" (`trustGone`). Never for a source whose records
come from discovery or a meter (Bien'ici, Stream.Estate, V1).

Those had the mirror-image gap: a record in every night's index, skipped by
the refresh queue because the index said "unchanged" and rationed like a page
to download, so `last_seen_at` lagged up to 30 days (755 Bien'ici rows "not seen
for 14 days", all in that night's index). `planRefresh` re-reads a record
discovery holds as soon as it is past the refresh window: no request, outside
the budget, first.

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

Exempt paths are listed **once**, in `PUBLIC_PATHS` / `PUBLIC_ROOTS`
(`config.ts`, read by `isPublicPath` in the `authorized` callback): `/login`,
`/api/auth/*`, `/api/v1/*` (it has its own key check, `lib/api/guard.ts`),
`/docs` and `/docs/openapi` (deliberately public, 2026-09-04), and the build's
assets. Exact paths and roots, never patterns. The middleware matcher only
skips `_next/static`, `_next/image` and `favicon.ico`, for cost;
`src/middleware.test.ts` fails if it ever skips anything the list does not make
public. Until 2026-10-15 the matcher was the list, and its `.*\.png$` tail let
`/portal/x.png` past the login.

**Signed in is not the question; which client is.** Every screen calls
`requireClient()` and every internal route `clientForRequest()`
(`src/lib/auth/tenant.ts`, Node only), and every read in `lib/api/queries.ts`
takes that scope as its first argument: the client's buyers, matches and
reports by id; the market narrowed to its communes and subscribed sources, as
its API key is. An account with no client is sent to `/no-access` (403 from an
API route) — never shown everything. Meta-tests in `lib/auth/scope.test.ts`
and `lib/api/queries.test.ts` fail if a page, a route or a read forgets.

The client is read from `users` on every request, not from the JWT, so linking,
moving or deactivating an account takes effect on its next page load. The
session cookie itself stays valid until it expires (12 h); rotating
`AUTH_SECRET` is what ends every session now. Accounts are created from the
terminal — there is no sign-up page:

```
npm run user:create -- --email=… --role=admin --client=med-estates   # prints a generated password once
npm run user:create -- --email=… --client=med-estates --link          # link, password unchanged
npm run user:create -- --list
npm run user:create -- --email=… --deactivate
```

**Rate limits and the request journal** (`src/lib/api/rateLimit.ts`, tables
`rate_limits` and `api_request_log`, drizzle/0010): 120 requests a minute per
API key, 30 unauthorised requests per 10 minutes per address, 10 failed
sign-ins per 15 minutes per email+address (50 per address). Fixed windows
counted in Postgres — on Vercel a counter in memory dies with the function.
Over the limit: `429` with `Retry-After`. The limiter **fails open**: if it
cannot write its count, the request goes through. Every `/api/v1` request is
journalled with its key (null when refused), path and status; v1 routes are
written as `export const GET = keyedRoute(…)` (`lib/api/guard.ts`), and a
meta-test fails on any that is not.

Deploying the app for a client: `docs/DEPLOY.md`.

## Commands
`npm run dev` · `build` · `typecheck` (run after edits) · `db:migrate` ·
`db:studio` · `test` · `user:create` · `health` (what the client's Data health
will say, and what we say) · `dedup:check` (dry run of the resolve)
· `dedup:audit` (duplicates left after it) · `resolve -- --communes=<insee>`
· `reparse -- --source=<key> --since=<YYYY-MM-DD> --active --no-resolve`
(re-derive fields from stored pages after a parser fix; pages come down from
S3, ~500 kB each — narrow it, and warn before running it on mobile data)

## Gotchas
- **`ENCRYPTION_KEY` must be identical across local, preview and production.**
  They share one database. A mismatch makes every encrypted setting unreadable
  and surfaces as "Unsupported state". This has already bitten the sibling
  project; do not repeat it.
- Zod-parse at every DB and network boundary — no `as` casts on fetched data.
- **Every status-like column has a `CHECK`** (`status`, `type`, `kind`, `role`,
  `mode`, `parse_status`, `criteria_source`, `discovery_mode`; drizzle/0011).
  A new value in code — an event type, a run status — needs a migration that
  widens the constraint, or its first write fails mid-nightly.
  `src/lib/db/checks.test.ts` compares each list with the union type it comes
  from and fails first.
- Honour each source's `crawl_delay_ms`. It comes from their robots.txt.
- `portal_sources.permission_note` records *why* we are allowed to collect from
  a source. Fill it in. The day someone asks, the answer needs to be next to the
  thing doing the collecting.
- **`property_type` is one of the client's words** (`portals/propertyType.ts`:
  Maison, Appartement, Terrain, Commerce, Bureau, Parking, Immeuble, or null).
  The client's matching compares a buyer's type to ours by exact word, and a
  mismatch disqualifies: until 2026-11-08 a "Maison" search never saw a "Villa",
  "House" or "Immobilier" card. A generic label is read from the title; nothing
  named stays null, because "not published" does not disqualify. The portal's
  own label is `raw.propertyTypeRaw`. Never store a portal's word as the type.
- **Facts from the prose fill empty fields only** (`portals/textFacts.ts`): a
  living area stated as "N m² habitables" (`raw.areaFromText`), never "villa de
  250 m²", which is as often the plot. An advert for a liquor licence alone, and
  a developer's page for a whole programme (`/programmes/` in its path: the
  cheapest lot's price, the smallest lot's area, the same programme on three
  resellers' sites), are kept like a home abroad, in no commune and on no card
  (`raw.notAProperty`).
- **A model reads what adverts state only in their prose** (`portals/aiFacts.ts`,
  `aiFactsRun.ts`, Claude Haiku 5.5): bedrooms, living area, plot, rooms, and the
  type behind a generic title ("Achat : Parking" over a 73 m² flat). Written only
  into empty fields, only when the quote is in the advert and the number in the
  quote, marked in `raw.ai`; a listing is read once. Backfill 2026-11-10: 5 569
  adverts for $0.80. The nightly reads what it touched, capped at
  `AI_FACTS_CAP_USD`; it needs the `ANTHROPIC_API_KEY` secret, and skips without.
  `npm run ai:facts -- --estimate` costs nothing; a paid run needs `--max-usd`.
- **A null `priceEur` is not "on request".** Only `raw.priceOnRequest = true`
  is — four adapters set it (Green-Acres, Figaro, Figaro Immobilier, SMC). The
  rest of the nulls are prices the parser did not read, and the screens and
  `/api/v1` say so (`priceOnRequest`). On 2026-10-07, 170 of 228 nulls were
  unread, not withheld.

## Related
- **LeadEstateVault** (`../LeadEstateVault/vault`) — sibling project. The db
  client, S3 helpers, settings store, crypto and auth guards were ported from
  there. (So were its Inngest patterns, removed here on 2026-10-15 when the
  nightly moved to GitHub Actions.)
