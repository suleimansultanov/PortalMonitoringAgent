import * as cheerio from "cheerio";
import { z } from "zod";
import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
} from "../types";

/**
 * Stream.Estate (api-v2.stream.estate) — an aggregator's API, not a portal.
 * Written 2026-10-06 on the V2 private beta.
 *
 * WHY. It is the only route this project has to the portals that refuse an
 * identified collector — Leboncoin, SeLoger's group, Idealista — and it
 * carries smaller ones we never wrote adapters for (Belles Demeures,
 * Lux-Residence, PAP, agency sites). Terms: showing the data to end users and
 * analysing it are allowed; reselling it, bulk republication and building a
 * competing data product are not.
 *
 * BILLING, in writing from Thomas at Stream.Estate (2026-10-05). On the paid
 * V1 API every result returned is one item, the same property returned again
 * is another, every webhook delivery is one, and count-only requests are
 * free. The V2 beta bills nothing while it lasts; `GET /account/api-usage`
 * shows our consumption and the written limit is 500 requests a minute.
 * A full pass of the gulf is ~60 requests. NOTE for when the beta ends:
 * their `updatedAt` moves on every re-crawl (5 543 of 5 821 "changed" in one
 * day, measured 2026-10-06), so "fetch only what changed since yesterday"
 * saves nothing; the economical route on a paid plan is their events
 * (NEW_MATCH, PRICE_CHANGE, EXPIRED), which fire only on real changes.
 *
 * WHAT IS TAKEN — two decisions made with the operator on 2026-10-06:
 *  1. Only properties that bring something we do not already collect: at
 *     least one listing from a portal outside `ownSources`. A property seen
 *     only on Vizzit or Bien'ici is already ours, directly, and taking it
 *     again would count one advert as two portals.
 *  2. Nothing from `heldBack` sources (Leboncoin, SeLoger) and nothing whose
 *     source is not named — 43% of listings in Saint-Tropez arrive with no
 *     source and no URL, and SeLoger and Figaro are absent from their source
 *     list. Whether those may be shown to a client is with Stream.Estate.
 *     They are not stored; when the answer is yes, empty `heldBack` and
 *     set `takeUnnamed` in the source's config and the next pass takes them.
 *
 * SHAPE. One record per property with the listings that carry it — their
 * deduplication, done before ours. Each record becomes one listing here,
 * keyed by their property id, linked to the newest listing on a portal we do
 * not collect ourselves. Our own resolver merges it with the same house from
 * Vizzit or Bien'ici through the agency reference, which their publishers
 * carry.
 *
 * Les Issambres is a locality of Roquebrune-sur-Argens (83107): their 83107 is
 * the whole commune, so only records that name Les Issambres are kept there.
 */

const API = "https://api-v2.stream.estate";

/** Portals we collect ourselves, as Stream.Estate names them. */
const OWN_SOURCES = ["vizzit", "bienici", "luxuryestate", "green-acres", "greenacres", "etreproprio", "superimmo"];
/** Named portals whose listings wait for the licence question. */
const HELD_BACK = ["leboncoin", "seloger"];

// ── Their JSON:API answer, checked at the boundary ───────────────────────────
const Ref = z.object({ id: z.string(), type: z.string() });
const Resource = z
  .object({
    id: z.string(),
    type: z.string(),
    attributes: z.record(z.unknown()).optional().default({}),
    relationships: z
      .record(z.object({ data: z.union([Ref, z.array(Ref), z.null()]).optional() }).passthrough())
      .optional()
      .default({}),
  })
  .passthrough();
const Page = z
  .object({
    data: z.array(Resource),
    included: z.array(Resource).optional().default([]),
    meta: z
      .object({
        totalItems: z.number().optional(),
        hasNextPage: z.boolean().optional(),
        cursor: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
type ResourceT = z.infer<typeof Resource>;

/** The document stored per property: everything parse needs, nothing that changes on its own. */
export type StreamRecord = {
  id: string;
  property: Record<string, unknown>;
  listings: { source: string; url: string; publishedAt: string | null; expiredAt: string | null }[];
  publishers: { agencyName: string | null; publisherType: string | null; reference: string | null; mandate: string | null }[];
  heldBack: Record<string, number>;
};

export function searchBody(insee: string, size: number, cursor: string | null): string {
  return JSON.stringify({
    criteria: {
      property: { transaction: { type: "SELL" }, locations: { countryCode: "FR", in: { uniqueCodes: [insee] } } },
    },
    paginationType: "CURSOR",
    size,
    ...(cursor ? { cursor } : {}),
  });
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function refs(r: ResourceT, rel: string): { id: string; type: string }[] {
  const d = r.relationships?.[rel]?.data;
  return d ? (Array.isArray(d) ? d : [d]) : [];
}

/**
 * One property and what links to it, folded into a record. Their property
 * `updatedAt` and `changes`, and each listing's `lastSeenAt`/`updatedAt`, move
 * on every re-crawl; they are left out so the stored document only changes
 * when the property does.
 */
export function toRecord(
  p: ResourceT,
  byKey: Map<string, ResourceT>,
  opts: { heldBack: string[]; takeUnnamed: boolean },
): StreamRecord {
  const listings: StreamRecord["listings"] = [];
  const heldBack: Record<string, number> = {};
  for (const ref of refs(p, "listings")) {
    const l = byKey.get(`${ref.type}:${ref.id}`);
    if (!l) continue;
    const source = refs(l, "source")
      .map((s) => str(byKey.get(`${s.type}:${s.id}`)?.attributes?.slug))
      .find(Boolean);
    const url = str(l.attributes?.url);
    const expiredAt = str(l.attributes?.expiredAt);
    if (expiredAt) continue; // a listing taken down is not a place the property is shown
    if (!source || !url) {
      if (!opts.takeUnnamed || !url) {
        heldBack.unnamed = (heldBack.unnamed ?? 0) + 1;
        continue;
      }
    }
    const slug = source ?? "unnamed";
    if (opts.heldBack.includes(slug)) {
      heldBack[slug] = (heldBack[slug] ?? 0) + 1;
      continue;
    }
    listings.push({ source: slug, url: url!, publishedAt: str(l.attributes?.publishedAt), expiredAt });
  }

  const publishers: StreamRecord["publishers"] = [];
  for (const ref of refs(p, "propertyPublishers")) {
    const pp = byKey.get(`${ref.type}:${ref.id}`);
    if (!pp) continue;
    const pub = refs(pp, "publisher").map((x) => byKey.get(`${x.type}:${x.id}`)).find(Boolean);
    publishers.push({
      agencyName: str(pub?.attributes?.agencyName),
      publisherType: str(pub?.attributes?.publisherType),
      reference: str(pp.attributes?.reference),
      mandate: str(pp.attributes?.mandate),
    });
  }

  const { updatedAt: _u, changes: _c, ...property } = p.attributes ?? {};
  return { id: p.id, property, listings, publishers, heldBack };
}

const PROPERTY_TYPES: Record<string, string> = {
  HOUSE: "Maison",
  FLAT: "Appartement",
  LAND: "Terrain",
  PARKING: "Parking",
  SHOP: "Commerce",
  COMMERCIAL_PREMISES: "Local",
  OFFICE: "Bureau",
  BUILDING: "Immeuble",
  CASTLE: "Château",
  LOFT: "Loft",
};

/**
 * Words their publishers carry where a name should be — "Transaction" on an
 * Idealista record, 2026-10-06. Stored, one becomes an agency every nameless
 * listing then merges into: Green-Acres' "-" over again.
 */
const NOT_A_NAME = /^(transaction|transactions|agence|agency|vente|ventes|particulier|professionnel|immobilier|real estate|-+)$/i;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The listing to link to: the newest on a portal we do not collect, else the newest at all. */
function primary(rec: StreamRecord, own: string[]) {
  const byDate = [...rec.listings].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return byDate.find((l) => !own.includes(l.source)) ?? byDate[0] ?? null;
}

export const streamEstateAdapter: PortalAdapter = {
  key: "stream-estate",
  name: "Stream.Estate",
  hosts: ["api-v2.stream.estate"],
  discoveryMode: "index",
  /** Ours, far under their 500 a minute: a full pass is ~60 requests. */
  defaultCrawlDelayMs: 1_500,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const keyEnv = (ctx.config.apiKeyEnv as string) ?? "STREAM_ESTATE_V2_API_KEY";
    const key = process.env[keyEnv]?.trim();
    // Without a key every request would be refused; say so once, loudly, rather than twelve times.
    if (!key) throw new Error(`${keyEnv} is not set — add it to .env.local and to the repository's secrets`);
    const own = (ctx.config.ownSources as string[] | undefined) ?? OWN_SOURCES;
    const heldBack = (ctx.config.heldBack as string[] | undefined) ?? HELD_BACK;
    const takeUnnamed = ctx.config.takeUnnamed === true;
    const size = Math.min(100, Number(ctx.config.pageSize ?? 100));
    const maxPages = Number(ctx.config.maxPages ?? 40);
    const localities = (ctx.config.localities as Record<string, string[]> | undefined) ?? { "83107": ["issambres"] };

    for (const insee of ctx.communeInsee) {
      let cursor: string | null = null;
      let total: number | null = null;
      let seen = 0;
      let kept = 0;
      const dropped = { ours: 0, heldBack: 0, elsewhere: 0, wrongCommune: 0 };
      let cutShort: string | null = null;

      for (let page = 1; page <= maxPages; page++) {
        let body: string;
        try {
          body = await ctx.fetch(`${API}/properties`, {
            method: "POST",
            body: searchBody(insee, size, cursor),
            headers: { "x-api-key": key },
            json: true,
          });
        } catch (err) {
          cutShort = `page ${page} failed: ${(err as Error).message}`;
          break;
        }
        let parsed: z.infer<typeof Page>;
        try {
          parsed = Page.parse(JSON.parse(body));
        } catch (err) {
          cutShort = `page ${page} was not the answer expected (${(err as Error).message.slice(0, 120)})`;
          break;
        }
        total ??= parsed.meta?.totalItems ?? null;
        const byKey = new Map(parsed.included.map((r) => [`${r.type}:${r.id}`, r]));

        for (const p of parsed.data) {
          seen += 1;
          const attrs = p.attributes ?? {};
          const city = obj(obj(attrs.location).city);
          if (str(city.uniqueCode) && city.uniqueCode !== insee) {
            dropped.wrongCommune += 1;
            continue;
          }
          if (attrs.expired === true || obj(attrs.transaction).type !== "SELL") continue;
          const must = localities[insee];
          if (must) {
            const body_ = obj(attrs.body);
            const hay = plain(`${str(body_.title) ?? ""} ${str(body_.description) ?? ""} ${JSON.stringify(attrs.location ?? {})}`);
            if (!must.some((m) => hay.includes(plain(m)))) {
              dropped.elsewhere += 1;
              continue;
            }
          }
          const rec = toRecord(p, byKey, { heldBack, takeUnnamed });
          if (rec.listings.length === 0) {
            dropped.heldBack += 1;
            continue;
          }
          if (rec.listings.every((l) => own.includes(l.source))) {
            dropped.ours += 1;
            continue;
          }
          kept += 1;
          yield {
            externalId: rec.id,
            url: primary(rec, own)!.url,
            communeHint: insee,
            document: JSON.stringify(rec),
          };
        }

        if (!parsed.meta?.hasNextPage) break;
        cursor = parsed.meta?.cursor ?? null;
        if (!cursor) {
          cutShort = `page ${page} said there is more but gave no cursor`;
          break;
        }
        if (page === maxPages) cutShort = `hit the ${maxPages}-page ceiling with ${total ?? "?"} stated`;
      }

      console.log(
        `[stream-estate] ${insee}: ${kept} taken of ${seen} read (${total ?? "?"} stated) — ` +
          `already ours ${dropped.ours}, held back ${dropped.heldBack}, ` +
          `outside the locality ${dropped.elsewhere}, other commune ${dropped.wrongCommune}`,
      );
      if (cutShort) ctx.incomplete(insee, cutShort);
      else if (total !== null && seen < total) ctx.incomplete(insee, `read ${seen} of the ${total} they state`);
    }
  },

  parse(doc: string, url: string): ParseResult {
    let rec: StreamRecord;
    try {
      rec = JSON.parse(doc) as StreamRecord;
    } catch {
      return { status: "failed", error: "document is not a Stream.Estate record" };
    }
    if (!rec?.id || !rec.property) return { status: "failed", error: "record has no id" };
    const p = rec.property;
    if (obj(p.transaction).type !== "SELL") return { status: "failed", error: "not for sale" };

    const lead = primary(rec, OWN_SOURCES);
    const listing = emptyListing(rec.id, url || lead?.url || `${API}/properties/${rec.id}`);

    const body = obj(p.body);
    listing.title = str(body.title);
    const description = str(body.description);
    listing.description = description ? cheerio.load(`<div>${description.replace(/<br\s*\/?>/gi, "\n")}</div>`)("div").text().trim() || null : null;

    const type = str(p.propertyType);
    listing.propertyType = type ? (PROPERTY_TYPES[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ")) : null;
    const isPlot = type === "LAND";

    const pricing = obj(p.pricing);
    listing.priceEur = str(pricing.currency) === "EUR" ? num(pricing.displayed) : null;

    const area = obj(p.area);
    const sqm = str(area.unit) === "SQM" || area.unit === undefined;
    const floor = sqm ? (num(obj(area.indoor).living) ?? num(area.displayed)) : null;
    const land = sqm ? num(obj(area.land).value) : null;
    listing.areaM2 = isPlot ? null : floor;
    listing.landM2 = land ?? (isPlot ? floor : null);

    const unit = obj(p.unit);
    listing.rooms = num(unit.rooms);
    listing.bedrooms = num(unit.bedrooms);
    listing.bathrooms = num(unit.bathrooms);

    const location = obj(p.location);
    const city = obj(location.city);
    listing.communeRaw = str(city.name);
    const postal = Array.isArray(city.postalCodes) ? city.postalCodes.filter((x) => typeof x === "string") : [];
    listing.postalCode = postal.length === 1 ? (postal[0] as string) : null;
    /** Only a point they call precise; CITY and NEIGHBORHOOD are centres. */
    if (location.accuracy === "PRECISE") {
      const c = obj(location.geometry).coordinates;
      if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
        listing.lon = c[0];
        listing.lat = c[1];
      }
    }

    /**
     * The agency. Their publishers for one property are often the same
     * network spelled per advisor ("SAFTI", "SAFTI PEREIRA … conseiller
     * indépendant") with one mandate reference between them — which is the
     * key our deduplication trusts, so the reference most of them agree on is
     * taken, and the shortest agency name that carries it.
     */
    const agencies = rec.publishers.filter(
      (x) => x.publisherType === "REAL_ESTATE_AGENCY" && x.agencyName && !NOT_A_NAME.test(x.agencyName.trim()),
    );
    const refCounts = new Map<string, number>();
    for (const x of rec.publishers) if (x.reference) refCounts.set(x.reference, (refCounts.get(x.reference) ?? 0) + 1);
    const reference = [...refCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const named = agencies.filter((x) => !reference || x.reference === reference).sort((a, b) => a.agencyName!.length - b.agencyName!.length);
    listing.agencyName = named[0]?.agencyName?.replace(/\s+/g, " ").trim() ?? null;
    listing.agencyRef = reference;

    const pictures = Array.isArray(p.pictures) ? p.pictures : [];
    listing.imageUrls = [
      ...new Set(pictures.map((x) => str(obj(x).url)).filter((u): u is string => !!u && /^https:\/\//.test(u))),
    ];
    listing.imageUrl = listing.imageUrls[0] ?? null;

    const dates = rec.listings.map((l) => l.publishedAt).filter((d): d is string => !!d).sort();
    const published = dates[0] ?? str(p.createdAt);
    listing.publishedAt = published ? new Date(published) : null;
    // `updatedAt` is not taken: theirs moves on every re-crawl, not on change.

    listing.raw = {
      source: "stream-estate",
      sources: [...new Set(rec.listings.map((l) => l.source))],
      listings: rec.listings.map((l) => ({ source: l.source, url: l.url, publishedAt: l.publishedAt })),
      heldBack: rec.heldBack,
      mandate: rec.publishers.find((x) => x.reference === reference)?.mandate ?? null,
      saleType: str(obj(p.transaction).saleType),
      constructionStatus: str(p.constructionStatus),
      locationAccuracy: str(location.accuracy),
    };

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null && !(isPlot && listing.landM2 !== null)) missing.push("areaM2");
    if (!listing.agencyName) missing.push("agencyName");
    return missing.length === 0 ? { status: "ok", listing } : { status: "partial", listing, missing };
  },
};
