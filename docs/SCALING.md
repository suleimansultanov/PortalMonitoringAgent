# Scaling: what actually runs out, and when

The instinct is that one service serving many client instances will run out of
capacity and need more servers. That instinct is right about the shape and wrong
about the bottleneck — and the difference decides where money goes.

**Serving the data is nearly free. Collecting it is the wall, and it is a wall
that more servers do not move.**

---

## The numbers we actually have

From the Ramatuelle collection, measured rather than estimated:

| | Measured |
|---|---|
| Properties in one commune | ~160 |
| Green-Acres page weight | 815 kB |
| Superimmo page weight | 145 kB |
| Green-Acres throughput | ~1 s per listing (their robots.txt) |
| Superimmo throughput | **~2 min per listing** (their rate limiting) |
| One commune, one portal | 159 pages, 127 MB, 169 s |

Extrapolating to the client's twelve communes:

- **~2 000 properties** per portal across the gulf
- **Green-Acres full crawl: ~35 minutes**
- **Superimmo full crawl: ~66 hours**

That gap is the whole story.

---

## What does not scale, and why it does not matter

**Read traffic.** An agency has five to twenty agents. Ten clients at fifteen
agents each is 150 people, opening a few pages a day: call it 5 000 requests per
day, which is **0.06 requests per second**. A €20 VPS handles four orders of
magnitude more than that. Postgres on the same box will not notice.

**Database size.** Even at national scale — fifty clients, five hundred communes,
half a million properties — that is a small Postgres. The indexes we have already
(commune + status, agency + reference) are the ones the screens use. A properties
table of half a million rows with those indexes answers in single-digit
milliseconds.

**Deduplication and matching.** Deduplication is O(n²) *within one commune*: a
few hundred listings means a few hundred thousand comparisons of plain
arithmetic — under a second. Matching is a full cross product of buyers against
properties, which at 500 buyers × 50 000 properties is 25 million comparisons,
also seconds. Both are batch jobs nobody is waiting on.

So the answer to "will one service handle the requests" is **yes, and by an
enormous margin, for years.**

---

## What actually runs out

### 1. Crawl throughput — and servers do not fix it

Superimmo returns 429 on almost every request and asks for a 60-second pause.
That is not our CPU, our bandwidth or our connection. It is their policy about
how fast anyone may read their site.

**Adding servers makes this worse, not better.** Two machines crawling Superimmo
in parallel is two machines asking twice as fast — which is precisely the
behaviour their rate limiter exists to stop, and the fastest route from "slow" to
"banned". The same is true of proxies and rotating IPs, with the added problem
that those are evasion rather than engineering, and we hold written permission
from four of these portals precisely because we do not behave that way.

**But the daily cost is small, and only the first backfill is not.** Worth the
arithmetic, because the difference decides whether this needs a partnership or
just a week of patience:

| Superimmo, 12 communes | Time |
|---|---|
| Walking the index pages (60 pages) | **2.0 h** |
| Genuinely new listings (~3/day) | 5 min |
| **Every night, after the first crawl** | **~2 hours** |
| **First backfill, 2 000 listings** | **66 hours** |

Two hours a night is nothing: start at 01:00, done before 03:00. The rate limit
does not get in the way at all once the baseline exists.

Green-Acres, at its one-second delay, is **one minute a night**.

So the answers, in order of what actually needs doing:

1. **Spread the first backfill.** Two communes a night finishes the gulf in a
   week. No permission, no negotiation, no hardware — just not doing it all at
   once. This is the whole fix
2. **Ask, if it can be had cheaply.** Med-Estates advertises on Superimmo, and a
   raised limit requested by a paying client is an ordinary conversation. Nice to
   have; not required
3. **Take the feed if offered.** Several portals give partners a data file. One
   nightly download replaces the crawl entirely and is what they would rather we
   did anyway

**One thing we do not know yet:** whether Superimmo enforces a *daily* quota on
top of its short-window limit. `Retry-After: 60` suggests a rolling window rather
than a cap, but that only gets settled by the first long night. If there is a
daily cap, the backfill spreads over more nights — it does not become impossible.

### 2. Coverage, not client count

This is the part the shared-data design already solves, and it is worth being
explicit about because it changes the sales conversation.

`portal_listings`, `properties` and `portal_agencies` carry **no client column**.
A villa in Ramatuelle is the same villa whoever is watching it.

- **A second client in the Gulf of Saint-Tropez costs zero extra crawling.**
  They read the same rows
- A client in Nice costs a new set of communes — and then a second Nice client
  is free again

So crawl cost scales with **geography covered**, not with **clients sold**. Ten
clients in one region is nearly the same work as one. That is a good business to
be in, and it is a direct consequence of a schema decision rather than luck.

### 3. Storage

Raw HTML at ~500 kB average:

- One full gulf backfill, two portals: **~2 GB**
- All fourteen portals: **~14 GB**
- Daily increments: **~30–100 MB/day**, so ~35 GB/year

On S3 that is under a euro a month. Not a constraint — but worth trimming
anyway, because we read maybe two kilobytes out of each 815 kB page. Stripping
scripts, styles and base64 images on save cuts it by roughly 80%, exactly as it
did for the committed test fixtures.

---

## What breaks first, in order

1. **A portal's patience.** Long before any hardware limit. Guarded by per-source
   crawl delays, adaptive backoff on 429, and stopping on 403
2. **The first backfill of each new region.** Hours to days, once per portal.
   Needs a machine that can run for hours — which GitHub Actions cannot, at a
   six-hour job limit
3. **O(n²) deduplication**, if a client ever brings a market with five figures of
   listings in one commune. Paris arrondissements would do it. The fix then is
   MinHash banding instead of pairwise scoring; the limit is documented in
   `resolve.ts` so nobody has to rediscover it
4. **Read traffic** — realistically never, at this customer profile

---

## What to actually buy, and when

**Now — one small server, and it is not for capacity.**

GitHub Actions works for daily increments but caps jobs at six hours, which no
first backfill will fit inside. A €20–40/month VPS running the collector on cron
removes that ceiling and gives a stable IP the portals can allowlist — which
matters more than any amount of CPU, because an allowlisted slow crawler beats a
fast blocked one.

**Later — separate the collector from the app.**

Not for load. For **blast radius**: a crawl that hangs or eats memory should not
be able to take down the screens agents are looking at. That is the honest reason
to split them, and it is worth doing before the first client depends on the
product, not after.

**Read replicas, sharding, caches — no.**

Not on the horizon at this customer profile, and adding them early buys
complexity nobody can debug at three in the morning in exchange for headroom
nobody needs.

---

## The rule of thumb

> Money spent on **more machines** buys nothing here.
> **Patience** buys the backfill. **Partnerships** buy the comfort.

More hardware does not move any limit that binds. What the first backfill needs
is a machine that can run unattended for a few hours a night across a week — a
€20 VPS, not a cluster.

A feed or a raised limit from a portal is still worth having: it turns a week of
nights into a file download, and it does it with the portal's blessing rather
than at the edge of their tolerance. But it is an improvement to a plan that
already works, not a precondition for one.
