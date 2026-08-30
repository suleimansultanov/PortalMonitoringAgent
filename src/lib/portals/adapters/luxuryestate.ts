import * as cheerio from "cheerio";
import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
  type RawListing,
} from "../types";
import { extractJsonLd, firstOffer, nodesOfType, num, readAddress, str, type JsonLdNode } from "../jsonld";
import { isPastLastPage } from "../runner/fetcher";

/**
 * LuxuryEstate.
 *
 * The richest structured markup of any portal on the list: floor area, room
 * count, bedrooms, bathrooms and amenities all arrive as data rather than
 * prose. Almost nothing here depends on their CSS.
 *
 * One thing it does NOT give us: the agency. `offers.offeredBy` points at
 * LuxuryEstate's own organisation node, not at the listing agent — so the
 * agency name has to come off the page, and that is the fragile part.
 */

/** `.../p132837599-luxury-home-for-sale-saint-tropez` → `132837599` */
const ID_FROM_URL = /\/p(\d+)-/;

/** UN/CEFACT code for square metres. Anything else is not what we think it is. */
const SQUARE_METRES = "MTK";

export const luxuryEstateAdapter: PortalAdapter = {
  key: "luxuryestate",
  name: "LuxuryEstate",
  hosts: ["luxuryestate.com", "www.luxuryestate.com"],
  /**
   * Their sitemap is global — thirteen gzipped shards covering every country
   * they list. Downloading all of it nightly to find a few hundred French
   * properties would be rude and slow. The commune index pages are targeted,
   * so discovery walks those; the sitemap stays useful as a completeness check.
   */
  discoveryMode: "index",
  defaultCrawlDelayMs: 1000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const host = (ctx.config.host as string) ?? "https://www.luxuryestate.com";
    const paths = (ctx.config.communePaths ?? {}) as Record<string, string>;
    const maxPages = (ctx.config.maxPages as number) ?? 30;

    for (const insee of ctx.communeInsee) {
      const path = paths[insee];
      if (!path) {
        console.warn(`[luxuryestate] no commune path for INSEE ${insee} — skipping`);
        continue;
      }

      const seen = new Set<string>();
      /** Every exit from the loop that is not "the results ran out". */
      let cutShort: string | null = null;

      for (let page = 1; page <= maxPages; page++) {
        const url = page === 1 ? `${host}${path}` : `${host}${path}?pag=${page}`;

        let html: string;
        try {
          html = await ctx.fetch(url);
        } catch (err) {
          if (isPastLastPage(err)) {
            if (page > 1) break;
            cutShort = `the commune URL is missing (${(err as Error).message}) — check the path`;
          } else {
            cutShort = `index page ${page} failed: ${(err as Error).message}`;
          }
          console.warn(`[luxuryestate] ${path}: ${cutShort}`);
          break;
        }

        const fresh = listingUrlsOnPage(html, host).filter((u) => !seen.has(u));
        if (fresh.length === 0) break;

        for (const u of fresh) {
          seen.add(u);
          const id = u.match(ID_FROM_URL)?.[1];
          if (id) yield { externalId: id, url: u, communeHint: path };
        }

        if (page === maxPages) {
          cutShort = `hit the ${maxPages}-page ceiling with listings still arriving`;
          console.warn(`[luxuryestate] ${path}: ${cutShort}`);
        }
      }

      if (cutShort) ctx.incomplete(insee, cutShort);
    }
  },

  parse(html: string, url: string): ParseResult {
    const externalId = url.match(ID_FROM_URL)?.[1];
    if (!externalId) {
      return { status: "failed", error: `could not read a listing id out of ${url}` };
    }

    const nodes = extractJsonLd(html);
    const listingNode = nodesOfType(nodes, "RealEstateListing")[0] ?? null;
    if (!listingNode) {
      return { status: "failed", error: "no RealEstateListing node in JSON-LD" };
    }

    const listing = emptyListing(externalId, url);
    const main = (listingNode.mainEntity ?? {}) as JsonLdNode;
    listing.raw = { listing: listingNode, main };

    listing.title = str(main.name) ?? str(listingNode.name);
    listing.description = str(main.description);
    listing.propertyType = [...typeNames(main)][0] ?? null;

    // ── Price ─────────────────────────────────────────────────────────────
    const offer = firstOffer(listingNode);
    if (offer) {
      const currency = str(offer.priceCurrency);
      // Price arrives as a string here — "19600000" — not a number.
      const price = num(offer.price);
      if (price !== null && (currency === null || currency.toUpperCase() === "EUR")) {
        listing.priceEur = Math.round(price);
      }
      listing.availability = str(offer.availability);
    }

    // ── Size and rooms ────────────────────────────────────────────────────
    const floor = main.floorSize as JsonLdNode | undefined;
    if (floor) {
      const unit = str(floor.unitCode);
      const value = num(floor.value);
      /**
       * The unit is checked rather than assumed. LuxuryEstate serves several
       * markets and the same field carries square feet elsewhere — silently
       * storing 6,458 ft² as 6,458 m² would put a Saint-Tropez villa on a plot
       * the size of a village.
       */
      if (value !== null && (unit === null || unit === SQUARE_METRES)) {
        listing.areaM2 = value;
      } else if (value !== null) {
        console.warn(`[luxuryestate] ${externalId}: floorSize in ${unit}, not m² — ignored`);
      }
    }

    const rooms = num(main.numberOfRooms);
    if (rooms !== null) listing.rooms = Math.round(rooms);

    for (const feature of asArray(main.amenityFeature)) {
      const name = str((feature as JsonLdNode).name)?.toLowerCase();
      const value = num((feature as JsonLdNode).value);
      if (value === null) continue;
      if (name === "bedrooms") listing.bedrooms = Math.round(value);
      if (name === "bathrooms") listing.bathrooms = Math.round(value);
    }

    // ── Where ─────────────────────────────────────────────────────────────
    const addr = readAddress(main.address);
    listing.communeRaw = addr.locality;
    listing.postalCode = addr.postalCode;

    // The breadcrumb names the commune explicitly and is not written by the
    // agency, so it beats anything in the listing text.
    const fromCrumb = communeFromBreadcrumb(nodes);
    if (fromCrumb) listing.communeRaw = fromCrumb;

    /**
     * `datePosted` — CHECK BEFORE TRUSTING.
     *
     * On the page read on 2026-08-26 this was "2026-08-26", i.e. that day,
     * for a listing that already existed days earlier. It may be the date the
     * page was regenerated rather than the date the property came to market.
     * Captured so the question can be answered from data after a week of
     * collection; until then treat days-on-market from this field as unproven.
     */
    const posted = str(listingNode.datePosted);
    if (posted) {
      const d = new Date(posted);
      if (!Number.isNaN(d.getTime())) listing.publishedAt = d;
    }

    // ── Agency — the one thing not in the markup ──────────────────────────
    listing.agencyName = agencyFromHtml(html);

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null) missing.push("areaM2");
    if (!listing.agencyName) missing.push("agencyName");

    return missing.length === 0
      ? { status: "ok", listing }
      : { status: "partial", listing, missing };
  },
};

/**
 * "Presented by Excellence Real Estate".
 *
 * `offers.offeredBy` points at LuxuryEstate itself, so the actual listing agent
 * only appears in the rendered page. Matched on the label rather than a class
 * name — the label survives a restyle, the class will not.
 */
function agencyFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");
  const m = text.match(/presented by\s+([^\n|·]{2,80}?)(?:\s{2,}|\s*(?:Contact|Elite|Prestige)\b|$)/i);
  return m ? m[1].trim() : null;
}

function communeFromBreadcrumb(nodes: JsonLdNode[]): string | null {
  const crumbs = nodesOfType(nodes, "BreadcrumbList")[0];
  if (!crumbs) return null;
  const items = asArray(crumbs.itemListElement);
  // The last entry is the property itself; the one before it is the commune.
  const commune = items[items.length - 2] as JsonLdNode | undefined;
  const item = (commune?.item ?? {}) as JsonLdNode;
  const name = str(item.name);
  if (!name) return null;
  // Higher levels are suffixed — "Var - Department", "… - Region". A commune is not.
  return /-\s*(Department|Region)$/i.test(name) ? null : name;
}

function typeNames(main: JsonLdNode): Set<string> {
  const t = main["@type"];
  const list = Array.isArray(t) ? t : [t];
  return new Set(list.filter((x): x is string => typeof x === "string"));
}

function asArray(v: unknown): unknown[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function listingUrlsOnPage(html: string, host: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !ID_FROM_URL.test(href)) return;
    urls.add(href.startsWith("http") ? href : new URL(href, host).toString());
  });
  return [...urls];
}

export type { RawListing };
