import * as cheerio from "cheerio";
import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
} from "../types";

/**
 * Bien'ici (bienici.com) — the portal of the agency networks (Century 21,
 * Orpi, Guy Hoquet, Nestenn, Laforêt). Written 2026-09-28.
 *
 * WHY THIS ONE, AND WHY NOT THE OTHERS NEXT TO IT. The Stream.Estate pilot
 * showed which French portals carry the gulf that we do not: SeLoger,
 * Leboncoin, Idealista, Bien'ici. The first three refuse our identified
 * client even from a home connection (403, DataDome, robots.txt "only with
 * special permission"), and getting past that would mean passing ourselves
 * off as a visitor — which this project does not do. Bien'ici answered our
 * named client with 200 from a home connection on the page AND the data
 * endpoint (measured 2026-09-28), so it is collected the ordinary way.
 *
 * ROBOTS.TXT (read 2026-09-24): `User-agent: *` disallows `/annonces-*`,
 * `/*?mode=*`, `/recherche/*&*`, `/recherche/*,*`, `/*tri=*`, the contact
 * forms and the sold-price pages. `realEstateAds.json` is not disallowed, and
 * neither are single listing pages under `/annonce/`. No Crawl-delay.
 *
 * HOW. Their search page is a shell; the listings arrive from
 * `realEstateAds.json?filters={…}`, which is what the page itself calls. Each
 * record is complete — title, description, price, surfaces, rooms, agency,
 * reference, photos, publication and modification dates — so discovery hands
 * the record to ingest as `document` and no listing page is ever requested.
 * A night is about one request per hundred listings: ~25 requests for the
 * whole gulf, against thousands for a portal we have to read page by page.
 *
 * COMMUNES are their zone ids, resolved through their own `suggest.json` and
 * kept only where the suggestion's INSEE code matched ours (2026-09-28).
 * Every record also carries `district.insee_code`, and a record whose code is
 * not the commune asked for is dropped and counted — a zone that silently
 * widened would otherwise file its neighbours under it.
 */

const HOST = "https://www.bienici.com";
const PAGE_SIZE = 100;

/** INSEE → Bien'ici zone id, read off suggest.json with the INSEE checked. */
const ZONES: Record<string, string> = {
  "83036": "-971022", // Cavalaire-sur-Mer
  "83042": "-1208367", // Cogolin
  "83048": "-970875", // La Croix-Valmer
  "83063": "-276305", // La Garde-Freinet
  "83065": "-970827", // Gassin
  "83068": "-1208368", // Grimaud
  "83079": "-970876", // La Môle
  "83094": "-283726", // Le Plan-de-la-Tour
  "83101": "-970871", // Ramatuelle
  "83107": "-168415", // Roquebrune-sur-Argens
  "83115": "-223565", // Sainte-Maxime
  "83119": "-970823", // Saint-Tropez
};

/** Their property types, in the words the other adapters store. */
const TYPES: Record<string, string> = {
  flat: "Appartement",
  house: "Maison",
  loft: "Loft",
  castle: "Château",
  townhouse: "Maison de ville",
  terrain: "Terrain",
  building: "Immeuble",
  parking: "Parking",
  shop: "Commerce",
  premises: "Local",
  office: "Bureau",
  others: "Autre",
  programme: "Programme neuf",
};

/**
 * Their text fields arrive HTML-escaped and sometimes with markup:
 * "Terrain &agrave; b&acirc;tir", "…commodités.<br>Dès l'entrée…". Seen on the
 * client's dashboard 2026-10-02 as literal "&agrave;". Decoded through cheerio
 * (already a dependency) so every named and numeric entity is covered; <br>
 * becomes a line break, other tags are dropped.
 */
function clean(v: string | null | undefined): string | null {
  if (!v) return null;
  const withBreaks = v.replace(/<br\s*\/?>/gi, "\n");
  const text = cheerio.load(`<div>${withBreaks}</div>`)("div").text();
  const out = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return out || null;
}

type Photo = { url?: string; url_photo?: string; photo?: string };
type Ad = {
  id: string;
  reference?: string | null;
  title?: string | null;
  description?: string | null;
  price?: number | number[] | null;
  priceHasDecreased?: boolean;
  surfaceArea?: number | null;
  landSurfaceArea?: number | null;
  roomsQuantity?: number | null;
  bedroomsQuantity?: number | null;
  bathroomsQuantity?: number | null;
  propertyType?: string | null;
  transactionType?: string | null;
  adType?: string | null;
  city?: string | null;
  postalCode?: string | null;
  district?: { insee_code?: string; code_insee?: string; name?: string } | null;
  publicationDate?: string | null;
  modificationDate?: string | null;
  accountDisplayName?: string | null;
  accountType?: string | null;
  adCreatedByPro?: boolean;
  newProperty?: boolean;
  energyClassification?: string | null;
  photos?: Photo[];
  status?: { onTheMarket?: boolean } & Record<string, unknown>;
  [k: string]: unknown;
};

/**
 * Fields that change between two identical requests — the viewer's own
 * state, promotion flags, phone-reveal counters. Left in, they would change
 * the stored document's hash every night and make every listing look edited.
 */
const VOLATILE = [
  "userRelativeData",
  "phoneDisplays",
  "highlightMailContact",
  "endOfPromotedAsExclusive",
  "blurInfo",
] as const;

function stable(ad: Ad): string {
  const copy: Record<string, unknown> = { ...ad };
  for (const k of VOLATILE) delete copy[k];
  if (copy.status && typeof copy.status === "object") {
    const { onTheMarket, closedByUser, autoImported } = copy.status as Record<string, unknown>;
    copy.status = { onTheMarket, closedByUser, autoImported };
  }
  return JSON.stringify(copy);
}

/** Their "no date" is the Unix epoch. */
function date(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990) return null;
  return d;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

export function listingUrl(id: string): string {
  return `${HOST}/annonce/${encodeURIComponent(id)}`;
}

export function searchUrl(zoneId: string, from: number, size = PAGE_SIZE): string {
  const filters = {
    size,
    from,
    showAllModels: false,
    filterType: "buy",
    page: Math.floor(from / size) + 1,
    sortBy: "publicationDate",
    sortOrder: "desc",
    onTheMarket: [true],
    zoneIdsByTypes: { zoneIds: [zoneId] },
  };
  return `${HOST}/realEstateAds.json?filters=${encodeURIComponent(JSON.stringify(filters))}`;
}

export const bieniciAdapter: PortalAdapter = {
  key: "bienici",
  name: "Bien'ici",
  hosts: ["www.bienici.com", "bienici.com"],
  discoveryMode: "index",
  /** Ours; their robots.txt states none. About 25 requests a night at this pace. */
  defaultCrawlDelayMs: 3_000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const zones = (ctx.config.zones as Record<string, string> | undefined) ?? ZONES;
    const maxPages = Number(ctx.config.maxPages ?? 20);

    for (const insee of ctx.communeInsee) {
      const zone = zones[insee];
      if (!zone) {
        ctx.incomplete(insee, "no Bien'ici zone configured for this commune");
        continue;
      }

      const seen = new Set<string>();
      let total: number | null = null;
      let foreign = 0;
      let knownStreak = 0;
      let cutShort: string | null = null;

      for (let page = 0; page < maxPages; page++) {
        const from = page * PAGE_SIZE;
        if (total !== null && from >= total) break;

        let body: string;
        try {
          body = await ctx.fetch(searchUrl(zone, from));
        } catch (err) {
          cutShort = `page ${page + 1} failed: ${(err as Error).message}`;
          break;
        }

        let parsed: { total?: number; realEstateAds?: Ad[] };
        try {
          parsed = JSON.parse(body);
        } catch {
          cutShort = `page ${page + 1} was not JSON (${body.slice(0, 60).replace(/\s+/g, " ")}…)`;
          break;
        }
        total ??= typeof parsed.total === "number" ? parsed.total : null;
        const ads = parsed.realEstateAds ?? [];

        /**
         * Asked past the end, their endpoint does not answer empty — it
         * returns the tail again (measured: from=480 on a total of 110 gave 14
         * records). So the loop is bounded by `total`, and a page that brings
         * nothing new ends the commune rather than going round.
         */
        const fresh = ads.filter((a) => a?.id && !seen.has(a.id));
        if (fresh.length === 0) break;

        for (const ad of fresh) {
          seen.add(ad.id);
          const adInsee = ad.district?.insee_code ?? ad.district?.code_insee ?? null;
          if (adInsee && adInsee !== insee) {
            foreign += 1;
            continue;
          }
          if (ad.transactionType && ad.transactionType !== "buy") continue;

          if (ctx.delta) {
            if (ctx.delta.knows(ad.id)) {
              knownStreak += 1;
              if (knownStreak >= ctx.delta.after) {
                cutShort = `stopped after ${knownStreak} listings we already hold — the rest is older`;
                break;
              }
              continue;
            }
            knownStreak = 0;
          }

          yield {
            externalId: ad.id,
            url: listingUrl(ad.id),
            communeHint: insee,
            sourceUpdatedAt: date(ad.modificationDate),
            document: stable(ad),
          };
        }
        if (cutShort) break;
      }

      if (foreign > 0) {
        console.warn(`[bienici] ${insee}: ${foreign} records from other communes dropped`);
      }
      if (cutShort && !cutShort.startsWith("stopped after")) {
        ctx.incomplete(insee, cutShort);
      } else if (total !== null && seen.size < total && !cutShort) {
        ctx.incomplete(insee, `read ${seen.size} of the ${total} they state (page cap ${maxPages})`);
      }
    }
  },

  parse(doc: string, url: string): ParseResult {
    let ad: Ad;
    try {
      ad = JSON.parse(doc) as Ad;
    } catch {
      return { status: "failed", error: "document is not a Bien'ici record" };
    }
    if (!ad?.id) return { status: "failed", error: "record has no id" };
    if (ad.transactionType && ad.transactionType !== "buy") {
      return { status: "failed", error: `not for sale (${ad.transactionType})` };
    }

    const listing = emptyListing(ad.id, url || listingUrl(ad.id));
    listing.title = clean(ad.title);
    listing.description = clean(ad.description);

    /**
     * EUR by construction: the site is French-only and has no currency
     * picker. A new-build programme gives a price RANGE as an array; that is
     * not one home's price, so it is left null and the range kept in raw.
     */
    listing.priceEur = Array.isArray(ad.price) ? null : num(ad.price);

    listing.propertyType = (ad.propertyType && TYPES[ad.propertyType]) ?? ad.propertyType ?? null;
    const isPlot = ad.propertyType === "terrain";
    listing.areaM2 = isPlot ? null : num(ad.surfaceArea);
    listing.landM2 = num(ad.landSurfaceArea) ?? (isPlot ? num(ad.surfaceArea) : null);
    listing.rooms = num(ad.roomsQuantity);
    listing.bedrooms = num(ad.bedroomsQuantity);
    listing.bathrooms = num(ad.bathroomsQuantity);

    listing.communeRaw = ad.district?.name ?? ad.city ?? null;
    listing.postalCode = ad.postalCode ?? null;
    // Coordinates deliberately not stored: theirs are blurred on purpose
    // (`blurInfo`), the same reason Figaro's centroids are not taken.

    listing.agencyName = ad.accountDisplayName?.trim() || null;
    listing.agencyRef = ad.reference?.trim() || null;

    /**
     * Their own CDN copy first, always on one host (`file.bienici.com`) with a
     * file-like name. Built from `photo` when `url` is missing, and only then
     * the agency's original (`url_photo`), which can be any storage with no
     * extension at all — e.g. an OVH object ending in `/raw` (2026-10-02),
     * which loads in a plain <img> but trips any image pipeline that checks
     * hosts or extensions.
     */
    const photos = (ad.photos ?? [])
      .map((p) =>
        p.url ?? (p.photo ? `https://file.bienici.com/photo/${p.photo}` : null) ?? p.url_photo ?? null,
      )
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    listing.imageUrls = [...new Set(photos)];
    listing.imageUrl = listing.imageUrls[0] ?? null;

    listing.publishedAt = date(ad.publicationDate);
    listing.sourceUpdatedAt = date(ad.modificationDate);

    listing.raw = {
      source: "bienici",
      accountType: ad.accountType ?? null,
      byProfessional: ad.adCreatedByPro ?? null,
      newProperty: ad.newProperty ?? null,
      priceHasDecreased: ad.priceHasDecreased ?? null,
      energyClass: ad.energyClassification ?? null,
      ...(Array.isArray(ad.price) ? { priceRange: ad.price } : {}),
    };

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null && !(isPlot && listing.landM2 !== null)) missing.push("areaM2");
    if (!listing.agencyName) missing.push("agencyName");
    return missing.length === 0 ? { status: "ok", listing } : { status: "partial", listing, missing };
  },
};
