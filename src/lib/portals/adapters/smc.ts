import * as cheerio from "cheerio";
import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
  type RawListing,
} from "../types";
import { extractJsonLd, firstOffer, nodesOfType, num, readAddress, str } from "../jsonld";
import { communeSlugMatcher, walkSitemap } from "../runner/sitemap";
import { isPastLastPage } from "../runner/fetcher";

/**
 * SMC France — Maisons et Appartements + Résidences Immobilier.
 *
 * One adapter, two brands. They share an engine (identical internal paths,
 * `/routines/`, `/views/sitemapBuild.php`) and Maisons et Appartements links to
 * Résidences from its own menu as its "Biens de prestige" section.
 *
 * DISCOVERY GOES THROUGH THE SITEMAP.
 * Measured 2026-08-26: their search pages return 403 to our client while
 * individual listings are served without complaint. That shape is deliberate —
 * search pages are what scrapers hammer, so those carry the protection, while
 * listing pages stay open because the site wants them indexed and shared.
 * Their sitemap index is split by French department, so the Var is one shard
 * out of ninety-five: a single gzipped file in place of forty paginated
 * requests, lighter on them as well as on us.
 */

/** `.../annonce-vente-maison-ramatuelle-4241469.html` → `4241469` */
const ID_FROM_URL = /-(\d+)\.html(?:$|[?#])/;

/** Their listing URL grammar, used to tell listings from everything else in the sitemap. */
const LISTING_URL = /annonce-vente-[a-z]+-[a-z0-9-]+-\d+\.html/;

/**
 * The `name` field is a structured string:
 *   "Ramatuelle - Maison à vendre - 10 pièces - 320 m² - 9 500 000 €"
 * which is the only place rooms and floor area appear in the markup. Fragile in
 * principle — it is their title template — but it lives inside the JSON-LD they
 * maintain for search results, not in the CSS, so it survives redesigns.
 */
const NAME_ROOMS = /(\d+)\s*pièces?/i;
const NAME_AREA = /([\d\s.,]+)\s*m²/i;

type CommuneEntry = { insee: string; slug: string; id: string; label?: string };

export const smcAdapter: PortalAdapter = {
  key: "smc",
  name: "Maisons et Appartements / Résidences Immobilier",
  hosts: [
    "maisonsetappartements.fr",
    "www.maisonsetappartements.fr",
    "residences-immobilier.com",
    "www.residences-immobilier.com",
  ],
  discoveryMode: "sitemap",
  /** robots.txt sets no delay; one second is the neighbourly default. */
  defaultCrawlDelayMs: 1000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const sitemapRoot = ctx.config.sitemap as string | undefined;

    /**
     * Sitemap first, index pages as a real fallback rather than a dead branch.
     *
     * The sitemap is the better route by a distance — one file instead of a
     * walk through their search infrastructure — so it is tried first and, when
     * it works, it is the only thing that runs. But their Var shard has
     * answered 403 since the day it was written, which meant this adapter had a
     * preferred path that never worked and a working path it never reached.
     *
     * A fallback that only triggers on ZERO results, never on "fewer than
     * expected": a sitemap that returns some listings is a sitemap that is
     * working, and crawling their index on top of it would double our request
     * count against a portal that has been generous with us.
     */
    /**
     * ⚠️ While this source runs in `browser` mode the sitemap route cannot
     * work, for a reason that has nothing to do with permission: Chromium
     * treats `.xml.gz` as a download rather than a page, so `page.goto` fails
     * with "Download is starting" before any status code is seen. Measured
     * 2026-08-29.
     *
     * Harmless today — their Var shard answers 403 to the plain client anyway,
     * and the fallback below carries the pass. It becomes a trap the day they
     * allowlist us: the better route would silently stay broken and we would
     * keep crawling their index pages instead. The fix then is to walk the
     * sitemap with the plain fetcher even when the rest of the pass uses a
     * browser, which needs a second fetcher on DiscoverContext.
     */
    if (sitemapRoot) {
      let found = 0;
      try {
        for await (const item of discoverViaSitemap(ctx, sitemapRoot)) {
          found += 1;
          yield item;
        }
      } catch (err) {
        // A refused shard is exactly the case this fallback exists for, so it
        // is reported and stepped over rather than ending the pass.
        console.warn(`[smc] sitemap unavailable (${(err as Error).message}) — trying index pages`);
      }
      if (found > 0) return;
      console.warn("[smc] sitemap yielded nothing — falling back to index pages");
    }

    yield* discoverViaIndex(ctx);
  },

  parse(html: string, url: string): ParseResult {
    const externalId = url.match(ID_FROM_URL)?.[1];
    if (!externalId) {
      return { status: "failed", error: `could not read a listing id out of ${url}` };
    }

    const nodes = extractJsonLd(html);
    const product = nodesOfType(nodes, "Product")[0] ?? null;
    if (!product) return { status: "failed", error: "no Product node in JSON-LD" };

    const listing = emptyListing(externalId, url);
    listing.raw = { product, agent: nodesOfType(nodes, "RealEstateAgent")[0] ?? null };

    listing.title = str(product.name);
    listing.description = str(product.description);

    const offer = firstOffer(product);
    if (offer) {
      const currency = str(offer.priceCurrency);
      const price = num(offer.price);
      // Refuse anything that is not euros rather than recording a number whose
      // unit we are guessing at. A wrong currency is worse than a null.
      if (price !== null && (currency === null || currency.toUpperCase() === "EUR")) {
        listing.priceEur = Math.round(price);
      }
      listing.availability = str(offer.availability);

      const seller = offer.seller as Record<string, unknown> | undefined;
      if (seller) listing.agencyName = str(seller.name);
    }

    // `brand` repeats the agency and is present even when `offers.seller` is not.
    if (!listing.agencyName) {
      const brand = product.brand as Record<string, unknown> | undefined;
      if (brand) listing.agencyName = str(brand.name);
    }

    // The agency block: postal address and phone, published in the same format
    // across portals, which is what makes agency identity resolvable at all.
    // Buried in ItemList → itemListElement → item, which is why the JSON-LD
    // flattener has to descend into those.
    const agent = nodesOfType(nodes, "RealEstateAgent")[0];
    if (agent) {
      const addr = readAddress(agent.address);
      listing.agencyName = listing.agencyName ?? str(agent.legalName) ?? str(agent.name);
      listing.agencyAddress = addr.full;
      listing.agencyPostalCode = addr.postalCode;
      listing.agencyCity = addr.locality;
      listing.agencyPhone = str(agent.telephone);
    }

    applyNameFields(listing);
    listing.agencyRef = agencyRefFromHtml(html);

    /**
     * NOTE: `sku` and `mpn` are deliberately ignored. On this portal `sku`
     * holds the AGENCY id — the same number that appears in the agency's own
     * URL — not the listing id. Using it as a key merges every listing from
     * one agency into a single row.
     */

    applyGallery(html, listing);

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null) missing.push("areaM2");
    if (!listing.agencyName) missing.push("agencyName");

    return missing.length === 0
      ? { status: "ok", listing }
      : { status: "partial", listing, missing };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

async function* discoverViaSitemap(
  ctx: DiscoverContext,
  root: string,
): AsyncIterable<DiscoveredListing> {
  const communes = (ctx.config.communes ?? []) as CommuneEntry[];
  const wanted = communes.filter((c) => ctx.communeInsee.includes(c.insee));

  warnUncovered(ctx, communes);

  /**
   * Both spellings. Their index pages use `st-tropez` and `ste-maxime`, but a
   * listing URL may carry the unabbreviated form. Matching only the spelling we
   * happen to have seen would drop a commune silently — which is the failure
   * this whole adapter keeps working to avoid.
   */
  const slugs = new Set<string>();
  for (const c of wanted) {
    slugs.add(c.slug);
    slugs.add(c.slug.replace(/^st-/, "saint-").replace(/^ste-/, "sainte-"));
  }

  const matchesCommune = communeSlugMatcher([...slugs]);
  /** `smcSitemapAnnouncement-fr-83_1.xml.gz` — 83 is the Var. */
  const department = (ctx.config.department as string) ?? "83";
  const shard = new RegExp(`-fr-${department}[_-]`, "i");

  let found = 0;
  for await (const entry of walkSitemap({
    fetch: ctx.fetch,
    root,
    keepSitemap: (s) => shard.test(s.loc),
    keepUrl: (u) => LISTING_URL.test(u.loc) && matchesCommune(u),
  })) {
    const id = entry.loc.match(ID_FROM_URL)?.[1];
    if (!id) continue;
    found += 1;
    yield { externalId: id, url: entry.loc };
  }

  if (found === 0) {
    /**
     * Loud, and worth distinguishing from "the market is quiet". If the shard
     * was readable and still produced nothing, either the department filter is
     * wrong or their URL grammar changed.
     *
     * Also worth watching: the sitemap index carries a `lastmod` of 2026-03-05
     * on every shard — five months stale at the time of writing. Either the
     * dates are not maintained or the sitemaps themselves are, and the second
     * would mean new listings never appear here. The first real run answers it.
     */
    console.warn(
      `[smc] sitemap yielded no listings for ${wanted.length} communes — ` +
        `check the department filter (${department}) and their URL pattern`,
    );
  }
}

async function* discoverViaIndex(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
  /**
   * A list, not a map keyed by INSEE. SMC publishes district pages — Port
   * Grimaud and Marines de Cogolin have their own — and a district shares its
   * parent commune's INSEE code. Keyed by INSEE one of each pair would
   * overwrite the other and half a commune's stock would go uncollected.
   */
  const communes = (ctx.config.communes ?? []) as CommuneEntry[];
  const host = (ctx.config.host as string) ?? "https://www.maisonsetappartements.fr";
  const maxPages = (ctx.config.maxPages as number) ?? 30;

  warnUncovered(ctx, communes);

  for (const entry of communes.filter((c) => ctx.communeInsee.includes(c.insee))) {
    const seen = new Set<string>();
    /**
     * Reported against the INSEE code, which several district pages share —
     * Port Grimaud and Grimaud are one commune as far as delisting is
     * concerned, so a truncated crawl of either shields both.
     */
    let cutShort: string | null = null;

    for (let page = 1; page <= maxPages; page++) {
      const suffix = page === 1 ? "" : `_${page}`;
      const url = `${host}/fr/83/biens/vente/selection-biens-${entry.slug}-${entry.id}${suffix}.html`;

      let html: string;
      try {
        html = await ctx.fetch(url);
      } catch (err) {
        if (isPastLastPage(err)) {
          if (page > 1) break;
          cutShort = `the commune URL is missing (${(err as Error).message}) — check the slug`;
        } else {
          cutShort = `index page ${page} failed: ${(err as Error).message}`;
        }
        console.warn(`[smc] ${entry.slug}: ${cutShort}`);
        break;
      }

      const found = listingUrlsOnPage(html, host);
      // Stop on the first page that adds nothing. Their pagination happily
      // serves the last page forever past the end, so counting pages is not
      // enough — you have to notice you are going in circles.
      const fresh = found.filter((u) => !seen.has(u));
      if (fresh.length === 0) {
        /**
         * Page two repeating page one is not an ending, it is a pagination
         * parameter being accepted and ignored — and it caps the commune at
         * whatever fits on one page while looking exactly like a small market.
         *
         * Measured 2026-08-30: `_2` is served byte-for-byte identical to page
         * one for La Croix-Valmer and Ramatuelle, so the first SMC collection
         * took fifteen listings per commune and reported a clean finish. The
         * same trap as Green-Acres' `p_n`, which is why that adapter has said
         * this since the day it was written and this one now does too.
         */
        if (page > 1 && found.length > 0) {
          cutShort =
            `page ${page} repeated page ${page - 1} — the '_N' page suffix is not ` +
            `taking effect, so only the first ${seen.size} listings of this ` +
            `commune are visible`;
          console.warn(`[smc] ${entry.slug}: ${cutShort}`);
        }
        break;
      }

      for (const u of fresh) {
        seen.add(u);
        const id = u.match(ID_FROM_URL)?.[1];
        if (!id) continue;
        yield { externalId: id, url: u, communeHint: entry.slug };
      }

      if (page === maxPages) {
        cutShort = `hit the ${maxPages}-page ceiling with listings still arriving`;
        console.warn(`[smc] ${entry.slug}: ${cutShort}`);
      }
    }

    if (cutShort) ctx.incomplete(entry.insee, cutShort);
  }
}

function warnUncovered(ctx: DiscoverContext, communes: CommuneEntry[]): void {
  for (const insee of ctx.communeInsee) {
    if (communes.some((c) => c.insee === insee)) continue;
    // Loud, because a missing entry is a whole commune silently absent from the
    // product — the kind of gap that reads as "the market is quiet".
    console.warn(`[smc] no commune configured for INSEE ${insee} — skipping`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Field extraction
// ─────────────────────────────────────────────────────────────────────────────

/** Pull commune, type, rooms and area out of the structured title string. */
function applyNameFields(listing: RawListing): void {
  const name = listing.title;
  if (!name) return;

  const parts = name.split(" - ").map((p) => p.trim());
  if (parts.length > 0) listing.communeRaw = parts[0] || null;

  const typePart = parts.find((p) => /à vendre/i.test(p));
  if (typePart) listing.propertyType = typePart.replace(/à vendre/i, "").trim() || null;

  const rooms = name.match(NAME_ROOMS);
  if (rooms) listing.rooms = Number(rooms[1]);

  const area = name.match(NAME_AREA);
  if (area) {
    const n = num(area[1]);
    if (n !== null && n > 0) listing.areaM2 = n;
  }
}

/**
 * The agency's own mandate reference, printed on the page as "Réf : 86836462".
 *
 * Not in the JSON-LD, so this is the one field here that depends on markup and
 * will need attention after a redesign. Worth the exposure: the same reference
 * turns up on unrelated portals for the same property, which makes it an exact
 * deduplication key rather than a scored guess.
 */
function agencyRefFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const text = $("body").text();
  const m = text.match(/R[ée]f\s*(?:annonce|agence)?\s*[:.]?\s*([A-Za-z0-9][\w\-./]{1,24})/);
  return m ? m[1].trim() : null;
}

function listingUrlsOnPage(html: string, host: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !LISTING_URL.test(href)) return;
    urls.add(href.startsWith("http") ? href : new URL(href, host).toString());
  });
  return [...urls];
}

/**
 * Photographs.
 *
 * Their filenames carry the order: `.../pict/f1200x800/4/9/3/1/ext_0_4931521.jpg`,
 * then `ext_1_`, `ext_2_`. That number is the agency's own sequence, so it is
 * read rather than inferred from where an <img> happens to sit in the markup.
 *
 * The exclusion matters more than the inclusion here. Agency logos live on the
 * same media host under `/pict/Agences/Logos/`, and every listing page carries
 * one — taking every image from that host would put a Century 21 badge at the
 * front of a villa's gallery on every SMC property we hold.
 *
 * A `?t=` cache-buster rides along on each URL. It is kept: it is part of the
 * address they serve, and stripping it is a guess about their caching that we
 * have no reason to make.
 */
function applyGallery(html: string, listing: RawListing): void {
  const $ = cheerio.load(html);
  const byOrder = new Map<number, string>();

  $('img[src*="/pict/"]').each((_, el) => {
    const src = $(el).attr("src");
    if (!src || src.includes("/Agences/")) return;
    const n = src.match(/\/ext_(\d+)_\d+\.[a-z]+/i)?.[1];
    if (n === undefined) return;
    const order = Number(n);
    if (!byOrder.has(order)) byOrder.set(order, src);
  });

  const gallery = [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, url]) => url);
  if (gallery.length > 0) {
    listing.imageUrls = gallery;
    listing.imageUrl = gallery[0];
  }
  listing.imageUrl ??= $('meta[property="og:image"]').attr("content")?.trim() || null;
}
