# Portal Monitoring Agent — plan and decision log

**Status:** foundation built, collection not yet running.
**First client:** Med-Estates (Mark Daggers), 14 communes in the Gulf of Saint-Tropez.
**Last updated:** 2026-08-25

Companion documents: `portal-research.md` (per-portal findings, robots.txt
verdicts, legal position) and `../CLAUDE.md` (code map and the traps that will
bite a parser).

---

## 1. What this is

A market intelligence agent for real estate agencies. Three surfaces:

- **Listings** — what came on the market, deduplicated across portals.
- **Matches** — new stock scored against the agency's own buyers, with a draft
  message ready to send.
- **Reports** — how the market moved: days on market, price cuts, competitor
  activity.

Matches is the part that earns money. Reports is the part that impresses.
Listings is the part everything else stands on.

---

## 2. Architecture decision — collector and client app

**Decided 2026-08-25. Proposed to Tomaz, awaiting confirmation.**

Lead Estate's established model is one deployment per client, generated from a
template (`vault-template`, `dash-template`) into the client's own GitHub,
Supabase and Vercel. That is correct for Vault and Dashboard, where every byte
belongs to the client.

It is **not** correct for the collection half of this product, because what we
collect is market data. A villa in Ramatuelle is the same villa whoever is
watching it.

Concretely: a second client on the Côte d'Azur means two of our crawlers hitting
SeLoger nightly for overlapping areas. Those portals granted **written
permission** on the understanding we would be reasonable about load. If AVIV
notices, they withdraw it from both clients at once — a failure that happens
outside our code and cannot be fixed by shipping.

So, two pieces:

**Collector** — one shared service, ours, never customer-facing. Crawls,
parses, deduplicates, keeps price history. No branding, no client login, no UI.
Exposes one thing: properties in a set of communes, changed since a timestamp.
**This repository is the collector.**

**Client app** — one per client, from a template, exactly as Vault and Dashboard
are done today. Own repo, Supabase, domain and design tokens. Holds the client's
buyers, matches, sent proposals and report history. Reads market data from the
Collector.

Cost of the split: an API between the two, roughly a day.

Side effect worth naming: deduplication gets *better* with each client, not
worse. Every additional portal in the shared pool is another cross-reference on
the same property.

Known objections, recorded rather than dismissed: a client may ask whether
others see their data (market data shared, their buyers and matches not), and a
client wanting to take the product with them is cleaner served by a
self-contained instance — though the market data was never theirs.

---

## 3. Sources — where the data comes from

Thirteen portals, ten adapters. Three pairs share an engine: SeLoger and Belles
Demeures (AVIV), Maisons et Appartements and Résidences Immobilier (SMC),
Green-Acres and Vizzit. Full detail in `portal-research.md`.

Written permission obtained from **AVIV, Groupe Figaro, ZPG and SMC**
(2026-08-25), which covers the five portals whose robots.txt refuses automated
access. Permission is recorded per source in `portal_sources.permission_note`.

**Still outstanding:** technical access from those four — IP allowlisting, a
dedicated user-agent, or an export. Their bot protection does not know about the
letter. Without it we hit the same walls holding a permission we cannot use.

**Superimmo** publishes listing date, last-updated date and a price-drop flag —
the only portal that gives days-on-market and price cuts from day one instead of
after weeks of accumulation. It also serves an intermittent CAPTCHA. The route
is a partner agreement, not engineering: Med-Estates already advertises there.

---

## 4. What is built

- Project scaffold: Next.js 15, Drizzle, Inngest, S3, hand-written migrations.
- Schema — nine tables, `drizzle/0001_init.sql`.
- Ported from Vault: db client (with the Supabase pooler lessons), S3 helpers,
  encrypted settings store, crypto.
- Adapter contract (`src/lib/portals/types.ts`) — ten implementations, one shape.
- JSON-LD extraction with the phantom-listing guard.
- Commune resolution: 14 client labels → 12 INSEE codes.
- First adapter: **SMC**, covering two portals, with a golden-file test against a
  real saved page.

Verified by execution: 21 checks across commune resolution and title parsing.

---

## 5. What is next

**Phase 1 — collection works end to end.** The runner: polite fetch honouring
each source's crawl delay, discovery, diff against yesterday, raw pages to S3,
parse, events. Plus the abort guard. Then adapters two and three (LuxuryEstate,
Etreproprio) against the finished pipeline.

**Phase 2 — deduplication.** Exact match on agency plus mandate reference first;
description similarity where no reference exists. Every merge stores its score
and signals. Tuned against Med-Estates' own stock, which appears on several
portals at once and is therefore a labelled set.

**Phase 3 — the remaining seven adapters.** Reconnaissance first on the four
never inspected: AVIV, Figaro Immobilier, Zoopla Overseas, Green-Acres/Vizzit.

**Phase 4 — the client app.** Blocked on the CRM question below.

**Deliberately deferred:** the full Reports screen. Days on market, price cuts
and trends are derived from accumulated events, and there are none yet. First
honest figures four to six weeks in — sooner if Superimmo opens up. Say this to
the client before they ask.

---

## 6. Open questions that block work

1. **Which CRM does Med-Estates use, and does it have an API or export?**
   The Matches screen needs each buyer's criteria — budget, area, size. That
   exists only in their system. Half the product cannot be built without it.
   If it is a system n8n already supports, this becomes the fastest part of the
   project rather than the slowest.

2. **Technical access from the four portals** (§3).

3. **Does Med-Estates pay SeLoger or Belles Demeures for placement?**
   If so, collecting from them risks the client's own working account.

4. **Verify two INSEE codes** before the first real run: La Môle (83078) and
   Roquebrune-sur-Argens (83107). The other ten were read out of Etreproprio's
   own URLs. A wrong code fails silently as an empty commune.

---

## 7. Things the mockup claims that the data cannot support

Recorded so they are decided deliberately rather than shipped by accident.

- **Competitor "strategy" column** — model interpretation sitting in a table
  next to computed numbers, indistinguishable from them. Label it or drop it.
- **Rental yield and occupancy** — do not exist on sales portals at all.
- **"What sells fastest"** — measures listings disappearing, not sales. A
  listing vanishes when it sells, when the owner withdraws it, when the agency's
  subscription lapses, and when it moves to a competitor. If a client repeats
  that number to a seller they will eventually be publicly wrong.
- **Prices shown in dollars** on a euro market. Portal markup carries EUR.

Partial fix for the third: **DVF** (data.gouv.fr) publishes real French
transaction prices, geolocated, back to 2014, Var included. Asking price beside
what actually sold is stronger than anything a portal can offer.

---

## 8. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-08-25 | Separate repository, not a module in Vault | Sold as a product, like internal_dash |
| 2026-08-25 | Shared collector, per-client app | Market data is not client data; duplicate crawling risks the permissions |
| 2026-08-25 | Hand-written migrations, custom runner | Generated migrations drift; a journal file is a second thing to keep in sync and it fails silently |
| 2026-08-25 | Dedup on text and mandate reference, not geography | No portal publishes usable coordinates; the one that does rounds to a postcode centroid |
| 2026-08-25 | SMC as first adapter, not LuxuryEstate | Its markup has been read and verified rather than assumed, and it covers two portals |
| 2026-08-25 | Raw pages to S3 before parsing | Parsers break; re-parsing stored pages beats re-crawling thirteen sites |
| 2026-08-25 | No `sold` event type | A portal cannot tell us why a listing disappeared |
