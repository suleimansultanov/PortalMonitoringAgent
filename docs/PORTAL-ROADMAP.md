# The remaining portals, and what turns this into a product

Written 2026-08-29, after two portals were collected for real. `PIPELINE.md`
says how to add a portal; this says **which ones, in what order, and why** — and
argues that the order follows from one observation.

---

## The observation everything else follows from

From `PIPELINE.md`, learned the expensive way:

> Five of the fourteen portals answer *yes* to "may we" and *no* to "can we" on
> their **index** pages while serving **listing** pages fine.

Parsing is not the bottleneck. Writing an adapter is about a day, most of it
reading markup, and the shape is fixed: one file, one row, JSON-LD first. What
actually blocks a portal is **finding the URLs** — the search and index pages
sit behind the WAF, the detail pages do not.

So the roadmap is not "write nine more parsers". It is **three ways to discover
URLs**, applied to engines rather than sites.

---

## Route 1 — sitemaps. Free, and already built.

`runner/sitemap.ts` walks an index, follows shards, filters by commune slug and
respects a limit. It is tested. `smc.ts` already uses it and falls back to index
crawling.

Five portals block search and publish a sitemap. That enumeration is something
they put out **deliberately, for machines** — it is the least contentious way to
find out what exists, and it needs no browser, no permission negotiation and no
extra request budget.

**The part that is being left on the table:** `walkSitemap` already returns
`lastmod` per entry, and nothing uses it.

That single field solves two problems that came up this week:

- **Newest-first collection.** Superimmo's index has no sort parameter, so a
  night of collecting returns a random slice by age — 63 listings spread from
  September 2025 to August 2026, only ten of them from the last month. Ordering
  discovery by `lastmod` gets freshness without depending on any portal's sort
  parameter, which is one fewer thing that can be renamed under us.
- **Green-Acres has no dates at all.** Its adapter deliberately leaves
  `published_at` null rather than filling it with the crawl time. `lastmod` is
  not a publication date and must never be stored as one — a price edit moves
  it — but it is an honest ordering signal, which is what discovery needs.

Switching Green-Acres from index crawling to its sitemap also removes the `p_n`
pagination dependency, which has already produced a "page 2 repeated page 1"
warning. That failure mode is silent truncation: every commune capped at 24
listings, looking like a thin market.

**Do this first. It is the cheapest capability in the list and it is half
written.**

### Measured 2026-08-29: Green-Acres cannot take this route

Their `sitemap.xml` is served, the `.gz` shards open, and `lastmod` is current
(same-day, unlike SMC's five-month-old dates). None of that helps: the index
holds fourteen shard families, all of them either property-type sections
(`main-house`, `main-land`) or city landing pages (`cities-house/1..8`), and a
shard contains **no `/fr/properties/` URLs at all**. Green-Acres publishes its
SEO pages to search engines and not its listings, so there is no per-listing
`lastmod` to order by and no sitemap discovery to replace the `p_n` pagination
with.

Three requests to find out, against a day of writing against an assumption.

**And it matters less than it looked, which is the more useful lesson.**
Freshness ordering only pays where a pass cannot reach the whole market.
Green-Acres and Etreproprio are collected in full every run — everything new is
found because everything is found. The portal where ordering is worth real money
is **Superimmo**, the one we cannot finish: ~2 min per listing, ~80 h for the
gulf, so what gets collected first is what the client sees. That is where the
next question about ordering belongs, and it is a question about their index
cards, not about sitemaps.

## Route 2 — a browser, for index pages only

`runner/browser.ts` exists — Playwright, explicitly with no stealth plugins, no
`navigator.webdriver` patching, no fingerprint spoofing. It is **not wired into
the runner**: it needs a `fetchMode: "browser"` flag per source and a branch in
`run.ts`. Roughly an hour. Permission for browser use was granted.

The discipline that keeps it cheap: **use it for discovery only.** SMC,
LuxuryEstate and Etreproprio refuse the plain client on entry and then serve
listing pages fine. So a browser opens dozens of index pages per run, and the
ordinary polite fetcher does the thousands of detail pages. Running every fetch
through a browser would multiply time, memory and page weight for no gain.

This unblocks three adapters that are already written, and SMC covers two sites.

## Route 3 — asking. Replaces crawling entirely.

Written permission is on file from **AVIV, Groupe Figaro, ZPG and SMC**. None of
it is technical access: their bot protection does not know about the letter, and
that gap has not been closed with any of them.

**Superimmo is the one worth pushing now.** It answers 429 to essentially every
request — 34 throttles for 33 listings, even at a 120-second spacing, which is
the configured ceiling. Slowing down further buys nothing; their limit is below
any crawl rate. Med-Estates already advertises there, and a raised limit
requested by a paying client is an ordinary commercial conversation. It turns
eighty hours of nights into an evening.

Ranked by what it costs us, asking is the cheapest of the three and the slowest
to arrive. Start the conversations in parallel with the engineering; do not
sequence behind them.

---

## Order of work

Engines, not sites — nine adapters cover thirteen sites, and three pairs share
an engine (AVIV: SeLoger + Belles Demeures · SMC: Maisons et Appartements +
Résidences Immobilier · Green-Acres + Vizzit).

1. **Wire the browser into discovery** (~1 h). Unblocks SMC, LuxuryEstate,
   Etreproprio — three written adapters, four sites.
2. **Use `lastmod`, and move Green-Acres to its sitemap.** Freshness ordering
   everywhere, and one silent-truncation risk removed.
3. **Probe the nine never-inspected portals** — `npm run probe` before writing a
   line of adapter. The answer to "can we" decides whether it is a day of work
   or a conversation.
4. **DVF** (below).
5. **Superimmo nights**, or the partner conversation, whichever lands first.

---

## The thing that is not a portal, and matters more than three of them

**DVF** — data.gouv.fr publishes real French transaction prices, geolocated,
back to 2014, Var included. A download, not a crawl: no robots.txt, no WAF, no
permission, no rate limit, no adapter.

Every portal answers the same question — what is being asked. DVF is the only
source that answers **what was actually paid**. Asking price beside achieved
price is a claim no competitor scraping the same thirteen sites can make, and it
partially repairs the product's most awkward gap: a portal cannot tell us why a
listing disappeared, so there is no `sold` event and there never will be.

It costs nothing in crawl budget and competes with nothing else on the list.

---

## What makes it a product rather than a scraper

The collection is the commodity. These are the parts that are not:

**Config, not forks.** A new portal is a file and a row. The moment a portal
earns a branch inside `run.ts`, the fourteenth costs as much as the first.

**The safety floor has to hold before a source goes nightly.** Every new source
multiplies the blast radius of the same two bugs. Both are documented and one is
still open:

- the delist baseline must be scoped to what the pass actually visited
  (fixed 2026-08-28 — it would have wiped a commune on the second night);
- the adapters used to swallow index-fetch errors and `break`, so a 5xx on page
  4 of 7 read as the end of the commune and delisted everything unseen
  (fixed 2026-08-29 — `DiscoverContext.incomplete(insee, reason)`. Every exit
  from a pagination loop that is not "the results ran out" now names the
  commune it could not finish, and the runner shields exactly that commune's
  listings from delisting. Per commune rather than per pass, so one flaky page
  cannot freeze delisting across a whole portal — which would stop protecting
  the data and start hiding it. Three cases report: a failed fetch, pagination
  that repeats itself, and the page ceiling reached while listings were still
  arriving.)

**Honesty is the feature.** The overview screen states what is missing as
prominently as what is there, matches against invented buyers are excluded from
the count, and "new this week" refuses to answer until there is a week of
history behind it. An agent will not act on a number they cannot check, and the
first unexplained one that turns out wrong kills the feature however good the
arithmetic behind it.

**Deduplication improves with every portal.** Each additional source is another
cross-reference on the same property, and a merge is what lets a dated Superimmo
listing retro-date an undated Green-Acres one. Coverage is not just breadth; it
is the mechanism by which the data gets better.

**One crawl, many clients.** Market data carries no client column, so a second
agency on the same coast costs zero extra crawling. Cost scales with geography,
never with clients sold — which is the whole commercial argument.
