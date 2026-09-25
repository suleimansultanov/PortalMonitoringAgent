import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
  type RawListing,
} from "../types";

/**
 * JamesEdition — the luxury aggregator.
 *
 * Written off twice as "403 on every path". That verdict came from
 * `npm run probe` asking with a plain HTTP client; the collector driving
 * Chromium under our own user-agent is served both index and listing pages,
 * measured 30 August and again 10 September. Fourth portal in a row where the
 * plain-client probe was the wrong instrument.
 *
 * WHAT THEIR ROBOTS.TXT SAYS, read before a line of this was written because
 * Figaro taught that lesson twice: `Allow: /` for `*`, `/real_estate/` open
 * except `map?` and `show_more_nearby_listings`, one crawler banned by name
 * (`trovitBot`) and it is not us. No `Crawl-delay` for `*` — the four seconds
 * below are ours, not theirs.
 *
 * WHY THIS PORTAL IS WORTH HAVING. It is the prestige end: BARNES Saint-Tropez,
 * Côte d'Azur Sotheby's, Kretz, Fiedler & Rosner, Lucas Fox on the first page
 * of Saint-Tropez alone — Med-Estates' own market. 456 listings there against
 * Green-Acres' 316. How much of that is the same mandate reaching us twice is
 * a question only a real pass and `npm run merges` can answer.
 */

type CommuneConfig = { insee: string; slug: string; label: string };

/** Their listing URLs: /real_estate/{area-slug}/{title-slug}-{id}. */
const LISTING_HREF = /href="(\/real_estate\/[a-z0-9-]+\/[a-z0-9-]+-(\d{6,}))"/gi;

/**
 * A rental, told apart from a sale.
 *
 * JamesEdition files rentals under the same `/real_estate/{area}/` path as
 * sales, with no structured flag anywhere: the JSON-LD Offer carries no
 * `businessFunction`, and the breadcrumb does not say. What it DOES carry is
 * its own title template, on two stable fields:
 *
 *   <title>… , Saint Tropez, France For Sale (18071317)</title>
 *   href="/real_estate/ramatuelle-france/for-rent-exclusive-sea-view-…-17557981"
 *
 * The `<title>` ends "For Sale (id)" or "For Rent (id)" — theirs, not the
 * agent's prose — and the URL slug is the same title lower-cased, so a rental's
 * slug begins `for-rent-`. The slug is checked at discovery (no fetch spent),
 * the title at parse (the net under it).
 *
 * WHY IT MATTERS, and why it is small. Measured 2026-09-24: 0 of 32 cards on
 * Saint-Tropez page one were rentals; one was found in Ramatuelle. Rare — but
 * a monthly rent stored as a sale price sits next to €5M villas looking like a
 * wrong figure, and it never deduplicates against the sale of the same house,
 * so each one is a phantom duplicate on the client's screen.
 */
const RENTAL_SLUG = /^for-rent-/i;
const RENTAL_TITLE = /\bFor Rent\s*\(\d{6,}\)\s*<\/title>/i;

/** "456 listings" — the portal stating its own total, as Figaro does. */
const STATED_TOTAL = /([\d,]+)\s*listings/i;

/**
 * The spec strip, and NOTHING but the spec strip.
 *
 *   <ul class="je2-listing-info__specs">
 *     <li>8 Beds</li><li>8 Baths</li><li>389 Sqm</li><li>2,666 Sqm lot</li>
 *   </ul>
 *
 * The first version of this read the same patterns off the WHOLE page text and
 * it produced two silent lies in a fifty-listing run:
 *
 *   18727889  "…23,500 sqm of" in the TITLE became a 23 500 m² house
 *   18251481  a floor area of 1.66 m², on a page whose lot is 1 661 m²
 *
 * Both passed the test suite, because on the one fixture the strip happened to
 * be the first match on the page. A test against a single page is not a test —
 * which is the lesson this project has now learnt three times, and the reason
 * the test file below runs against every URL the trial pass collected.
 *
 * So the container is matched first and the numbers are read only from inside
 * it. If the markup changes, that is a parse gap that shows up as a missing
 * field, not a number from somewhere else on the page.
 */
const SPEC_STRIP = /<ul[^>]*class="[^"]*je2-listing-info__specs[^"]*"[^>]*>([\s\S]*?)<\/ul>/i;
const BEDS = /^(\d+)\s+Beds?$/i;
const BATHS = /^(\d+)\s+Baths?$/i;
const LOT = /^([\d,.]+)\s*(Sqm|Sqft)\s+lot$/i;
const AREA = /^([\d,.]+)\s*(Sqm|Sqft)$/i;

/**
 * The portal's own answer to "where is this", off the map button:
 *   aria-label="Zone Ouest Urbaine, Saint-Tropez, France"
 *
 * The commune is the part before "France" — which holds whether or not a
 * sub-district is named, so "Saint-Tropez, France" reads the same way.
 */
const LOCATION_LABEL = /je2-listing-info__location[^>]*aria-label="([^"]+)"/i;

/** A French postcode, for the runner's second signal. */
const POSTCODE = /\b(8[0-9]{4})\b/;

/**
 * Labels the map button emits that name a REGION or DEPARTMENT, not a commune.
 *
 * MEASURED 2026-09-24. Twenty-one Ramatuelle listings — L'Escalet, Pampelonne, a
 * seventeen-hectare olive estate — carried the label
 * "Provence-Alpes-Côte d'Azur, France" with no commune in it at all. The parser
 * took the part before "France", as it does for "Zone Ouest Urbaine,
 * Saint-Tropez, France", and stored the region as the commune. The code never
 * resolved, `commune_insee` stayed NULL, and the twenty-one could neither merge
 * (so they showed as duplicates) nor ever be delisted.
 *
 * A label in this set means the portal stated NO commune, and the URL's area
 * segment — the list the property was found under — becomes the best evidence
 * we hold. That is the one case where the list is allowed to win, and `raw`
 * records that it did, so the choice can be audited without a recrawl.
 *
 * "Var" is included as the department one level down their breadcrumb; it is
 * the same shape and has not been seen yet. Nothing else is guessed.
 */
const NOT_A_COMMUNE = new Set(["provence-alpes-cote d'azur", "provence-alpes-côte d'azur", "var"]);
const isRegionLabel = (s: string): boolean =>
  NOT_A_COMMUNE.has(
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(),
  ) || NOT_A_COMMUNE.has(s.toLowerCase().trim());

/**
 * Their own answer to "which area is this?", server-rendered in the heading:
 *   <h1>Luxury Homes for Sale in Saint Tropez, Provence Alpes Côte D'azur, France</h1>
 *
 * MEASURED 2026-09-15, and it is the reason this check exists rather than a
 * precaution. `la-mole-france` — the obvious guess for the twelfth commune,
 * and the one `communePaths.ts` warns against — answers 200 with
 * "Luxury Homes for Sale in France" and the whole country's stock. No 404, no
 * redirect, nothing in the status code to catch.
 *
 * That shape is not only about a slug we chose not to guess. The day
 * JamesEdition retires or renames an area we DO use, this same page comes back
 * for it: several hundred Paris and Nice listings arriving under a Gulf
 * commune, at four seconds each, and the commune itself reading as empty.
 *
 * So page one is checked against the area we asked for, exactly as Figaro's
 * `searchInsee` is checked against the ville token. Their heading drops
 * hyphens and accents — "Saint-Tropez" prints as "Saint Tropez" — so both
 * sides are flattened before they are compared.
 */
const AREA_HEADING = /<h1[^>]*>([^<]{3,200})<\/h1>/i;

/** Lowercase, unaccented, punctuation as spaces — for comparing their spelling with ours. */
function flattenName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Bounds that reject the impossible rather than storing it.
 *
 * Not tuning — the two faults above both produced numbers no property has, and
 * a wrong-but-plausible figure is the one that survives longest. Anything
 * outside these is recorded as a missing field, which is visible in the quality
 * report, instead of as data, which is not.
 */
const AREA_MIN = 8;
const AREA_MAX = 3_000;
const LAND_MIN = 20;
const LAND_MAX = 2_000_000;

function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed: unknown = JSON.parse(m[1]);
      for (const o of Array.isArray(parsed) ? parsed : [parsed]) {
        if (o && typeof o === "object") out.push(o as Record<string, unknown>);
      }
    } catch {
      // A malformed block is one block, not a failed page.
    }
  }
  return out;
}

/**
 * A number written the English way: 2,666 or 389.
 *
 * Deliberately NOT tolerant of the French convention. Their pages are English
 * and use the comma as a thousands separator, so treating "2,666" as 2.666
 * would turn a 2666 m² plot into a rounding error — and treating both
 * conventions as possible means guessing, which on a measurement is worse than
 * refusing.
 */
function englishNumber(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Square feet exist on these pages. Convert, never assume. */
function toSquareMetres(value: number, unit: string): number | null {
  const u = unit.toLowerCase();
  if (u === "sqm") return value;
  if (u === "sqft") return Math.round(value * 0.09290304);
  return null;
}

/**
 * Which commune this property is in — from the URL's area segment.
 *
 * NOT from the breadcrumb's second-to-last entry, which was the first thing
 * tried and is wrong: for this listing that entry is "Zone Ouest Urbaine", a
 * sub-district of Saint-Tropez, and how deep a locality nests varies from
 * listing to listing. There is no fixed position that means "commune".
 *
 * NOT from the similar-properties blocks either. Those ten `House` entries all
 * carry the same `address` — "Zone Ouest Urbaine, Saint-Tropez, France" on
 * every one — so reading a commune from them stamps this page's location onto
 * ten other people's houses.
 *
 * The area segment of the URL is the portal's own filing: this listing sits
 * under `/real_estate/saint-tropez-france/`. It is a claim rather than a fact —
 * an index that mixed stock would file a Cogolin villa under Saint-Tropez, and
 * that is exactly what Zefir does — so the whole breadcrumb trail is kept in
 * `raw` beside it. When a mismatch is suspected, the evidence is already in the
 * database instead of needing another crawl.
 */
function communeFromUrl(url: string): string | null {
  const seg = url.match(/\/real_estate\/([a-z0-9-]+)\//)?.[1];
  if (!seg) return null;
  return seg
    .replace(/-france$/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
}

/** Every level the portal names, for auditing what the area segment claimed. */
function breadcrumbTrail(blocks: Record<string, unknown>[]): string[] {
  const crumb = blocks.find((b) => b["@type"] === "BreadcrumbList");
  const items = (crumb?.itemListElement as Record<string, unknown>[] | undefined) ?? [];
  return items
    .map((i) => {
      const item = i.item as Record<string, unknown> | string | undefined;
      const name = i.name ?? (typeof item === "object" ? item?.name : undefined);
      return typeof name === "string" ? name.trim() : null;
    })
    .filter((n): n is string => n !== null && n.length > 0);
}

export const jameseditionAdapter: PortalAdapter = {
  key: "jamesedition",
  name: "JamesEdition",
  hosts: ["www.jamesedition.com", "jamesedition.com"],
  discoveryMode: "index",
  /** Ours. Their robots.txt states no Crawl-delay for a generic crawler. */
  defaultCrawlDelayMs: 4_000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const host = (ctx.config.host as string) ?? "https://www.jamesedition.com";
    const communes = (ctx.config.communes ?? []) as CommuneConfig[];
    const maxPages = (ctx.config.maxPages as number) ?? 30;

    for (const insee of ctx.communeInsee) {
      if (!communes.some((c) => c.insee === insee)) {
        /**
         * La Môle (83079) is the one we have no slug for. Their nearby-areas
         * block names eleven of our twelve and not that one, and
         * `la-mole-france` is exactly the guess this project has been punished
         * for: an unknown area slug on these portals answers 200 with
         * something else, which reads as a commune with nothing for sale and
         * delists everything previously collected there.
         */
        console.warn(`[jamesedition] no area slug configured for INSEE ${insee} — skipping`);
      }
    }

    for (const c of communes.filter((x) => ctx.communeInsee.includes(x.insee))) {
      const seen = new Set<string>();
      let cutShort: string | null = null;
      let knownStreak = 0;
      let stated: number | null = null;
      let rentals = 0;

      for (let page = 1; page <= maxPages; page++) {
        /**
         * `order=recent` is THEIR "Newest homes for sale in Saint-Tropez" link
         * — read off the index page's own "popular searches" block on the
         * saved fixture (2026-09-25), not guessed. It is what makes a delta
         * pass possible here: with the newest first, a run can stop after
         * `deltaStopAfterKnown` listings it already holds, instead of walking
         * fifteen pages of Saint-Tropez every night to find three new ones.
         * robots.txt disallows only `map?` and `show_more_nearby_listings`
         * under /real_estate/; a query on the index is open.
         *
         * A claim about their ordering, like Superimmo's `sort=created_at`,
         * and it costs the same if wrong: a delta night never delists, so a
         * mis-ordered list loses new listings only until Sunday's full sweep.
         */
        const params = new URLSearchParams({ order: "recent" });
        if (page > 1) params.set("page", String(page));
        const url = `${host}/real_estate/${c.slug}?${params.toString()}`;

        let html: string;
        try {
          html = await ctx.fetch(url);
        } catch (err) {
          cutShort = `index page ${page} failed: ${(err as Error).message}`;
          console.warn(`[jamesedition] ${c.slug}: ${cutShort}`);
          break;
        }

        if (page === 1) {
          /**
           * Their answer before their content. An area slug they do not know
           * is answered with the whole of France at HTTP 200 — see
           * `AREA_HEADING` — so the status code cannot be the check.
           */
          const heading = html.match(AREA_HEADING)?.[1]?.trim();
          if (heading && !flattenName(heading).includes(flattenName(c.label))) {
            cutShort =
              `asked for "${c.slug}" and their page is headed "${heading}" — ` +
              `that is not an area they know, so the stock on it is not this commune's`;
            console.warn(`[jamesedition] ${c.slug}: ${cutShort}`);
            break;
          }

          const m = text(html).match(STATED_TOTAL);
          stated = m ? englishNumber(m[1]) : null;
        }

        const onPage = [...new Set([...html.matchAll(LISTING_HREF)].map((m) => m[1]))];
        const fresh = onPage.filter((p) => !seen.has(p));

        /**
         * No new links means the end of the list — or a portal that answers a
         * page number past the last one with page one again, which is the same
         * shape from here. Either way there is nothing further to read, and it
         * is an ending rather than a failure.
         */
        if (fresh.length === 0) break;

        for (const path of fresh) {
          seen.add(path);
          const id = path.match(/-(\d{6,})$/)?.[1];
          if (!id) continue;

          /** Not our market. Skipped here so no request is spent on it. */
          const slug = path.split("/").pop() ?? "";
          if (RENTAL_SLUG.test(slug)) {
            rentals += 1;
            continue;
          }

          if (ctx.delta) {
            if (ctx.delta.knows(id)) {
              knownStreak += 1;
              if (knownStreak >= ctx.delta.after) {
                cutShort =
                  `stopped after ${knownStreak} listings we already hold — ` +
                  `the rest of this commune is older`;
                break;
              }
              continue;
            }
            knownStreak = 0;
          }

          yield { externalId: id, url: `${host}${path}`, communeHint: c.insee };
        }

        if (cutShort) break;
      }

      /**
       * Their own total against ours, the way Figaro's `offerCount` is used.
       * A shortfall is not proof of a fault — the count includes types we may
       * filter — but a LARGE one means pagination stopped early, and stopping
       * early silently is what delists a commune.
       */
      if (rentals > 0) {
        console.log(`[jamesedition] ${c.label}: skipped ${rentals} rental${rentals === 1 ? "" : "s"} — not for sale`);
      }

      if (!cutShort && stated !== null && seen.size < stated * 0.9) {
        cutShort = `found ${seen.size} of the ${stated} this portal states`;
      }

      if (cutShort) ctx.incomplete(c.insee, cutShort);
    }
  },

  parse(html: string, url: string): ParseResult {
    const id = url.match(/-(\d{6,})(?:[?#]|$)/)?.[1];
    if (!id) return { status: "failed", error: "no listing id in the URL" };

    const blocks = jsonLd(html);

    /**
     * THE SUBJECT IS THE ONE `Product`, AND IT IS FOUND BY SHAPE.
     *
     * This page carries ten `House` blocks and one `Product`. The `House`
     * entries are the similar-properties strip — parsing the first one gives
     * another property's bedrooms with this property's price, and nothing
     * downstream could tell. So: the Product whose category is RealEstate, and
     * if a page ever carries two, none of them, because guessing which is the
     * subject is how SMC's gallery ended up with a neighbour's photographs.
     */
    const products = blocks.filter(
      (b) => b["@type"] === "Product" && b.category === "RealEstate",
    );
    if (products.length !== 1) {
      return {
        status: "failed",
        error: `expected exactly one RealEstate Product, found ${products.length}`,
      };
    }
    const product = products[0];

    const listing: RawListing = emptyListing(id, url);
    const missing: string[] = [];

    /**
     * The net under the discovery filter. A rental that reached parse — via
     * a slug that did not start `for-rent-`, or a page fetched for a refresh
     * from before the filter existed — is refused here on the portal's own
     * title template, and never stored.
     */
    if (RENTAL_TITLE.test(html)) {
      return { status: "failed", error: "rental listing, not for sale — outside the sale corpus" };
    }

    listing.title = typeof product.name === "string" ? product.name.trim() : null;
    listing.description =
      typeof product.description === "string" ? product.description.trim() : null;
    listing.imageUrl = typeof product.image === "string" ? product.image : null;
    if (listing.imageUrl) listing.imageUrls = [listing.imageUrl];

    const offer = product.offers as Record<string, unknown> | undefined;

    /**
     * EUROS OR NOTHING.
     *
     * JamesEdition is an international site and prices in several currencies.
     * A dollar figure written into `price_eur` is invisible: the number is
     * plausible, the column is typed, nothing errors, and every median and
     * every match involving it is quietly wrong. So the currency is checked and
     * a non-euro price is recorded as missing rather than converted — a rate
     * we invented would be a second fiction on top of the first.
     */
    const currency = typeof offer?.priceCurrency === "string" ? offer.priceCurrency : null;
    const rawPrice = offer?.price;
    const price = typeof rawPrice === "number" ? rawPrice : Number(rawPrice);
    if (currency === "EUR" && Number.isFinite(price) && price > 0) {
      listing.priceEur = Math.round(price);
    } else {
      missing.push(currency && currency !== "EUR" ? `price in ${currency}` : "price");
    }

    const seller = offer?.seller as Record<string, unknown> | undefined;
    listing.agencyName = typeof seller?.name === "string" ? seller.name.trim() : null;
    if (!listing.agencyName) missing.push("agency");

    listing.availability =
      typeof offer?.availability === "string" && offer.availability.includes("InStock")
        ? "available"
        : null;

    // ── Measurements: from the spec strip container, nowhere else ───────────
    const strip = html.match(SPEC_STRIP)?.[1] ?? "";
    const items = [...strip.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
    );
    if (items.length === 0) missing.push("spec strip");

    for (const item of items) {
      const lot = item.match(LOT);
      if (lot) {
        const n = englishNumber(lot[1]);
        const m2 = n === null ? null : toSquareMetres(n, lot[2]);
        listing.landM2 = m2 !== null && m2 >= LAND_MIN && m2 <= LAND_MAX ? m2 : null;
        continue;
      }
      const area = item.match(AREA);
      if (area) {
        const n = englishNumber(area[1]);
        const m2 = n === null ? null : toSquareMetres(n, area[2]);
        listing.areaM2 = m2 !== null && m2 >= AREA_MIN && m2 <= AREA_MAX ? m2 : null;
        continue;
      }
      const beds = item.match(BEDS);
      if (beds) {
        listing.bedrooms = englishNumber(beds[1]);
        continue;
      }
      const baths = item.match(BATHS);
      if (baths) listing.bathrooms = englishNumber(baths[1]);
    }
    if (listing.areaM2 === null) missing.push("area");

    /**
     * THE URL'S AREA SEGMENT IS NOT THE COMMUNE, MEASURED.
     *
     * The first version took it from `/real_estate/saint-tropez-france/`, and
     * the fifty-listing trial filed under Saint-Tropez a villa whose own title
     * says "– Gassin", another in Beauvallon, and a hunting estate the portal
     * itself describes as "40 km from St-Tropez". Their commune index reaches
     * into the neighbours, exactly as Zefir's does.
     *
     * So the commune comes from the property's own location label, and the
     * postcode from its own words. The runner's `resolveCommune` weighs both
     * against the title and description; giving it the list's label instead
     * would be handing it a confident wrong answer to agree with.
     */
    const label = html.match(LOCATION_LABEL)?.[1];
    const parts = label?.split(",").map((x) => x.trim()).filter(Boolean) ?? [];
    const stated = parts.length >= 2 ? parts[parts.length - 2] : null;

    /**
     * The listing's own label wins whenever it names a commune. When it names
     * only a region — see NOT_A_COMMUNE — the portal has stated nothing, and
     * the list the property was found under is the best evidence left. Which
     * of the two was used is recorded in `raw.communeSource`.
     */
    let communeSource: "listing" | "list" | "none";
    if (stated && !isRegionLabel(stated)) {
      listing.communeRaw = stated;
      communeSource = "listing";
    } else {
      listing.communeRaw = communeFromUrl(url) ?? null;
      communeSource = listing.communeRaw ? "list" : "none";
    }
    if (!listing.communeRaw) missing.push("commune");

    listing.postalCode =
      `${listing.title ?? ""} ${listing.description ?? ""}`.match(POSTCODE)?.[1] ?? null;

    listing.propertyType =
      typeof product.name === "string" && /villa/i.test(product.name) ? "Villa" : null;

    listing.raw = {
      jsonLdProduct: product,
      breadcrumb: breadcrumbTrail(blocks),
      /** What the list filed it under, kept so a mismatch can be audited. */
      listedUnder: communeFromUrl(url),
      /** Which evidence set `communeRaw` — the listing's own label, or the list. */
      communeSource,
      /** The map label verbatim, so a region-only label is visible after the fact. */
      locationLabel: label ?? null,
      specs: items,
    };

    return missing.length > 0
      ? { status: "partial", listing, missing }
      : { status: "ok", listing };
  },
};
