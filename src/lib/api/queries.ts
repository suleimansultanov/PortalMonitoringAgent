import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  buyerMatches,
  buyers,
  portalAgencies,
  portalListingEvents,
  portalListings,
  portalSources,
  properties,
} from "@/lib/db/schema";
import { GULF_OF_SAINT_TROPEZ } from "@/lib/portals/communes";
import { hasFeature } from "@/lib/matching/buyers";

/**
 * Every read the product screens make, in one place.
 *
 * Kept out of the route handlers and out of the components so that the shape of
 * a screen and the shape of a query can change independently, and so there is
 * one place to look when a number on a page is wrong.
 *
 * A NOTE ON TEST DATA
 *
 * `includeTestData` is a parameter on every buyer-facing query, and it defaults
 * to false. The invented buyers seeded for development must not silently pad a
 * count an agent might act on. Where they are shown, the row carries
 * `isTestData` so the screen can label it — the flag travels with the data
 * rather than being remembered by whoever renders it.
 */

export const COMMUNE_LABELS: Record<string, string> = (() => {
  const out: Record<string, string> = {};

  // Communes proper win the name.
  for (const c of GULF_OF_SAINT_TROPEZ) {
    if (!c.localityOf) out[c.insee] = c.label;
  }

  /**
   * Then the codes that exist ONLY as a locality.
   *
   * 83107 is the case that exposed this: the client watches "Les Issambres",
   * which is a locality of Roquebrune-sur-Argens and has no commune entry of
   * its own. Filtering localities out left the code unlabelled, and 215
   * properties appeared on the dashboard under the heading "83107" — which
   * reads as a bug in front of a client, and worse, as a place they do not
   * recognise as theirs.
   *
   * Both names are shown because both are true and each answers a different
   * question: the bucket really is the whole commune, and the client really is
   * watching the locality.
   */
  for (const c of GULF_OF_SAINT_TROPEZ) {
    if (c.localityOf && !out[c.insee]) out[c.insee] = `${c.localityOf} (${c.label})`;
  }

  return out;
})();

export type ListingRow = {
  id: string;
  title: string | null;
  /** What the card shows — see `displayTitle`. */
  headline: string;
  imageUrl: string | null;
  /** The full gallery, portal order. Hotlinked, never copied. */
  imageUrls: string[];
  /** Feature words found in the listing text, for the tags on a card. */
  features: string[];
  priceEur: number | null;
  areaM2: number | null;
  landM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  propertyType: string | null;
  communeInsee: string | null;
  communeLabel: string | null;
  agencyName: string | null;
  agencyRef: string | null;
  /** How many portals carry this same property — the dedup badge. */
  sourceCount: number;
  status: string;
  firstListedAt: Date | null;
  lastSeenAt: Date | null;
  /** Days between first sighting and now, or delisting. Ours, not the portal's. */
  daysOnMarket: number | null;
  portals: { source: string; url: string }[];
};

export type ListingFilters = {
  communeInsee?: string[];
  source?: string;
  /** Free text over title, description, agency name and mandate reference. */
  q?: string;
  /** Only properties first seen in the last N days. */
  newWithinDays?: number;
  minPriceEur?: number;
  maxPriceEur?: number;
  limit?: number;
  offset?: number;
};

/**
 * Properties, with the portals carrying each one.
 *
 * The unit is the deduplicated PROPERTY, not the listing. A villa on four
 * portals is one row with a "×4" badge — showing it four times is the single
 * fastest way to make the whole product look broken to someone who knows the
 * market.
 */
export async function listProperties(f: ListingFilters = {}): Promise<{
  rows: ListingRow[];
  /** Properties matching the filter, across every page. */
  total: number;
  /** Portal entries those properties were folded from, across every page. */
  totalListings: number;
}> {
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;

  const conditions = [eq(properties.status, "active")];
  if (f.communeInsee?.length) {
    conditions.push(inArray(properties.communeInsee, f.communeInsee));
  }
  if (f.newWithinDays !== undefined) {
    conditions.push(
      gte(properties.firstListedAt, sql`now() - ${`${f.newWithinDays} days`}::interval`),
    );
  }
  if (f.minPriceEur !== undefined) conditions.push(gte(properties.priceEur, f.minPriceEur));
  if (f.maxPriceEur !== undefined) {
    conditions.push(sql`${properties.priceEur} <= ${f.maxPriceEur}`);
  }
  if (f.source) {
    conditions.push(
      sql`exists (
        select 1 from ${portalListings} pl
        join ${portalSources} ps on ps.id = pl.source_id
        where pl.property_id = ${properties.id} and ps.key = ${f.source}
      )`,
    );
  }

  /**
   * Free text.
   *
   * ILIKE rather than full-text search, on purpose. Postgres FTS needs a
   * language configuration, and the corpus is French prose while the agents
   * typing into the box are English-speaking — `to_tsquery('english', …)` would
   * stem "villas" to "villa" and then fail to match "villa" in a French
   * document that was never indexed with the right dictionary. A substring
   * match has no such opinions, and at a few thousand rows it is instant.
   *
   * The mandate reference is included because it is the one string an agent
   * already knows by heart when they are chasing a specific property.
   */
  if (f.q?.trim()) {
    // % and _ are wildcards; someone searching for "120 m2" should not have
    // their underscore silently mean "any character".
    const pattern = `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(sql`(
      ${properties.title} ilike ${pattern}
      or ${properties.description} ilike ${pattern}
      or ${properties.agencyRef} ilike ${pattern}
      or exists (
        select 1 from ${portalAgencies} a
        where a.id = ${properties.agencyId} and a.name ilike ${pattern}
      )
    )`);
  }

  const where = and(...conditions);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(properties)
    .where(where);

  /**
   * How many portal entries the matching properties were folded from.
   *
   * Counted across the whole result, not the page. The screen used to sum the
   * portals of the rows it had loaded and print that beside the global property
   * total — "2392 unique properties, deduplicated from 176 portal entries",
   * which is two different populations in one sentence and reads as a
   * deduplication rate of 93%.
   */
  const matching = db.select({ id: properties.id }).from(properties).where(where);
  const [{ listings }] = await db
    .select({ listings: sql<number>`count(*)::int` })
    .from(portalListings)
    .where(
      and(eq(portalListings.status, "active"), inArray(portalListings.propertyId, matching)),
    );

  const rows = await db
    .select({
      id: properties.id,
      title: properties.title,
      description: properties.description,
      imageUrl: properties.imageUrl,
      imageUrls: properties.imageUrls,
      priceEur: properties.priceEur,
      areaM2: properties.areaM2,
      landM2: properties.landM2,
      rooms: properties.rooms,
      bedrooms: properties.bedrooms,
      propertyType: properties.propertyType,
      communeInsee: properties.communeInsee,
      agencyName: portalAgencies.name,
      agencyRef: properties.agencyRef,
      sourceCount: properties.sourceCount,
      status: properties.status,
      firstListedAt: properties.firstListedAt,
      lastSeenAt: properties.lastSeenAt,
      delistedAt: properties.delistedAt,
    })
    .from(properties)
    .leftJoin(portalAgencies, eq(portalAgencies.id, properties.agencyId))
    .where(where)
    .orderBy(desc(properties.firstListedAt))
    .limit(limit)
    .offset(offset);

  const ids = rows.map((r) => r.id);
  const portals = ids.length > 0 ? await portalsFor(ids) : new Map<string, ListingRow["portals"]>();

  return {
    total: Number(count),
    totalListings: Number(listings),
    rows: rows.map((r) => ({
      ...r,
      // numeric arrives as a string; Number(null) is 0, which would turn "we do
      // not know the area" into "zero square metres" on the screen.
      areaM2: r.areaM2 === null ? null : Number(r.areaM2),
      landM2: r.landM2 === null ? null : Number(r.landM2),
      communeLabel: r.communeInsee ? (COMMUNE_LABELS[r.communeInsee] ?? r.communeInsee) : null,
      headline: displayTitle({
        title: r.title,
        propertyType: r.propertyType,
        areaM2: r.areaM2 === null ? null : Number(r.areaM2),
        communeInsee: r.communeInsee,
      }),
      features: featuresOf(`${r.title ?? ""} ${r.description ?? ""}`),
      daysOnMarket: daysBetween(r.firstListedAt, r.delistedAt ?? new Date()),
      portals: portals.get(r.id) ?? [],
    })),
  };
}

async function portalsFor(propertyIds: string[]): Promise<Map<string, ListingRow["portals"]>> {
  const rows = await db
    .select({
      propertyId: portalListings.propertyId,
      source: portalSources.key,
      url: portalListings.url,
    })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(
      and(
        inArray(portalListings.propertyId, propertyIds),
        eq(portalListings.status, "active"),
      ),
    );

  const out = new Map<string, ListingRow["portals"]>();
  for (const r of rows) {
    if (!r.propertyId) continue;
    const list = out.get(r.propertyId) ?? [];
    list.push({ source: r.source, url: r.url });
    out.set(r.propertyId, list);
  }
  return out;
}

/**
 * What to put on a card.
 *
 * Portals differ wildly here. Green-Acres agencies write real headlines —
 * "Maison d'Exception à Ramatuelle avec Piscine". Superimmo generates them
 * mechanically from the fields: "Vente maison 4 000 000 € 270 m² 8 pièces 8 p
 * 5 chambres 5 ch Ramatuelle (83350)". Shown as-is, the second kind is a wall
 * of digits that repeats every number already in its own row.
 *
 * So: keep a human-written title, and compose one when the portal's is just its
 * own data read aloud. The test for that is crude but effective — a title that
 * is mostly numbers and units was not written by a person.
 */
function displayTitle(r: {
  title: string | null;
  propertyType: string | null;
  areaM2: number | null;
  communeInsee: string | null;
}): string {
  const commune = r.communeInsee ? (COMMUNE_LABELS[r.communeInsee] ?? r.communeInsee) : null;
  const title = r.title?.trim() ?? "";

  const machine =
    title.length === 0 ||
    /^(vente|location|achat)\s/i.test(title) ||
    // More than a third digits, or three or more "N unit" runs.
    (title.replace(/[^\d]/g, "").length / Math.max(title.length, 1) > 0.3 &&
      (title.match(/\d+\s*(m²|pièces?|ch(ambres?)?|p)\b/gi) ?? []).length >= 2);

  if (!machine) return title;

  const type = r.propertyType ?? "Property";
  const parts = [type];
  if (r.areaM2) parts.push(`${Math.round(r.areaM2)} m²`);
  return `${parts.join(" · ")}${commune ? ` — ${commune}` : ""}`;
}

/**
 * Feature tags, from the listing's own words.
 *
 * Crude substring matching, and honest about it: a description saying "no pool"
 * would register as a pool. That is tolerable on a card, where the tag is a
 * hint that sends someone to the listing, and NOT tolerable as a filter — which
 * is why these are display-only and the matcher scores features separately.
 */
const CARD_FEATURES = ["pool", "sea_view", "garden", "garage", "walking_distance_beach", "renovated"];

function featuresOf(text: string): string[] {
  return CARD_FEATURES.filter((f) => hasFeature(text, f)).slice(0, 3);
}

const FEATURE_LABELS: Record<string, string> = {
  pool: "Pool",
  sea_view: "Sea view",
  garden: "Garden",
  garage: "Garage",
  walking_distance_beach: "Walk to beach",
  renovated: "Renovated",
};

export function featureLabel(key: string): string {
  return FEATURE_LABELS[key] ?? key.replace(/_/g, " ");
}

/**
 * Days on market, ours rather than the portal's.
 *
 * Only Superimmo publishes a real publication date. For everything else this
 * counts from OUR first sighting, which understates age for anything that was
 * already listed when we started watching. The screens must say so — a number
 * labelled "days on market" that silently means "days since we noticed" is the
 * kind of thing an agent quotes to a client and then has to walk back.
 */
function daysBetween(from: Date | null, to: Date): number | null {
  if (!from) return null;
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

export type MatchRow = {
  id: string;
  score: number;
  status: string;
  reasons: { field: string; ok: boolean | null; detail: string; disqualifying?: boolean }[];
  buyer: { id: string; name: string; agent: string | null; isTestData: boolean };
  property: ListingRow;
};

/**
 * Matches, newest and highest-scoring first.
 *
 * Dismissed ones are excluded by default: an agent said no, and putting it back
 * in front of them teaches them the screen does not listen.
 */
export async function listMatches(
  opts: {
    includeTestData?: boolean;
    includeDismissed?: boolean;
    buyerId?: string;
    limit?: number;
  } = {},
): Promise<MatchRow[]> {
  const limit = Math.min(opts.limit ?? 100, 300);

  const conditions = [];
  if (!opts.includeTestData) conditions.push(eq(buyers.isTestData, false));
  if (!opts.includeDismissed) conditions.push(sql`${buyerMatches.status} <> 'dismissed'`);
  if (opts.buyerId) conditions.push(eq(buyerMatches.buyerId, opts.buyerId));

  const rows = await db
    .select({
      id: buyerMatches.id,
      score: buyerMatches.score,
      status: buyerMatches.status,
      reasons: buyerMatches.reasons,
      buyerId: buyers.id,
      buyerName: buyers.name,
      buyerAgent: buyers.agent,
      buyerIsTest: buyers.isTestData,
      propertyId: properties.id,
      title: properties.title,
      description: properties.description,
      imageUrl: properties.imageUrl,
      imageUrls: properties.imageUrls,
      priceEur: properties.priceEur,
      areaM2: properties.areaM2,
      landM2: properties.landM2,
      rooms: properties.rooms,
      bedrooms: properties.bedrooms,
      propertyType: properties.propertyType,
      communeInsee: properties.communeInsee,
      agencyName: portalAgencies.name,
      agencyRef: properties.agencyRef,
      sourceCount: properties.sourceCount,
      propertyStatus: properties.status,
      firstListedAt: properties.firstListedAt,
      lastSeenAt: properties.lastSeenAt,
      delistedAt: properties.delistedAt,
    })
    .from(buyerMatches)
    .innerJoin(buyers, eq(buyers.id, buyerMatches.buyerId))
    .innerJoin(properties, eq(properties.id, buyerMatches.propertyId))
    .leftJoin(portalAgencies, eq(portalAgencies.id, properties.agencyId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(buyerMatches.score), desc(buyerMatches.createdAt))
    .limit(limit);

  const portals = await portalsFor(rows.map((r) => r.propertyId));

  return rows.map((r) => ({
    id: r.id,
    score: r.score,
    status: r.status,
    reasons: (r.reasons ?? []) as MatchRow["reasons"],
    buyer: {
      id: r.buyerId,
      name: r.buyerName,
      agent: r.buyerAgent,
      isTestData: r.buyerIsTest,
    },
    property: {
      id: r.propertyId,
      title: r.title,
      imageUrl: r.imageUrl,
      imageUrls: r.imageUrls,
      headline: displayTitle({
        title: r.title,
        propertyType: r.propertyType,
        areaM2: r.areaM2 === null ? null : Number(r.areaM2),
        communeInsee: r.communeInsee,
      }),
      features: featuresOf(`${r.title ?? ""} ${r.description ?? ""}`),
      priceEur: r.priceEur,
      areaM2: r.areaM2 === null ? null : Number(r.areaM2),
      landM2: r.landM2 === null ? null : Number(r.landM2),
      rooms: r.rooms,
      bedrooms: r.bedrooms,
      propertyType: r.propertyType,
      communeInsee: r.communeInsee,
      communeLabel: r.communeInsee ? (COMMUNE_LABELS[r.communeInsee] ?? r.communeInsee) : null,
      agencyName: r.agencyName,
      agencyRef: r.agencyRef,
      sourceCount: r.sourceCount,
      status: r.propertyStatus,
      firstListedAt: r.firstListedAt,
      lastSeenAt: r.lastSeenAt,
      daysOnMarket: daysBetween(r.firstListedAt, r.delistedAt ?? new Date()),
      portals: portals.get(r.propertyId) ?? [],
    },
  }));
}

export type PropertyDetail = {
  property: ListingRow;
  description: string | null;
  /** One row per portal carrying it, with what THAT portal says. */
  listings: {
    id: string;
    source: string;
    sourceName: string;
    url: string;
    priceEur: number | null;
    areaM2: number | null;
    agencyRef: string | null;
    /** Only Superimmo publishes these. */
    publishedAt: Date | null;
    sourceUpdatedAt: Date | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
    status: string;
    parseStatus: string;
    /** 0–1, and the signals behind it — why we believe this is the same property. */
    matchConfidence: number | null;
    matchSignals: Record<string, unknown> | null;
    raw: Record<string, unknown> | null;
  }[];
  /** Append-only history. Every metric in the product derives from this. */
  events: {
    id: string;
    type: string;
    source: string;
    priceFrom: number | null;
    priceTo: number | null;
    payload: Record<string, unknown> | null;
    occurredAt: Date;
  }[];
  agency: {
    id: string;
    name: string;
    address: string | null;
    postalCode: string | null;
    city: string | null;
    phone: string | null;
    /** How much else this agency has on our watched communes. */
    activeCount: number;
  } | null;
};

/**
 * Everything we know about one property.
 *
 * The point of this screen is the things a portal cannot show you: what the
 * OTHER portals say about the same villa, and what has happened to it over
 * time. A portal shows a price; we can show that two portals disagree about it,
 * which is either a stale listing or an agency quietly testing a number.
 */
export async function propertyDetail(id: string): Promise<PropertyDetail | null> {
  const [row] = await db
    .select({
      id: properties.id,
      title: properties.title,
      description: properties.description,
      imageUrl: properties.imageUrl,
      imageUrls: properties.imageUrls,
      priceEur: properties.priceEur,
      areaM2: properties.areaM2,
      landM2: properties.landM2,
      rooms: properties.rooms,
      bedrooms: properties.bedrooms,
      propertyType: properties.propertyType,
      communeInsee: properties.communeInsee,
      agencyId: properties.agencyId,
      agencyName: portalAgencies.name,
      agencyAddress: portalAgencies.address,
      agencyPostalCode: portalAgencies.postalCode,
      agencyCity: portalAgencies.city,
      agencyPhone: portalAgencies.phone,
      agencyRef: properties.agencyRef,
      sourceCount: properties.sourceCount,
      status: properties.status,
      firstListedAt: properties.firstListedAt,
      lastSeenAt: properties.lastSeenAt,
      delistedAt: properties.delistedAt,
    })
    .from(properties)
    .leftJoin(portalAgencies, eq(portalAgencies.id, properties.agencyId))
    .where(eq(properties.id, id))
    .limit(1);

  if (!row) return null;

  const listingRows = await db
    .select({
      id: portalListings.id,
      source: portalSources.key,
      sourceName: portalSources.name,
      url: portalListings.url,
      priceEur: portalListings.priceEur,
      areaM2: portalListings.areaM2,
      agencyRef: portalListings.agencyRef,
      publishedAt: portalListings.publishedAt,
      sourceUpdatedAt: portalListings.sourceUpdatedAt,
      firstSeenAt: portalListings.firstSeenAt,
      lastSeenAt: portalListings.lastSeenAt,
      status: portalListings.status,
      parseStatus: portalListings.parseStatus,
      matchConfidence: portalListings.matchConfidence,
      matchSignals: portalListings.matchSignals,
      raw: portalListings.raw,
    })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(eq(portalListings.propertyId, id))
    .orderBy(portalSources.key);

  const eventRows = await db
    .select({
      id: portalListingEvents.id,
      type: portalListingEvents.type,
      source: portalSources.key,
      priceFrom: portalListingEvents.priceFrom,
      priceTo: portalListingEvents.priceTo,
      payload: portalListingEvents.payload,
      occurredAt: portalListingEvents.occurredAt,
    })
    .from(portalListingEvents)
    .innerJoin(portalSources, eq(portalSources.id, portalListingEvents.sourceId))
    .where(eq(portalListingEvents.propertyId, id))
    .orderBy(desc(portalListingEvents.occurredAt))
    .limit(100);

  let agencyActive = 0;
  if (row.agencyId) {
    const [c] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(properties)
      .where(and(eq(properties.agencyId, row.agencyId), eq(properties.status, "active")));
    agencyActive = Number(c?.n ?? 0);
  }

  const areaM2 = row.areaM2 === null ? null : Number(row.areaM2);
  const portalsList = listingRows
    .filter((l) => l.status === "active")
    .map((l) => ({ source: l.source, url: l.url }));

  return {
    property: {
      id: row.id,
      title: row.title,
      imageUrl: row.imageUrl,
      imageUrls: row.imageUrls,
      headline: displayTitle({
        title: row.title,
        propertyType: row.propertyType,
        areaM2,
        communeInsee: row.communeInsee,
      }),
      features: featuresOf(`${row.title ?? ""} ${row.description ?? ""}`),
      priceEur: row.priceEur,
      areaM2,
      landM2: row.landM2 === null ? null : Number(row.landM2),
      rooms: row.rooms,
      bedrooms: row.bedrooms,
      propertyType: row.propertyType,
      communeInsee: row.communeInsee,
      communeLabel: row.communeInsee ? (COMMUNE_LABELS[row.communeInsee] ?? row.communeInsee) : null,
      agencyName: row.agencyName,
      agencyRef: row.agencyRef,
      sourceCount: row.sourceCount,
      status: row.status,
      firstListedAt: row.firstListedAt,
      lastSeenAt: row.lastSeenAt,
      daysOnMarket: daysBetween(row.firstListedAt, row.delistedAt ?? new Date()),
      portals: portalsList,
    },
    description: row.description,
    listings: listingRows.map((l) => ({
      ...l,
      areaM2: l.areaM2 === null ? null : Number(l.areaM2),
      matchConfidence: l.matchConfidence === null ? null : Number(l.matchConfidence),
    })),
    events: eventRows,
    agency: row.agencyId
      ? {
          id: row.agencyId,
          name: row.agencyName ?? "Unknown",
          address: row.agencyAddress,
          postalCode: row.agencyPostalCode,
          city: row.agencyCity,
          phone: row.agencyPhone,
          activeCount: agencyActive,
        }
      : null,
  };
}

export type CommuneStat = {
  insee: string;
  label: string;
  active: number;
  medianPriceEur: number | null;
  medianPricePerM2: number | null;
  medianDaysOnMarket: number | null;
  priceCuts30d: number;
  newIn30d: number;
};

/**
 * Per-commune market summary.
 *
 * MEDIAN, not mean, everywhere. One 30M villa in Ramatuelle drags an average
 * far away from anything a buyer would recognise as the local price, and a
 * report whose numbers do not match what agents see on the ground is a report
 * they stop opening.
 */
export async function communeStats(): Promise<CommuneStat[]> {
  const rows = await db.execute<{
    commune_insee: string;
    active: number;
    median_price: string | null;
    median_ppm2: string | null;
    median_dom: string | null;
    price_cuts_30d: number;
    new_30d: number;
  }>(sql`
    select
      p.commune_insee,
      count(*) filter (where p.status = 'active')::int as active,
      percentile_cont(0.5) within group (order by p.price_eur)
        filter (where p.price_eur is not null) as median_price,
      percentile_cont(0.5) within group (
        order by p.price_eur / nullif(p.area_m2::numeric, 0)
      ) filter (where p.price_eur is not null and p.area_m2 is not null) as median_ppm2,
      percentile_cont(0.5) within group (
        order by extract(epoch from (coalesce(p.delisted_at, now()) - p.first_listed_at)) / 86400
      ) filter (where p.first_listed_at is not null) as median_dom,
      (
        select count(*)::int from ${portalListingEvents} e
        join ${portalListings} l on l.id = e.listing_id
        where l.property_id in (
          select id from ${properties} p2 where p2.commune_insee = p.commune_insee
        )
        and e.type = 'price_changed'
        and (e.payload->>'direction') = 'down'
        and e.occurred_at > now() - interval '30 days'
      ) as price_cuts_30d,
      count(*) filter (where p.first_listed_at > now() - interval '30 days')::int as new_30d
    from ${properties} p
    where p.commune_insee is not null
    group by p.commune_insee
    order by active desc
  `);

  return rows.rows.map((r) => ({
    insee: r.commune_insee,
    label: COMMUNE_LABELS[r.commune_insee] ?? r.commune_insee,
    active: Number(r.active),
    medianPriceEur: r.median_price === null ? null : Math.round(Number(r.median_price)),
    medianPricePerM2: r.median_ppm2 === null ? null : Math.round(Number(r.median_ppm2)),
    medianDaysOnMarket: r.median_dom === null ? null : Math.round(Number(r.median_dom)),
    priceCuts30d: Number(r.price_cuts_30d),
    newIn30d: Number(r.new_30d),
  }));
}

/**
 * The portals that actually carry stock, for the filter bar.
 *
 * Counted from the data rather than from `portal_sources`, because a seeded
 * source with nothing behind it makes a filter chip that leads to an empty
 * screen — and an empty screen in this product reads as "no market here",
 * which is the one impression it must never give by accident.
 */
export async function listSourceOptions(): Promise<
  { key: string; name: string; properties: number }[]
> {
  const rows = await db
    .select({
      key: portalSources.key,
      name: portalSources.name,
      properties: sql<number>`count(distinct ${portalListings.propertyId})::int`,
    })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(eq(portalListings.status, "active"))
    .groupBy(portalSources.key, portalSources.name)
    .orderBy(desc(sql`count(distinct ${portalListings.propertyId})`));

  return rows.map((r) => ({ ...r, properties: Number(r.properties) }));
}

export type AgencyStat = {
  id: string;
  name: string;
  active: number;
  medianPriceEur: number | null;
  communes: string[];
};

/** Who is actually carrying the stock, which is the competitor view. */
export async function agencyStats(limit = 25): Promise<AgencyStat[]> {
  const rows = await db
    .select({
      id: portalAgencies.id,
      name: portalAgencies.name,
      active: sql<number>`count(*)::int`,
      medianPrice: sql<string | null>`percentile_cont(0.5) within group (order by ${properties.priceEur})`,
      communes: sql<string[]>`array_agg(distinct ${properties.communeInsee}) filter (where ${properties.communeInsee} is not null)`,
    })
    .from(properties)
    .innerJoin(portalAgencies, eq(portalAgencies.id, properties.agencyId))
    .where(eq(properties.status, "active"))
    .groupBy(portalAgencies.id, portalAgencies.name)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    active: Number(r.active),
    medianPriceEur: r.medianPrice === null ? null : Math.round(Number(r.medianPrice)),
    communes: (r.communes ?? []).map((i) => COMMUNE_LABELS[i] ?? i),
  }));
}

/** Headline counts for the dashboard, including an honest test-data warning. */
export async function overview(): Promise<{
  activeProperties: number;
  /** Null until we hold more than seven days of history — see the query. */
  newThisWeek: number | null;
  buyersReal: number;
  buyersTest: number;
  matchesOpen: number;
  sources: { key: string; name: string; enabled: boolean; lastRunAt: Date | null }[];
}> {
  const [{ active }] = await db
    .select({ active: sql<number>`count(*) filter (where status = 'active')::int` })
    .from(properties);

  /**
   * "New this week" needs a week of history behind it.
   *
   * Collection started three days ago, so every property was first seen inside
   * the window and this returned 2392 out of 2392 active — presented on the
   * dashboard as though the market had gained two and a half thousand
   * properties in a week. Arithmetically correct, and the most misleading
   * number on the screen.
   *
   * So it is only a figure once the earliest sighting is older than the window.
   * Until then the screen shows that it is still filling, which is the true
   * answer.
   */
  const [{ fresh, earliest }] = await db
    .select({
      fresh: sql<number>`count(*) filter (where first_listed_at > now() - interval '7 days')::int`,
      earliest: sql<Date | null>`min(first_listed_at)`,
    })
    .from(properties);

  const windowStart = new Date(Date.now() - 7 * 86_400_000);
  const haveAWeek = earliest !== null && new Date(earliest) < windowStart;

  const buyerCounts = await db
    .select({
      isTest: buyers.isTestData,
      n: sql<number>`count(*)::int`,
    })
    .from(buyers)
    .where(eq(buyers.active, true))
    .groupBy(buyers.isTestData);

  /**
   * Real buyers only.
   *
   * The banner on the overview screen states that matches against the invented
   * buyers are excluded from this count. It was not true: this counted every
   * row in buyer_matches, so ten fabricated buyers put 3711 "open matches" on
   * the dashboard — a number an agent would act on, sitting directly under a
   * sentence promising it had been left out.
   *
   * The rule at the top of this file already said what to do here. This query
   * simply did not follow it.
   */
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(buyerMatches)
    .innerJoin(buyers, eq(buyers.id, buyerMatches.buyerId))
    .where(
      and(
        inArray(buyerMatches.status, ["new", "seen"]),
        eq(buyers.isTestData, false),
      ),
    );

  const sources = await db
    .select({
      key: portalSources.key,
      name: portalSources.name,
      enabled: portalSources.enabled,
      lastRunAt: portalSources.lastRunAt,
    })
    .from(portalSources)
    .orderBy(portalSources.key);

  return {
    activeProperties: Number(active),
    newThisWeek: haveAWeek ? Number(fresh) : null,
    buyersReal: Number(buyerCounts.find((b) => !b.isTest)?.n ?? 0),
    buyersTest: Number(buyerCounts.find((b) => b.isTest)?.n ?? 0),
    matchesOpen: Number(open),
    sources,
  };
}
