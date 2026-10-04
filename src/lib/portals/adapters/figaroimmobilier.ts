import * as cheerio from "cheerio";
import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
} from "../types";
import { findByKeys, readNuxtData } from "../nuxtData";

/**
 * Figaro Immobilier (immobilier.lefigaro.fr) — Groupe Figaro's mass-market
 * portal, the sibling of Propriétés Le Figaro. Written 2026-10-04.
 *
 * ACCESS, MEASURED BEFORE A LINE OF THIS WAS WRITTEN. `scripts/access-test.mjs
 * --direct` from GitHub Actions (2026-10-04): index and three listings 200,
 * our own user-agent, no challenge. Propriétés refuses the same runner; this
 * site does not. No written permission is on file for it — Groupe Figaro's
 * reply of 25 Aug was about Propriétés — and on robots.txt none is needed.
 *
 * ROBOTS.TXT (read 2026-10-04): `User-agent: *` disallows `/annonce/` (the
 * singular), `/recherche/`, `/rest/`, `/api/`, `/s/`, `/annonces/*?` with
 * `Allow: /annonces/*page=*` taking precedence, and
 * `/annonces/immobilier+prestige-*`. The commune index
 * `/annonces/immobilier-vente-bien-<ville>+<cp>.html` and its `?page=N` are
 * open, as are listings under `/annonces/annonce-<id>.html`. No Crawl-delay.
 *
 * HOW. The index ships the state Nuxt rendered it from, and its
 * `classifiedsListResponse.classifieds` are COMPLETE records — full
 * description, photos, agency with address, mandate reference, surfaces,
 * rooms, publication and edit dates. So discovery hands each record to ingest
 * as `document` and no listing page is requested, as on Bien'ici: ~31
 * listings per request instead of one.
 *
 * WHAT IS LEFT OUT, ON PURPOSE.
 *  - Records whose `recordLink` is not on this site. About a third of a
 *    commune's index are Propriétés Le Figaro listings (`isPlf`), plus the
 *    odd new-build programme on explorimmoneuf.com. Those belong to their own
 *    portal; filing them here would count one advert as two portals'. They are
 *    counted and logged, not dropped silently.
 *  - The `carouselData` strip: promoted listings shown beside the results.
 *  - Rentals. The search asks for sales; a record that says otherwise is not
 *    trusted to be one.
 */

const HOST = "https://immobilier.lefigaro.fr";

type Commune = {
  /** Their URL token: words joined by `+`, then the postcode. */
  token: string;
  /** What their records print as `location.city`, without " (83)". */
  cities: string[];
};

/**
 * INSEE → their commune token. Port Grimaud and the Marines de Cogolin are
 * districts and come back under Grimaud and Cogolin; the client's labels are
 * applied later, centrally (communes.ts).
 *
 * Every token checked against their own answer on 2026-10-04 — page one of
 * each, the cities on it all the commune asked for. Stated totals that day:
 * Sainte-Maxime 669, Cavalaire 519, Les Issambres 330, Cogolin 308, Grimaud
 * 268, Saint-Tropez 238, La Croix-Valmer 178, Plan-de-la-Tour 133, La
 * Garde-Freinet 132, Ramatuelle 97, Gassin 87, La Môle 14 — about a third of
 * each being Propriétés Le Figaro records, which are left to that source.
 */
const COMMUNES: Record<string, Commune> = {
  "83119": { token: "saint+tropez+83990", cities: ["saint tropez"] },
  "83101": { token: "ramatuelle+83350", cities: ["ramatuelle"] },
  "83065": { token: "gassin+83580", cities: ["gassin"] },
  "83068": { token: "grimaud+83310", cities: ["grimaud", "port grimaud"] },
  "83042": { token: "cogolin+83310", cities: ["cogolin"] },
  "83115": { token: "sainte+maxime+83120", cities: ["sainte maxime"] },
  "83048": { token: "la+croix+valmer+83420", cities: ["la croix valmer"] },
  "83036": { token: "cavalaire+sur+mer+83240", cities: ["cavalaire sur mer"] },
  "83079": { token: "la+mole+83310", cities: ["la mole"] },
  "83063": { token: "la+garde+freinet+83680", cities: ["la garde freinet"] },
  /** Without the article: "le+plan…" answers 410 (measured 2026-10-04). */
  "83094": { token: "plan+de+la+tour+83120", cities: ["plan de la tour", "le plan de la tour"] },
  /**
   * Les Issambres is a locality of Roquebrune-sur-Argens (83107). Asked for by
   * its own name so the inland commune does not come with it — the noise
   * Bien'ici's 83107 zone brings (435 listings, 2026-10-02).
   */
  "83107": { token: "les+issambres+83380", cities: ["les issambres", "roquebrune sur argens"] },
};

export function indexUrl(token: string, page: number): string {
  const base = `${HOST}/annonces/immobilier-vente-bien-${token}.html`;
  return page > 1 ? `${base}?page=${page}` : base;
}

export function listingUrl(id: string): string {
  return `${HOST}/annonces/annonce-${id}.html`;
}

/** "Saint-Tropez (83)" → "saint tropez". */
function cityKey(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/\s*\(\d{2,3}\)\s*$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-'’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Photo = { order?: number; url?: Record<string, string> };
type Classified = {
  id: string;
  recordLink?: string;
  transaction?: string;
  type?: string;
  price?: number | null;
  priceLabel?: string | null;
  priceDownPercentage?: number | null;
  area?: number | null;
  areaGround?: number | null;
  roomCount?: number[] | number | null;
  roomCountLabel?: string | null;
  bedRoomCount?: number | null;
  bathRoomCount?: number | null;
  description?: string | null;
  reference?: string | null;
  firstPublicationDate?: string | null;
  creationDate?: string | null;
  updatedAt?: string | null;
  origin?: string | null;
  originSite?: string | null;
  isPlf?: boolean;
  options?: string[] | null;
  dpe?: { energyCategory?: string; gesCategory?: string } | null;
  client?: {
    id?: number;
    brandName?: string | null;
    location?: { address?: string | null; city?: string | null; postalCode?: string | null } | null;
  } | null;
  images?: { photos?: Photo[] } | null;
  location?: {
    city?: string | null;
    postalCode?: string | null;
    district?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
  [k: string]: unknown;
};

/**
 * Promotion flags and per-request decoration. Left in, they would change the
 * stored document's hash night to night and make an untouched listing look
 * edited.
 */
const VOLATILE = ["isBoosted", "isPolePosition", "isHighlighted", "freshness", "publicTransport", "clientImage"] as const;

function stable(c: Classified): string {
  const copy: Record<string, unknown> = { ...c };
  for (const k of VOLATILE) delete copy[k];
  return JSON.stringify(copy);
}

const positive = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Their dates carry no zone ("2026-09-29T05:16:04") and are Paris time — the
 * same record's price history prints "+02:00" for the same instant. Read as
 * UTC they would be one or two hours late; the offset is taken for that date.
 */
function parisDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const asUtc = new Date(`${v}Z`);
  if (Number.isNaN(asUtc.getTime()) || asUtc.getUTCFullYear() < 1990) return null;
  const inParis = new Date(asUtc.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  const inUtc = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(asUtc.getTime() - (inParis.getTime() - inUtc.getTime()));
}

/** The largest rendition each photo offers, in their order. */
function photosOf(c: Classified): string[] {
  const order = ["extra-large", "large", "medium", "small"];
  const list = [...(c.images?.photos ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const urls = list
    .map((p) => {
      const sizes = p.url ?? {};
      const key = order.find((k) => typeof sizes[k] === "string") ?? Object.keys(sizes)[0];
      return key ? sizes[key] : null;
    })
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  return [...new Set(urls)];
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The listing-response node on an index page, or null when the page has none. */
export function readIndex(html: string): {
  classifieds: Classified[];
  total: number | null;
  totalPages: number | null;
} | null {
  const data = readNuxtData(html);
  if (!data) return null;
  const resp = findByKeys(data, ["classifieds", "pagination", "total"]) as {
    classifieds?: unknown;
    total?: unknown;
    pagination?: { totalPage?: unknown } | null;
  } | null;
  if (!resp || !Array.isArray(resp.classifieds)) return null;
  const classifieds = resp.classifieds.filter(
    (c): c is Classified => !!c && typeof c === "object" && typeof (c as Classified).id === "string",
  );
  return {
    classifieds,
    total: typeof resp.total === "number" ? resp.total : null,
    totalPages: typeof resp.pagination?.totalPage === "number" ? resp.pagination.totalPage : null,
  };
}

export const figaroImmobilierAdapter: PortalAdapter = {
  key: "figaro-immobilier",
  name: "Figaro Immobilier",
  hosts: ["immobilier.lefigaro.fr"],
  discoveryMode: "index",
  /** Ours, the same as Propriétés; no Crawl-delay in their robots.txt. */
  defaultCrawlDelayMs: 5_000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const communes = (ctx.config.communes as Record<string, Commune> | undefined) ?? COMMUNES;
    const maxPages = Number(ctx.config.maxPages ?? 40);

    for (const insee of ctx.communeInsee) {
      const commune = communes[insee];
      if (!commune) {
        ctx.incomplete(insee, "no Figaro Immobilier commune token configured");
        continue;
      }

      const seen = new Set<string>();
      let total: number | null = null;
      let totalPages: number | null = null;
      let elsewhere = 0;
      let foreign = 0;
      let cutShort: string | null = null;

      for (let page = 1; page <= maxPages; page++) {
        if (totalPages !== null && page > totalPages) break;

        let html: string;
        try {
          html = await ctx.fetch(indexUrl(commune.token, page));
        } catch (err) {
          cutShort = `index page ${page} failed: ${(err as Error).message}`;
          break;
        }
        const index = readIndex(html);
        if (!index) {
          cutShort = `index page ${page} carried no listing data`;
          break;
        }
        total ??= index.total;
        totalPages ??= index.totalPages;

        /**
         * A token they do not know must not pass for a commune. Propriétés,
         * the sibling site, answers an unknown `ville` with 200 and the whole
         * department; if this one ever does, page one is full of other towns.
         * Checked on page one, on the listings themselves.
         */
        if (page === 1 && index.classifieds.length > 0) {
          const ours = index.classifieds.filter((c) => commune.cities.includes(cityKey(c.location?.city)));
          if (ours.length * 2 < index.classifieds.length) {
            const named = [...new Set(index.classifieds.map((c) => c.location?.city ?? "?"))].slice(0, 4).join(", ");
            cutShort = `"${commune.token}" answered with listings from ${named} — not this commune; token needs checking`;
            break;
          }
        }

        const fresh = index.classifieds.filter((c) => !seen.has(c.id));
        if (fresh.length === 0) break;

        for (const c of fresh) {
          seen.add(c.id);
          if (!c.recordLink?.startsWith(HOST)) {
            elsewhere += 1;
            continue;
          }
          if (c.transaction && c.transaction !== "vente") continue;
          if (!commune.cities.includes(cityKey(c.location?.city))) {
            foreign += 1;
            continue;
          }
          yield {
            externalId: c.id,
            url: listingUrl(c.id),
            communeHint: insee,
            sourceUpdatedAt: parisDate(c.updatedAt),
            document: stable(c),
          };
        }
      }

      if (elsewhere > 0) {
        console.log(`[figaro-immobilier] ${insee}: ${elsewhere} listings belong to another site (Propriétés Le Figaro, new-build) — left to it`);
      }
      if (foreign > 0) {
        console.warn(`[figaro-immobilier] ${insee}: ${foreign} records from other communes dropped`);
      }
      if (cutShort) {
        ctx.incomplete(insee, cutShort);
      } else if (total !== null && seen.size < total) {
        ctx.incomplete(insee, `read ${seen.size} of the ${total} they state (page cap ${maxPages})`);
      }
    }
  },

  parse(doc: string, url: string): ParseResult {
    let c: Classified;
    try {
      c = JSON.parse(doc) as Classified;
    } catch {
      return { status: "failed", error: "document is not a Figaro Immobilier record" };
    }
    if (!c?.id || !/^\d+$/.test(c.id)) return { status: "failed", error: "record has no id" };
    if (c.transaction && c.transaction !== "vente") {
      return { status: "failed", error: `not for sale (${c.transaction})` };
    }

    const listing = emptyListing(c.id, url || listingUrl(c.id));

    const type = typeof c.type === "string" && c.type.trim() ? c.type.trim() : null;
    listing.propertyType = type ? capitalise(type) : null;
    const isPlot = /terrain/i.test(type ?? "");
    listing.areaM2 = isPlot ? null : positive(c.area);
    listing.landM2 = positive(c.areaGround) ?? (isPlot ? positive(c.area) : null);
    const rooms = Array.isArray(c.roomCount) ? c.roomCount.find((n) => positive(n)) : c.roomCount;
    listing.rooms = positive(rooms);
    listing.bedrooms = positive(c.bedRoomCount);
    listing.bathrooms = positive(c.bathRoomCount);

    /**
     * Their records carry no title; the page builds one from these same
     * fields ("Vente appartement 4 pièces 80 m² à Saint-Tropez"). Built the
     * same way here rather than left blank, from nothing but what they state.
     */
    const city = c.location?.city?.replace(/\s*\(\d{2,3}\)\s*$/, "") ?? null;
    listing.title =
      [
        listing.propertyType,
        c.roomCountLabel && listing.rooms ? c.roomCountLabel : null,
        listing.areaM2 ? `${listing.areaM2} m²` : null,
        city ? `à ${city}` : null,
      ]
        .filter(Boolean)
        .join(" ") || null;
    listing.description = c.description
      ? cheerio.load(`<div>${c.description.replace(/<br\s*\/?>/gi, "\n")}</div>`)("div").text().trim() || null
      : null;

    /** Euros by construction: a French-only site with no currency picker. */
    listing.priceEur = positive(c.price);
    const onRequest = listing.priceEur === null && /NC|demande|consulter/i.test(c.priceLabel ?? "");

    listing.communeRaw = c.location?.district ? `${city} - ${c.location.district}` : city;
    listing.postalCode = c.location?.postalCode ?? null;
    /**
     * Coordinates only where they are a point. Some records carry two-decimal
     * values — the commune's centre, the same thing Propriétés does — and a
     * centre stored as a position would put every such house on one spot.
     */
    const precise = (v: unknown) => typeof v === "number" && /\.\d{4,}/.test(String(v));
    if (precise(c.location?.latitude) && precise(c.location?.longitude)) {
      listing.lat = c.location!.latitude!;
      listing.lon = c.location!.longitude!;
    }

    listing.agencyName = c.client?.brandName?.trim() || null;
    listing.agencyAddress = c.client?.location?.address?.trim() || null;
    listing.agencyPostalCode = c.client?.location?.postalCode?.trim() || null;
    listing.agencyCity = c.client?.location?.city?.trim() || null;
    listing.agencyRef = c.reference?.trim() || null;

    listing.imageUrls = photosOf(c);
    listing.imageUrl = listing.imageUrls[0] ?? null;

    listing.publishedAt = parisDate(c.firstPublicationDate ?? c.creationDate);
    listing.sourceUpdatedAt = parisDate(c.updatedAt);

    listing.raw = {
      source: "figaro-immobilier",
      priceOnRequest: onRequest,
      origin: c.origin ?? null, // "professionnel" / "particulier"
      originSite: c.originSite ?? null,
      options: c.options ?? [],
      priceDownPercentage: c.priceDownPercentage ?? null,
      dpe: c.dpe?.energyCategory || null,
      ges: c.dpe?.gesCategory || null,
      clientId: c.client?.id ?? null,
    };

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null && !(isPlot && listing.landM2 !== null)) missing.push("areaM2");
    if (!listing.agencyName) missing.push("agencyName");
    return missing.length === 0 ? { status: "ok", listing } : { status: "partial", listing, missing };
  },
};
