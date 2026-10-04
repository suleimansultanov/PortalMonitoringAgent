import * as cheerio from "cheerio";
import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
} from "../types";
import { extractJsonLd, firstOffer, nodesOfType, num, str } from "../jsonld";

/**
 * Zoopla Overseas (zoopla.co.uk/overseas) — the British portal's foreign
 * section. Written 2026-10-04.
 *
 * WRITTEN OFF IN AUGUST ON A MISREADING. The first research note filed it as
 * "closed" because robots.txt disallows `/property/` and `/search/`. Those are
 * the UK site's paths. The overseas section lives under `/overseas/property/…`
 * and `/overseas/details/<id>/`, which no rule touches (read in full
 * 2026-10-04: closed under it are only the map, print and photos sub-pages of
 * a details page and its contact form). `?pn=` is open; `?rpn=`, `?qpn=` and
 * `q=` are not, and are not used. No Crawl-delay is stated.
 *
 * ACCESS: `scripts/access-test.mjs --direct` from GitHub Actions served the
 * section's front page to our user-agent in a browser (2026-10-04). The plain
 * client gets Cloudflare's challenge, as on Figaro — the rule fires before
 * anyone looks at who is asking — so this source runs in browser mode.
 *
 * WHAT IT IS. Not agencies advertising on Zoopla: every listing looked at came
 * through one syndicator, Properstar (Lausanne), with the description
 * machine-translated into English. So:
 *   - there is no agency and no mandate reference. The advertiser is recorded
 *     in `raw`, NOT as the agency — stored as one it would become a single
 *     "agency" holding the whole portal, the `-` trap in Green-Acres again;
 *   - the prose will not match the French original on another portal, so
 *     deduplication has only price, surface and commune to go on here. Expect
 *     these to stand as their own properties more often than a French portal's
 *     would. That is a known limit of this source, not a fault to chase.
 *
 * GEOGRAPHY is theirs: Var → arrondissement (Draguignan) → the pre-2015
 * cantons (Grimaud, Saint-Tropez, Le Muy) → commune. The commune pages are
 * used, one per INSEE code, each stating its own total. Town slugs directly
 * under `/var/` answer "No results found" for every one of ours (measured);
 * and the Var as a whole cannot be walked — it states 1 585 results and stops
 * serving at page 40.
 *
 * PRICES. The headline is sterling. The euro figure is the listing's own, in
 * the data with its currency code; it is taken only when that code is EUR and
 * never derived from the pound.
 */

const HOST = "https://www.zoopla.co.uk";
const DRAGUIGNAN = "/overseas/property/france/provence-alpes-cote-dazur/var/draguignan";
/** Their page size, read off the result pages. */
const PAGE_SIZE = 25;

type Area = {
  /** Path under the Draguignan arrondissement. */
  path: string;
  /**
   * Keep a listing only if its address or teaser names one of these. For Les
   * Issambres, which is a locality of Roquebrune-sur-Argens: their page is the
   * whole commune, inland village and golf estate included.
   */
  mustMention?: string[];
};

/** INSEE → their commune page. Checked against their own answers on 2026-10-04. */
const AREAS: Record<string, Area> = {
  "83119": { path: "saint-tropez/saint-tropez-commune" },
  "83101": { path: "saint-tropez/ramatuelle" },
  "83065": { path: "saint-tropez/gassin" },
  "83048": { path: "saint-tropez/la-croix-valmer" },
  "83036": { path: "saint-tropez/cavalaire-sur-mer" },
  "83068": { path: "grimaud/grimaud-commune" },
  "83042": { path: "grimaud/cogolin" },
  "83115": { path: "grimaud/sainte-maxime" },
  "83094": { path: "grimaud/le-plan-de-la-tour" },
  "83063": { path: "grimaud/la-garde-freinet" },
  "83079": { path: "grimaud/la-mole" },
  "83107": { path: "le-muy/roquebrune-sur-argens", mustMention: ["issambres"] },
};

export function indexUrl(path: string, page: number): string {
  const base = `${HOST}${DRAGUIGNAN}/${path}/`;
  return page > 1 ? `${base}?pn=${page}` : base;
}

export function listingUrl(id: string): string {
  return `${HOST}/overseas/details/${id}/`;
}

const ID_FROM_URL = /\/overseas\/details\/(\d+)\/?(?:$|[?#])/;

type IndexItem = { id: string; url: string; address: string | null; teaser: string | null };

/**
 * A result page: its listings, the total it states, and whether it is their
 * "No results found" page — which is an answer, where a page with neither a
 * total nor that banner is one we could not read.
 */
export function readIndex(html: string): { items: IndexItem[]; total: number | null; empty: boolean } {
  const $ = cheerio.load(html);
  const stated = $('[data-testid="total-results"]').first().text();
  const total = /\d/.test(stated) ? Number(stated.replace(/[^\d]/g, "")) : null;
  const empty = total === null && /No results found/i.test($("h2").text());

  /**
   * Their results sit at SearchResultsPage → mainEntity (ItemList) →
   * itemListElement[] → item (Product). The shared flattener does not descend
   * into `mainEntity`, so the path is walked here — and only this path: a
   * Product anywhere else on the page is not a search result.
   */
  const items: IndexItem[] = [];
  const seen = new Set<string>();
  for (const page of nodesOfType(extractJsonLd(html), "SearchResultsPage")) {
    const list = page.mainEntity as { itemListElement?: unknown } | undefined;
    const elements = Array.isArray(list?.itemListElement) ? list.itemListElement : [];
    for (const el of elements) {
      const node = (el as { item?: Record<string, unknown> } | null)?.item;
      if (!node || typeof node !== "object") continue;
      const id = str(node.url)?.match(ID_FROM_URL)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const about = node.isRelatedTo as Record<string, unknown> | undefined;
      items.push({ id, url: listingUrl(id), address: str(about?.address), teaser: str(node.description) });
    }
  }
  return { items, total, empty };
}

const plain = (s: string | null) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** One square foot in square metres — exact by definition. */
const M2_PER_SQ_FT = 0.09290304;

/** Their property types, in the words the other adapters store. */
const TYPES: Record<string, string> = {
  detached: "Maison",
  semi_detached: "Maison",
  terraced: "Maison",
  town_house: "Maison de ville",
  villa: "Villa",
  bungalow: "Maison",
  cottage: "Maison",
  country_house: "Propriété",
  farmhouse: "Propriété",
  chateau: "Château",
  flat: "Appartement",
  maisonette: "Appartement",
  studio: "Appartement",
  penthouse: "Appartement",
  land: "Terrain",
  plot: "Terrain",
  parking: "Parking",
};

/**
 * The town out of their free-form address line:
 *   "Clos De La Tour, Le Plan-De-La-Tour, Fr"  ·  "Grimaud, 83310, France"
 *   "Les Issambres, St Raphaël, Ste Maxime Area, French Riviera"
 * Country, department number, postcode and region are peeled off the end; the
 * last thing left is the town, and anything before it is a street. Returned as
 * printed — matching it to a commune is done centrally, not here.
 */
export function townOf(address: string | null): string | null {
  if (!address) return null;
  // "83310 Cogolin" — a postcode glued to the front of the town.
  const parts = address.split(",").map((p) => p.trim().replace(/^\d{5}\s+(?=\S)/, "")).filter(Boolean);
  const isTail = (p: string) =>
    /^(fr|france|var|\d{2}|\d{5})$/i.test(p) ||
    // Region labels: "French Riviera", "Provence - Var", "Provence Coast (Cassis To Cavalaire)", "… Area".
    /provence|riviera|c[oô]te d'?azur|\bcoast\b|\barea$/i.test(p);
  // "…, St Raphaël, Ste Maxime Area, …" is one region label split by its own comma.
  const kept = parts.filter((p, i) => !isTail(p) && !/\barea$/i.test(parts[i + 1] ?? ""));
  return kept.length > 0 ? kept[kept.length - 1] : null;
}

/** Their dates carry no zone and are UK time. */
function londonDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const asUtc = new Date(`${v}Z`);
  if (Number.isNaN(asUtc.getTime()) || asUtc.getUTCFullYear() < 1990) return null;
  const there = new Date(asUtc.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const utc = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(asUtc.getTime() - (there.getTime() - utc.getTime()));
}

type Details = {
  listingId?: string | number;
  title?: string | null;
  displayAddress?: string | null;
  detailedDescription?: string | null;
  publishedOn?: string | null;
  propertyType?: string | null;
  adTargeting?: {
    currencyCode?: string | null;
    price?: number | null;
    priceActual?: number | null;
    listingStatus?: string | null;
    sizeSqFeet?: string | number | null;
  } | null;
  counts?: { numBedrooms?: number | null; numBathrooms?: number | null; numLivingRooms?: number | null } | null;
  floorArea?: { value?: number | null; unitsLabel?: string | null } | null;
  location?: { postalCode?: string | null; coordinates?: { latitude?: number; longitude?: number; isApproximate?: boolean } | null } | null;
  branch?: { name?: string | null; address?: string | null; branchId?: string | null } | null;
  propertyImage?: { filename?: string | null }[] | null;
  statusSummary?: { label?: string | null } | null;
};

/** The listing's own data on a detail page: `__NEXT_DATA__ → pageProps.listingDetails`. */
function readDetails(html: string): Details | null {
  const raw = cheerio.load(html)("#__NEXT_DATA__").first().contents().text().trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { props?: { pageProps?: { listingDetails?: unknown } } };
    const d = parsed?.props?.pageProps?.listingDetails;
    return d && typeof d === "object" ? (d as Details) : null;
  } catch {
    return null;
  }
}

const positive = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

export const zooplaAdapter: PortalAdapter = {
  key: "zoopla-overseas",
  name: "Zoopla Overseas",
  hosts: ["www.zoopla.co.uk", "zoopla.co.uk"],
  discoveryMode: "index",
  /** Ours; their robots.txt states none. */
  defaultCrawlDelayMs: 5_000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const areas = (ctx.config.areas as Record<string, Area> | undefined) ?? AREAS;
    const maxPages = Number(ctx.config.maxPages ?? 40);

    for (const insee of ctx.communeInsee) {
      const area = areas[insee];
      if (!area) {
        ctx.incomplete(insee, "no Zoopla area configured for this commune");
        continue;
      }

      const seen = new Set<string>();
      let total: number | null = null;
      let elsewhere = 0;
      let knownStreak = 0;
      let cutShort: string | null = null;
      let stoppedOnKnown = false;

      for (let page = 1; page <= maxPages; page++) {
        if (total !== null && (page - 1) * PAGE_SIZE >= total) break;

        let html: string;
        try {
          html = await ctx.fetch(indexUrl(area.path, page));
        } catch (err) {
          cutShort = `index page ${page} failed: ${(err as Error).message}`;
          break;
        }
        const index = readIndex(html);
        // Their own "No results found": a commune with nothing listed, which is an answer.
        if (index.empty) break;
        if (index.total === null && index.items.length === 0) {
          cutShort = `index page ${page} carried neither listings nor a total`;
          break;
        }
        total ??= index.total;

        const fresh = index.items.filter((i) => !seen.has(i.id));
        if (fresh.length === 0) break;

        for (const item of fresh) {
          seen.add(item.id);
          if (area.mustMention) {
            const hay = plain(`${item.address ?? ""} ${item.teaser ?? ""}`);
            if (!area.mustMention.some((m) => hay.includes(plain(m)))) {
              elsewhere += 1;
              continue;
            }
          }
          if (ctx.delta) {
            if (ctx.delta.knows(item.id)) {
              knownStreak += 1;
              if (knownStreak >= ctx.delta.after) {
                stoppedOnKnown = true;
                break;
              }
              continue;
            }
            knownStreak = 0;
          }
          yield { externalId: item.id, url: item.url, communeHint: insee };
        }
        if (stoppedOnKnown) break;
      }

      if (elsewhere > 0) {
        console.log(`[zoopla] ${insee}: ${elsewhere} listings on the page are elsewhere in the commune — left out`);
      }
      if (stoppedOnKnown) {
        ctx.incomplete(insee, `stopped after ${knownStreak} listings we already hold — the rest is older`);
      } else if (cutShort) {
        ctx.incomplete(insee, cutShort);
      } else if (total !== null && seen.size < total) {
        ctx.incomplete(insee, `read ${seen.size} of the ${total} they state`);
      }
    }
  },

  parse(html: string, url: string): ParseResult {
    const externalId = url.match(ID_FROM_URL)?.[1];
    if (!externalId) return { status: "failed", error: `could not read a listing id out of ${url}` };

    const d = readDetails(html);
    if (!d) return { status: "failed", error: "page carried no listing data (__NEXT_DATA__)" };
    if (d.listingId !== undefined && String(d.listingId) !== externalId) {
      return { status: "failed", error: `page is listing ${String(d.listingId)}, not ${externalId}` };
    }
    const status = d.adTargeting?.listingStatus ?? null;
    if (status && status !== "for_sale") return { status: "failed", error: `not for sale (${status})` };

    const listing = emptyListing(externalId, url);
    const town = townOf(d.displayAddress ?? null);
    listing.title = [d.title?.trim() || null, town].filter(Boolean).join(" — ") || null;
    listing.description = d.detailedDescription
      ? cheerio.load(`<div>${d.detailedDescription.replace(/<br\s*\/?>/gi, "\n")}</div>`)("div").text().trim() || null
      : null;

    /**
     * Euros only, and only theirs. `price` is in the listing's own currency
     * and `priceActual` is the same thing in sterling at Zoopla's rate — the
     * figure the page leads with. Reading that one would move every price
     * with the pound.
     */
    const currency = d.adTargeting?.currencyCode?.toUpperCase() ?? null;
    listing.priceEur = currency === "EUR" ? positive(d.adTargeting?.price) : null;
    if (listing.priceEur === null) {
      // The index's JSON-LD carries the same offer; a detail page has it for the listing itself.
      const offer = nodesOfType(extractJsonLd(html), "Product").map((n) => firstOffer(n)).find(Boolean);
      const price = offer && str(offer.priceCurrency)?.toUpperCase() === "EUR" ? num(offer.price) : null;
      if (price !== null && price > 0) listing.priceEur = Math.round(price);
    }

    const type = d.propertyType?.trim().toLowerCase() ?? null;
    listing.propertyType = type ? (TYPES[type] ?? type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ")) : null;
    const isPlot = type === "land" || type === "plot";

    /** Their floor area is in the unit they print beside it — square feet, for a British reader. */
    const area = positive(d.floorArea?.value);
    const unit = d.floorArea?.unitsLabel?.toLowerCase() ?? "";
    const areaM2 =
      area === null
        ? (positive(d.adTargeting?.sizeSqFeet) !== null ? Math.round(positive(d.adTargeting?.sizeSqFeet)! * M2_PER_SQ_FT) : null)
        : /ft/.test(unit)
          ? Math.round(area * M2_PER_SQ_FT)
          : /m/.test(unit)
            ? area
            : null;
    listing.areaM2 = isPlot ? null : areaM2;
    listing.landM2 = isPlot ? areaM2 : null;
    listing.bedrooms = positive(d.counts?.numBedrooms);
    listing.bathrooms = positive(d.counts?.numBathrooms);
    // `rooms` (pièces) is not something they publish; bedrooms and receptions are not it.

    listing.communeRaw = town;
    listing.postalCode = d.location?.postalCode ?? d.displayAddress?.match(/\b(\d{5})\b/)?.[1] ?? null;
    const c = d.location?.coordinates;
    if (c && c.isApproximate === false && typeof c.latitude === "number" && typeof c.longitude === "number") {
      listing.lat = c.latitude;
      listing.lon = c.longitude;
    }

    /**
     * The advertiser is a syndicator, not the agency — see the note at the
     * top. Anything else that ever shows up here is taken as an agency.
     */
    const advertiser = d.branch?.name?.trim() || null;
    const syndicated = advertiser !== null && /^properstar$/i.test(advertiser);
    listing.agencyName = syndicated ? null : advertiser;
    listing.agencyAddress = syndicated ? null : d.branch?.address?.trim() || null;

    listing.imageUrls = [
      ...new Set(
        (d.propertyImage ?? [])
          .map((p) => p?.filename)
          .filter((f): f is string => typeof f === "string" && /^[\w.-]+$/.test(f))
          .map((f) => `https://lid.zoocdn.com/1024/768/${f}`),
      ),
    ];
    listing.imageUrl = listing.imageUrls[0] ?? null;

    listing.availability = status;
    listing.publishedAt = londonDate(d.publishedOn);

    listing.raw = {
      source: "zoopla-overseas",
      advertiser,
      syndicated,
      displayAddress: d.displayAddress ?? null,
      propertyType: d.propertyType ?? null,
      currency,
      priceGbp: positive(d.adTargeting?.priceActual),
      floorArea: d.floorArea?.value ? { value: d.floorArea.value, unit: d.floorArea.unitsLabel ?? null } : null,
      receptions: positive(d.counts?.numLivingRooms),
      statusLabel: d.statusSummary?.label ?? null,
      language: "en",
    };

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null && !(isPlot && listing.landM2 !== null)) missing.push("areaM2");
    // No agency on a syndicated listing is what this source is, not a gap in the parse.
    if (!listing.agencyName && !syndicated) missing.push("agencyName");
    return missing.length === 0 ? { status: "ok", listing } : { status: "partial", listing, missing };
  },
};
