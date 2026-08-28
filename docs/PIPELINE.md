# How the pipeline works

Everything the product displays is read from Postgres. **No screen ever talks to
a portal.** Opening Listings, Matches or a property page runs SQL against data
that a collection run put there earlier — which is why the app is fast, why it
works offline, and why a portal being down does not take the product down.

---

## The short version

```
  portal site
      │  (1) discover — enumerate what is live right now
      ▼
  list of URLs
      │  (2) diff — which are new, which vanished, which are stale
      ▼
  URLs worth fetching
      │  (3) fetch — one request, honouring the portal's crawl delay
      ▼
  raw HTML ────────────────► saved verbatim to .pages/ (or S3)
      │  (4) parse — adapter turns HTML into fields
      ▼
  RawListing
      │  (5) normalise — commune → INSEE, agency → one row per real agency
      ▼
  portal_listings  ◄── one row per (portal, listing id)
      │  (6) events — compare with what we had, append what changed
      ▼
  portal_listing_events  ◄── append-only, every metric derives from here
      │  (7) resolve — the same villa on four portals becomes one thing
      ▼
  properties  ◄── what the product shows
      │  (8) match — score against buyers
      ▼
  buyer_matches
```

Steps 1–7 are `npm run collect`. Step 8 is `npm run match`.

---

## Where things are stored

| What | Where | Why there |
|---|---|---|
| Raw HTML of every page fetched | `.pages/pages/{source}/{date}/{id}.html`, S3 in production | So fields can be re-derived when a parser is fixed, **without asking the portal again** |
| One row per portal listing | `portal_listings` | The portal's own view: its price, its reference, its URL |
| Everything that changed, ever | `portal_listing_events` | Append-only. Days-on-market and price cuts exist only here |
| The deduplicated property | `properties` | What the screens show. One villa = one row, however many portals carry it |
| Agencies | `portal_agencies` | One row per real agency, matched on normalised name + postcode |
| Which portals we collect | `portal_sources` | Config: URL templates, commune slugs, crawl delay, permission note |
| Buyers and their briefs | `buyers` | Currently ten invented ones, flagged `is_test_data` |
| Proposed matches | `buyer_matches` | Score plus the reasons behind it |

**Market data carries no client column.** A villa in Ramatuelle is the same
villa whoever is watching it, so `portal_listings`, `properties` and
`portal_agencies` are shared. Only `clients`, `client_sources`, `buyers` and
`buyer_matches` are per-client. Two clients watching the same coast means one
crawl, not two — which matters, because the portals granted permission on the
understanding that we would be reasonable.

---

## The seven steps, in detail

### 1. Discover

`adapter.discover()` enumerates what is live. Two shapes:

- **index** — walk the portal's own commune pages, page by page
  (Green-Acres, Superimmo)
- **sitemap** — walk their published `sitemap.xml` (SMC)

Which one is not a preference. Five of the fourteen portals return 403 on their
search pages while serving individual listings fine, so for those the sitemap is
the only enumeration they actually publish.

Discovery yields `{ externalId, url }`. **The id always comes from the URL**,
never from a `sku` field — Maisons et Appartements puts the AGENCY id in `sku`,
and using it as a key collapses every BARNES listing into one row.

### 2. Diff

`diffListings()` compares what discovery found with what is already in
`portal_listings`, and splits it three ways: **added**, **present** (refetch only
if stale), **removed**.

It carries a `complete` flag. An interrupted crawl adds but **never** removes:
half a list is not evidence that the missing half was withdrawn.

`shouldAbort()` is the second guard. A source returning far fewer listings than
yesterday is being blocked, not emptying — so the pass stops and writes no
delistings. Four hundred false delistings take a week to notice and months to
clean out of the reports.

### 3. Fetch

One place in the whole project touches the network: `runner/fetcher.ts`.

- Honours the crawl delay from the portal's own robots.txt (Superimmo asks 10s)
- Identifies us in the user-agent, with a contact address
- **403 → stop.** That is a refusal; retrying is how a warning becomes a ban
- **429 → wait and continue.** That is "too fast", not "go away". The pacing
  ratchets up for the rest of the run and the listing is retried
- A 200 carrying a CAPTCHA is treated as a block, not as an empty page — parsed
  naively it would reach the diff as "this commune is empty"

Every page fetched is written to disk before anything parses it.

### 4. Parse

`adapter.parse(html, url)` is **pure**: HTML in, fields out. No network, no
database. That is what makes it testable against saved fixtures, and it is why
every adapter has a golden-file test.

Three outcomes:

- `ok` — everything we depend on is there
- `partial` — some fields missing, but price/agency/area enough to be useful.
  A listing with a price, an agency and no floor area still deduplicates, still
  appears, still carries price history
- `failed` — the page did not parse at all. The row and the HTML are kept

### 5. Normalise

Adapters return what the page says. Normalisation happens once, centrally:

- **Commune** → INSEE code. Portals spell it "Saint-Tropez", "St-Tropez",
  "SAINT TROPEZ", and agencies routinely label a Ramatuelle villa as
  Saint-Tropez. Twelve INSEE codes cover the client's fourteen labels — three of
  the fourteen are districts, not communes
- **Agency** → one row in `portal_agencies`, matched on normalised name plus
  postcode

### 6. Events

`computeEvents()` compares the new parse against the stored row and appends what
changed: `listed`, `price_changed`, `delisted`, `relisted`,
`availability_changed`.

Two rules that matter:

- **A null from a degraded parse is not a change.** "We could not read the
  price" is not "the price was removed"
- **There is no `sold` event.** A listing disappears when it sells, when the
  owner withdraws it, when the agency's subscription lapses, and when the mandate
  moves to a competitor. We cannot tell which, so we record what we saw

### 7. Resolve

The same villa appears on several portals. `resolveCommuneIdentities()` groups
them into one `properties` row.

Signals, strongest first:

1. **Same agency + same mandate reference.** Decisive. `mi103` on Green-Acres and
   `MI103` on Superimmo is the same property — this is what produced the first
   real cross-portal merges
2. Description similarity, after stripping the legally mandated Géorisques
   footer that every French listing carries
3. Price and floor area agreement

Clustering is global within a commune, not incremental: a new arrival can reveal
that two properties we thought were separate are one, because the third portal is
often the one carrying the reference that ties the first two together.

Every merge stores its confidence and its signals, and the property page shows
them. A dedup that cannot be questioned is a dedup nobody trusts the first time
it is wrong.

---

## Commands

| Command | What it does | Network? |
|---|---|---|
| `npm run collect -- --source=X` | Full pipeline for one source | **yes** |
| `npm run reparse` | Re-runs parsers over pages already on disk | **no** |
| `npm run match` | Scores properties against buyers | no |
| `npm run quality` | Missing-field report by source, type and ingest batch | no |
| `npm run db:reset-data` | Clears collected data, keeps config and buyers | no |
| `npm run fixture -- --url=… --name=…` | Saves one page as a test fixture | yes |
| `npm run probe` | Checks which portals actually serve us | yes |

`reparse` is the important one during development. A Green-Acres page is 815 kB;
one commune is 127 MB; the whole gulf is about a gigabyte. Fixing a parser cannot
mean re-downloading the market — and on a metered connection it cannot mean
downloading anything.

---

## Adding a new portal

Roughly a day per portal, most of it reading their markup rather than writing
code. **Config, not forks** — a new portal is a new file plus a row, never a
branch in the pipeline.

### Step 1 — find out whether they will serve us at all

```bash
npm run probe
```

Read their `robots.txt` first, and read it properly:

```bash
npm run fixture -- --url=https://example.fr/robots.txt --name=example-robots
```

Two different questions, and they have different answers:

- **May we?** — what robots.txt permits, and whether we hold written permission
- **Can we?** — whether their WAF actually serves our client

Five of the fourteen portals answer *yes* to the first and *no* to the second on
their index pages while serving listing pages fine. Assuming these are the same
question cost this project a day.

### Step 2 — capture real pages

```bash
npm run fixture -- --url=https://example.fr/annonce/12345 --name=example-detail
npm run fixture -- --url=https://example.fr/ville/ramatuelle --name=example-index
```

Captured **with the real collector**, so what lands on disk is exactly what the
adapter will see in production — not what a browser renders. Those differ more
than anyone expects.

**Look at more than one page.** Twice in this project a parser was written
against a single example and silently returned nothing on half the commune,
because the portal has several layouts for the same facts.

### Step 3 — write the adapter

`src/lib/portals/adapters/example.ts`, implementing `PortalAdapter`:

```ts
export const exampleAdapter: PortalAdapter = {
  key: "example",
  name: "Example Immobilier",
  hosts: ["example.fr", "www.example.fr"],
  discoveryMode: "index",       // or "sitemap"
  defaultCrawlDelayMs: 1_000,   // from THEIR robots.txt

  async *discover(ctx) { /* yield { externalId, url } */ },
  parse(html, url) { /* return { status, listing } */ },
};
```

Two rules the contract enforces:

- **Adapters do not fetch.** They are handed a `fetch` that applies the crawl
  delay and the user-agent. An adapter reaching for the network directly bypasses
  all of it, and the first sign would be the portal blocking us
- **Adapters do not normalise.** Return the commune as written and the price as
  published. Ten adapters each doing their own commune matching is ten places for
  Ramatuelle to end up under Saint-Tropez

Prefer JSON-LD (`application/ld+json`) where the portal publishes it — it
survives a redesign. Where it does not, key off labels and icon classes rather
than element positions.

### Step 4 — map the communes

Add the portal's slugs to `src/lib/portals/communePaths.ts`. **Read them off the
portal, never guess them.** A guessed slug returns an empty page, and an empty
commune reads as a quiet market rather than as a bug. `coverageReport()` prints
what is still missing.

### Step 5 — register and seed

```ts
// src/lib/portals/registry.ts
const ADAPTERS = [ …, exampleAdapter ];
```

Add a `sourceSeeds()` entry in `src/lib/portals/seed.ts` with the crawl delay,
the commune config, and a **permission note in plain words** — what their
robots.txt says, who granted permission and when. That lives in the database
rather than a wiki because the day someone asks, the answer needs to be next to
the thing doing the collecting.

### Step 6 — test against the fixtures

`src/lib/portals/adapters/example.test.ts`. Golden-file tests exist so a
redesign fails in CI, in a diff someone reads — rather than silently in three
weeks' reports where a missing column looks like a quiet market.

### Step 7 — a small live run, then check

```bash
npm run db:seed
npm run collect -- --source=example --communes=83101 --limit=20
npm run quality
```

`quality` splits missing fields by property type and by ingest batch — which
distinguishes an honest gap (a plot of land has no bedrooms) from a broken
selector, and a stale sample from a parser that is still wrong.

Then **open two or three listings and compare them to the live pages by hand.**
Wrong-but-plausible is the failure mode that survives longest.

---

## What is not automated yet

- **Scheduling.** A GitHub Actions workflow exists (`.github/workflows/collect.yml`)
  but the sources are seeded disabled. Turning collection on should be a decision
  someone makes, not a side effect of running a script
- **Buyer import.** `buyers` holds ten invented records flagged `is_test_data`.
  The real import waits on Med-Estates confirming how criteria are stored in
  GoHighLevel — structured fields or free text. That decides how the columns get
  filled; it does not change what they are, which is why everything downstream is
  already built
- **Superimmo at scale.** Two minutes per listing under their rate limiting. Fine
  for daily increments, impossible for a first backfill of twelve communes. Needs
  either an overnight server run or a raised limit from them
