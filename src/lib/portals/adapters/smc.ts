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

/**
 * SMC France — Maisons et Appartements + Résidences Immobilier.
 *
 * One adapter, two brands. They share an engine (identical internal paths,
 * `/routines/`, `/views/sitemapBuild.php`) and Maisons et Appartements links to
 * Résidences from its own menu as its "Biens de prestige" section. Same markup,
 * same URL grammar, different hostname.
 *
 * Chosen as the first adapter because its markup is the richest of any portal
 * on the list and, more importantly, because it has been read and verified
 * rather than assumed.
 */

/** `.../annonce-vente-maison-ramatuelle-4241469.html` → `4241469` */
const ID_FROM_URL = /-(\d+)\.html(?:$|[?#])/;

/**
 * The `name` field is a structured string:
 *   "Ramatuelle - Maison à vendre - 10 pièces - 320 m² - 9 500 000 €"
 * which is the only place rooms and floor area appear in the markup. Fragile in
 * principle — it is their title template — but it lives inside the JSON-LD they
 * maintain for search results, not in the CSS, so it survives redesigns.
 */
const NAME_ROOMS = /(\d+)\s*pièces?/i;
const NAME_AREA = /([\d\s.,]+)\s*m²/i;

export const smcAdapter: PortalAdapter = {
  key: "smc",
  name: "Maisons et Appartements / Résidences Immobilier",
  hosts: ["maisonsetappartements.fr", "www.maisonsetappartements.fr", "residences-immobilier.com", "www.residences-immobilier.com"],
  discoveryMode: "index",
  /** robots.txt sets no delay; one second is the neighbourly default. */
  defaultCrawlDelayMs: 1000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const slugs = (ctx.config.communeSlugs ?? {}) as Record<string, { slug: string; id: string }>;
    const host = (ctx.config.host as string) ?? "https://www.maisonsetappartements.fr";
    const maxPages = (ctx.config.maxPages as number) ?? 30;

    for (const insee of ctx.communeInsee) {
      const entry = slugs[insee];
      if (!entry) {
        // Loud, because a missing slug is a whole commune silently absent from
        // the product — the kind of gap that shows up as "the market is quiet".
        console.warn(`[smc] no commune slug configured for INSEE ${insee} — skipping`);
        continue;
      }

      const seen = new Set<string>();
      for (let page = 1; page <= maxPages; page++) {
        const suffix = page === 1 ? "" : `_${page}`;
        const url = `${host}/fr/83/biens/vente/selection-biens-${entry.slug}-${entry.id}${suffix}.html`;

        let html: string;
        try {
          html = await ctx.fetch(url);
        } catch (err) {
          console.warn(`[smc] index fetch failed ${url}:`, (err as Error).message);
          break;
        }

        const found = listingUrlsOnPage(html, host);
        // Stop on the first page that adds nothing. Their pagination happily
        // serves the last page forever past the end, so counting pages is not
        // enough — you have to notice you are going in circles.
        const fresh = found.filter((u) => !seen.has(u));
        if (fresh.length === 0) break;

        for (const u of fresh) {
          seen.add(u);
          const id = u.match(ID_FROM_URL)?.[1];
          if (!id) continue;
          yield { externalId: id, url: u, communeHint: entry.slug };
        }
      }
    }
  },

  parse(html: string, url: string): ParseResult {
    const externalId = url.match(ID_FROM_URL)?.[1];
    if (!externalId) {
      return { status: "failed", error: `could not read a listing id out of ${url}` };
    }

    const nodes = extractJsonLd(html);
    const product = nodesOfType(nodes, "Product")[0] ?? null;
    if (!product) {
      return { status: "failed", error: "no Product node in JSON-LD" };
    }

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

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null) missing.push("areaM2");
    if (!listing.agencyName) missing.push("agencyName");

    return missing.length === 0
      ? { status: "ok", listing }
      : { status: "partial", listing, missing };
  },
};

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
    if (!href) return;
    if (!/annonce-vente-[a-z]+-[a-z0-9-]+-\d+\.html/.test(href)) return;
    urls.add(href.startsWith("http") ? href : new URL(href, host).toString());
  });
  return [...urls];
}
