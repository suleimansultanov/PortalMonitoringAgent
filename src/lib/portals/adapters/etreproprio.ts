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
 * Etreproprio.
 *
 * Structured markup is good — price in euros, agency with a full postal
 * address — but floor area and room counts appear nowhere in it. `category` is
 * only ever "Maison à vendre". Those numbers live in the rendered page and in
 * the prose, so this adapter leans on selectors more than the SMC one does, and
 * that is the part which will break when they redesign.
 *
 * Their `robots.txt` disallows `/immobilier-recherche`, so discovery walks the
 * per-commune index pages rather than the search. The INSEE code is embedded in
 * those URLs — `immobilier-vente-saint-tropez-v83119` — which is where ten of
 * our twelve commune codes were confirmed from in the first place.
 */

/** `.../immobilier-26534913-vente-...` → `26534913` */
const ID_FROM_URL = /\/immobilier-(\d+)-/;

export const etreproprioAdapter: PortalAdapter = {
  key: "etreproprio",
  name: "Etreproprio",
  hosts: ["etreproprio.com", "www.etreproprio.com"],
  discoveryMode: "index",
  defaultCrawlDelayMs: 1000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const host = (ctx.config.host as string) ?? "https://www.etreproprio.com";
    const slugs = (ctx.config.communeSlugs ?? {}) as Record<string, string>;
    /**
     * Property types are separate index pages here. Omitting one silently drops
     * a whole category — apartments in Saint-Tropez are a third of the market.
     */
    const types = (ctx.config.types as string[]) ?? ["maison", "appartement", "terrain"];
    const maxPages = (ctx.config.maxPages as number) ?? 20;

    for (const insee of ctx.communeInsee) {
      const slug = slugs[insee];
      if (!slug) {
        console.warn(`[etreproprio] no commune slug for INSEE ${insee} — skipping`);
        continue;
      }

      for (const type of types) {
        const seen = new Set<string>();
        for (let page = 1; page <= maxPages; page++) {
          const suffix = page === 1 ? "" : `?page=${page}`;
          const url = `${host}/immobilier-vente-${slug}-v${insee}/${type}${suffix}`;

          let html: string;
          try {
            html = await ctx.fetch(url);
          } catch (err) {
            console.warn(`[etreproprio] index fetch failed ${url}:`, (err as Error).message);
            break;
          }

          const found = listingUrlsOnPage(html, host).filter((u) => !seen.has(u));
          // Their pagination serves the last page indefinitely past the end, so
          // page counting is not enough — you have to notice you are looping.
          if (found.length === 0) break;

          for (const u of found) {
            seen.add(u);
            const id = u.match(ID_FROM_URL)?.[1];
            if (id) yield { externalId: id, url: u, communeHint: slug };
          }
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
    if (!product) return { status: "failed", error: "no Product node in JSON-LD" };

    const listing = emptyListing(externalId, url);
    listing.raw = { product };

    listing.title = str(product.name);
    listing.description = str(product.description);
    listing.propertyType = str(product.category)?.replace(/à vendre/i, "").trim() ?? null;

    const offer = firstOffer(product);
    if (offer) {
      const currency = str(offer.priceCurrency);
      const price = num(offer.price);
      if (price !== null && (currency === null || currency.toUpperCase() === "EUR")) {
        listing.priceEur = Math.round(price);
      }
      listing.availability = str(offer.availability);

      const seller = offer.seller as Record<string, unknown> | undefined;
      if (seller) {
        listing.agencyName = str(seller.name);
        const addr = readAddress(seller.address);
        listing.agencyAddress = addr.full;
        listing.agencyPostalCode = addr.postalCode;
        listing.agencyCity = addr.locality;
      }
    }

    /**
     * `sku` is "161366" while the listing id in the URL is 26534913. What that
     * number refers to is unknown — it is neither the listing nor, as far as we
     * can tell, the agency. Ignored, like every other portal's `sku`.
     */

    applyDomFields(html, listing);
    applyCommuneFromUrl(url, listing);

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
 * Area, rooms and bedrooms from the rendered page.
 *
 * The fragile half of this adapter, and deliberately written against the text
 * rather than class names: labels like "412 m²" and "8 chambres" survive a
 * restyle, whereas `.caracteristiques span:nth-child(2)` does not.
 */
function applyDomFields(html: string, listing: RawListing): void {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  // Land area is stated as "Terrain 11 479 m²" — match it first and cut it out,
  // so the living-area pattern cannot pick it up by accident.
  const land = text.match(/terrain\s*(?:de\s*)?([\d\s.,]+)\s*m²/i);
  if (land) {
    const n = num(land[1]);
    if (n !== null && n > 0) listing.landM2 = n;
  }
  const withoutLand = land ? text.replace(land[0], " ") : text;

  const area = withoutLand.match(/([\d\s.,]+)\s*m²/);
  if (area) {
    const n = num(area[1]);
    if (n !== null && n > 0) listing.areaM2 = n;
  }

  const rooms = withoutLand.match(/(\d+)\s*pièces?/i);
  if (rooms) listing.rooms = Number(rooms[1]);

  const bedrooms = withoutLand.match(/(\d+)\s*chambres?/i);
  if (bedrooms) listing.bedrooms = Number(bedrooms[1]);
}

/**
 * The commune comes out of the URL rather than the page.
 *
 * Etreproprio embeds the INSEE code in its own paths — `...-v83119/maison` —
 * which is more reliable than anything printed on the listing, because agencies
 * routinely write "Saint-Tropez" for a property in Ramatuelle.
 */
function applyCommuneFromUrl(url: string, listing: RawListing): void {
  const m = url.match(/immobilier-vente-([a-z0-9-]+)-v(\d{5})/);
  if (!m) return;
  listing.communeRaw = m[1].replace(/-/g, " ");
  listing.postalCode = null;
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
