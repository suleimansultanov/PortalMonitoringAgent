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
import { ETREPROPRIO_SLUGS } from "../communePaths";
import { GULF_OF_SAINT_TROPEZ } from "../communes";
import { isPastLastPage } from "../runner/fetcher";

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

    /** Listings their index pages offered from communes we do not watch. */
    let skippedElsewhere = 0;

    for (const insee of ctx.communeInsee) {
      const slug = slugs[insee];
      if (!slug) {
        console.warn(`[etreproprio] no commune slug for INSEE ${insee} — skipping`);
        continue;
      }

      /**
       * One flag for the commune, not one per property type. Houses and
       * apartments in Saint-Tropez are separate index pages but the same
       * commune, and the delisting decision is made per commune — so a
       * truncated apartment crawl has to shield the houses too. Narrower would
       * be wrong, not merely cautious.
       */
      let cutShort: string | null = null;

      for (const type of types) {
        const seen = new Set<string>();
        for (let page = 1; page <= maxPages; page++) {
          const suffix = page === 1 ? "" : `?page=${page}`;
          const url = `${host}/immobilier-vente-${slug}-v${insee}/${type}${suffix}`;

          let html: string;
          try {
            html = await ctx.fetch(url);
          } catch (err) {
            if (isPastLastPage(err)) {
              if (page > 1) break;
              cutShort = `the ${type} URL is missing (${(err as Error).message}) — check the slug`;
            } else {
              cutShort = `${type} page ${page} failed: ${(err as Error).message}`;
            }
            console.warn(`[etreproprio] ${slug}: ${cutShort}`);
            break;
          }

          /**
           * `seen` holds every listing link this page walk has met, INCLUDING
           * the ones filtered out for being in another commune. Two reasons,
           * and both were bugs in the first version of this filter.
           *
           * The end-of-pagination test is "did this page show us anything we
           * had not already met". Testing it on the KEPT links instead would
           * read a page whose listings all happen to be neighbours as the end
           * of the results, and stop the commune there — silently, since an
           * ordinary ending reports nothing.
           *
           * And their "nearby" block repeats on every page, so counting
           * filtered links per page rather than per URL reported the same
           * handful of Fréjus listings once for each page of the walk.
           */
          const onPage = listingUrlsOnPage(html, host);
          const fresh = onPage.filter((u) => !seen.has(u));

          /**
           * Where a commune actually runs out, from inside the crawl.
           *
           * Their index is rebuilt by a script after load, so what a browser
           * shows and what the server sent are different documents — three
           * separate readings from the browser today contradicted the crawl and
           * each other. This line reads the only document that matters: the one
           * we parse. Page number, links present, links new. Any pagination
           * story can be read straight off it, and none has to be guessed at.
           *
           * Behind a flag because a full pass would print several hundred
           * lines. `COLLECT_DEBUG_PAGES=1 npm run collect -- --source=etreproprio
           * --communes=83101` is the shape it was written for.
           */
          if (process.env.COLLECT_DEBUG_PAGES) {
            console.log(
              `  [${slug}/${type}] page ${String(page).padStart(3)}: ` +
                `${String(onPage.length).padStart(3)} links, ${String(fresh.length).padStart(3)} new, ` +
                `${String(seen.size + fresh.length).padStart(4)} total so far` +
                `${html.length < 20_000 ? "  ⚠ page only " + Math.round(html.length / 1024) + " KB" : ""}`,
            );
          }

          // Their pagination serves the last page indefinitely past the end, so
          // page counting is not enough — you have to notice you are looping.
          if (fresh.length === 0) break;

          for (const u of fresh) {
            seen.add(u);
            if (!inAWatchedCommune(u)) {
              skippedElsewhere += 1;
              continue;
            }
            const id = u.match(ID_FROM_URL)?.[1];
            if (id) yield { externalId: id, url: u, communeHint: slug };
          }

          if (page === maxPages) {
            cutShort = `${type} hit the ${maxPages}-page ceiling with listings still arriving`;
            console.warn(`[etreproprio] ${slug}: ${cutShort}`);
          }
        }
      }

      if (cutShort) ctx.incomplete(insee, cutShort);
    }

    if (skippedElsewhere > 0) {
      // Stated rather than silent: if this number ever collapses, their index
      // stopped offering neighbours — and if it explodes, the filter is wrong.
      console.log(
        `[etreproprio] skipped ${skippedElsewhere} listing links from communes ` +
          `outside the client's market`,
      );
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
/**
 * The two numbers with "m²" in an advert, told apart.
 *
 * Every listing here carries a floor area and a plot size in the same prose,
 * and putting the plot in the floor-area column is not a visible fault: 2168 is
 * an ordinary number, nothing rejects it, and the price per square metre it
 * produces is wrong by a factor of twenty while looking entirely normal. Ninety
 * eight listings were like this on 2026-09-04.
 *
 * Two things went wrong, and they are separate.
 *
 * THE PLOT IS NOT ALWAYS NAMED FIRST. The old pattern matched "Terrain de
 * 11 479 m²" — the word, then the number. Agencies write it the other way round
 * at least as often: "villa T3 sur 2168 m² de terrain", "sur un terrain de 900
 * m²", "10 000 m² de terrain". Unmatched means uncut, and the first "N m²" left
 * in the text is then the plot.
 *
 * A NUMBER MUST NOT START IN THE MIDDLE OF A WORD. French writes thousands with
 * a space — "11 479 m²" — so the pattern has to allow a space inside a number.
 * In "maison t6 110m²" that turns "6", space, "110" into 6110. The guard is
 * that a number may not begin immediately after a letter or a digit.
 *
 * AND IT MUST START WITH A DIGIT. This is the one that had been running in
 * production: the character class allowed a comma, so in "…de terrain, 95 m²"
 * the match began at the comma and the value read back was ", 95" — which the
 * number parser, seeing a comma, took for a decimal separator. 0.95 m².
 *
 * That is where the impossible areas in the data came from: 0,655 for a house
 * of 655 m², 0,2006 for 200,6, 0,12 for 12. They looked like a unit confusion
 * — ares against square metres — and they were a regular expression eating the
 * punctuation in front of the number.
 */
export function sizesFromText(text: string): {
  areaM2: number | null;
  landM2: number | null;
  remainder: string;
} {
  /** "terrain de 900 m²" and "900 m² de terrain", in that order of preference. */
  const LAND_PATTERNS = [
    /terrain\s*(?:de\s*)?(?<![\p{L}\d])(\d[\d\s.,]*\d|\d)\s*m²/iu,
    /(?<![\p{L}\d])(\d[\d\s.,]*\d|\d)\s*m²\s*(?:de\s*)?(?:terrain|parcelle|jardin)/iu,
    /sur\s*(?:un\s*terrain\s*de\s*)?(?<![\p{L}\d])(\d[\d\s.,]*\d|\d)\s*m²\s*(?:de\s*terrain)/iu,
  ];

  let landM2: number | null = null;
  let remainder = text;
  for (const pattern of LAND_PATTERNS) {
    const m = remainder.match(pattern);
    if (!m) continue;
    const n = num(m[1]);
    if (n === null || n <= 0) continue;
    landM2 = n;
    remainder = remainder.replace(m[0], " ");
    break;
  }

  const area = remainder.match(/(?<![\p{L}\d])(\d[\d\s.,]*\d|\d)\s*m²/u);
  const areaM2 = area ? num(area[1]) : null;

  return {
    areaM2: areaM2 !== null && areaM2 > 0 ? areaM2 : null,
    landM2,
    remainder,
  };
}

function applyDomFields(html: string, listing: RawListing): void {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  /**
   * REVERTED to the older extraction on 2026-09-05, deliberately.
   *
   * `sizesFromText` below is the replacement, and it is wrong in a way the unit
   * tests did not catch: run against the saved pages it turned 1010 into 10,
   * 2270 into 270, 2409 into 409 — the first digit of the number goes missing.
   * The tests pass on the sentences I wrote for them and fail on the pages the
   * portal actually publishes, which is the difference between a fixture and
   * the world.
   *
   * The old version's fault is known and bounded: it files a plot's size as the
   * floor area on about 55 listings. The new one's fault is unbounded — it
   * would corrupt an area on any listing where it fires, including the ones
   * that are currently right, and the nightly would write those before anyone
   * looked. Between a known wrong number and an unknown one, keep the known.
   *
   *   npm run reparse -- --source=etreproprio --explain=24070038
   *
   * prints what the page actually says around every "m²", which is what the
   * next attempt should be built from.
   */
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

  const gallery = galleryFrom($);
  if (gallery.length > 0) {
    listing.imageUrls = gallery;
    listing.imageUrl = gallery[0];
  }
}

/**
 * Photographs, in the order the agency arranged them.
 *
 * The JSON-LD `image` looks usable and is not: it is a redirect endpoint
 * (`/photo-immobilier-26556722`), one per listing, so it yields a single
 * picture and only after a round trip. The files themselves are plain <img>
 * sources under `storage.etreproprio.com/classified/image/`.
 *
 * Ordered by the caption rather than by document order, for the same reason
 * Green-Acres is: each photo appears twice on the page — gallery and carousel —
 * so document order is really "whatever the template did". Etreproprio's URLs
 * are random UUIDs with no sequence in them, but every <img> carries
 * `alt="… - photo 7"`, and that number is the only thing that puts the front of
 * the house before the boiler cupboard.
 *
 * Only the `_ptw0` size is served here; the detail page publishes no srcset and
 * no full-size variant, so there is nothing larger to prefer.
 */
function galleryFrom($: cheerio.CheerioAPI): string[] {
  const order = new Map<string, number>();
  $('img[src*="/classified/image/"]').each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;
    const captioned = $(el).attr("alt")?.match(/photo\s+(\d+)\s*$/i)?.[1];
    const n = captioned ? Number(captioned) : 9999;
    const seen = order.get(src);
    if (seen === undefined || n < seen) order.set(src, n);
  });
  return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([url]) => url);
}

/**
 * The commune comes out of the URL rather than the page — and it has to.
 *
 * Their JSON-LD carries `addressLocality: "Labège", postalCode: "31670"` on
 * every listing: that is Etreproprio's own office near Toulouse, not the
 * property. Reading it because it looks structured would move the whole Gulf of
 * Saint-Tropez to the Haute-Garonne, plausibly and silently.
 *
 * TWO URL SHAPES, AND ONLY ONE OF THEM WAS HANDLED
 *
 * Their search pages carry the INSEE code — `/immobilier-vente-ramatuelle-v83101/maison`
 * — and the original pattern read that. But a listing URL looks like
 * `/immobilier-24697579-vente-superbe-propriete-...-ramatuelle`: no INSEE, and
 * the commune is the last segment rather than the first. The pattern therefore
 * never matched a single detail page, and every listing arrived with no commune
 * at all — which means no property row, which means invisible on every screen.
 *
 * The trailing slug is matched against the ones we configured rather than taken
 * positionally, and the longest match wins, so "la-croix-valmer" is not read as
 * "valmer". The canonical label is then handed to `resolveCommune`, which is
 * built from exactly those labels — no second spelling to keep in step.
 */
function applyCommuneFromUrl(url: string, listing: RawListing): void {
  // Search-page form, kept in case discovery ever yields one.
  const indexed = url.match(/immobilier-vente-([a-z0-9-]+)-v(\d{5})/);
  if (indexed) {
    listing.communeRaw = indexed[1].replace(/-/g, " ");
    listing.postalCode = null;
    return;
  }

  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return;
  }

  const bestSlug = watchedCommuneSlug(path);
  if (!bestSlug) return;

  const insee = Object.keys(ETREPROPRIO_SLUGS).find((i) => ETREPROPRIO_SLUGS[i] === bestSlug);
  const entry = insee ? GULF_OF_SAINT_TROPEZ.find((c) => c.insee === insee) : undefined;

  listing.communeRaw = entry?.label ?? bestSlug.replace(/-/g, " ");
  listing.postalCode = null;
}

/**
 * The commune slug this URL ends with, if it is one we watch.
 *
 * Longest match wins, so "la-croix-valmer" is not read as "valmer" and a
 * commune whose name contains another's cannot be filed under the wrong one.
 */
function watchedCommuneSlug(path: string): string | null {
  let best: string | null = null;
  for (const slug of Object.values(ETREPROPRIO_SLUGS)) {
    if (path.endsWith(`-${slug}`) && (best === null || slug.length > best.length)) {
      best = slug;
    }
  }
  return best;
}

/**
 * Their index pages carry listings from communes we do not watch.
 *
 * Measured 2026-08-29: 130 of 1437 pages collected were Fréjus, Hyères, Saint-
 * Raphaël, La Seyne-sur-Mer, Bormes-les-Mimosas — and Moissac-Bellevue, which
 * is a hundred kilometres inland by the Verdon gorges. They arrive through the
 * "nearby" block their index pages append, and taking every listing link on the
 * page takes those too. The same shape as Superimmo's "similar properties"
 * strip putting a neighbour's kitchen in a villa's gallery.
 *
 * They were never wrong in the database — the parser correctly refused to
 * invent a commune for them, so they sat with a null and appeared on no screen.
 * They were simply 130 fetches per pass, every pass, for stock in a market the
 * client does not work in.
 *
 * Filtering on the URL rather than on the parsed page is what makes it free:
 * the decision happens before the request. Verified against all 1437 saved
 * pages — this drops exactly those 130 and none of the 1307 that resolved.
 */
function inAWatchedCommune(url: string): boolean {
  try {
    return watchedCommuneSlug(new URL(url).pathname.replace(/\/+$/, "")) !== null;
  } catch {
    return false;
  }
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
