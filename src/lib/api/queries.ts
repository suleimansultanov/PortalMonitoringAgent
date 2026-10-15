import "server-only";
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  buyerMatches,
  buyers,
  marketReports,
  portalAgencies,
  portalListingEvents,
  portalListings,
  portalSources,
  properties,
  settings,
} from "@/lib/db/schema";
import { GULF_OF_SAINT_TROPEZ } from "@/lib/portals/communes";
import { AGGREGATORS, carriedPortals, portalLinks, portalOf } from "@/lib/portals/portalOf";
import { hasFeature } from "@/lib/matching/buyers";
import { getReport, type ReportRow } from "@/lib/reports/queries";
import { communesWithin, type MarketScope } from "@/lib/auth/scope";
import { servedProperty } from "./served";

/**
 * Every read the product screens make, in one place.
 *
 * Kept out of the route handlers and out of the components so that the shape of
 * a screen and the shape of a query can change independently, and so there is
 * one place to look when a number on a page is wrong.
 *
 * EVERY READ TAKES A SCOPE, AND IT IS THE FIRST ARGUMENT.
 *
 * The session's client, from `requireClient()` / `clientForRequest()`
 * (lib/auth/tenant.ts). A client's buyers, matches and reports are filtered
 * by its id; the market is narrowed to its communes and to the sources it
 * subscribes to — the reach its API key has. Until 2026-10-15 nothing here
 * took a client: the Matches screen listed every client's buyers and the
 * Reports screen read Med-Estates' by a hardcoded slug. A function that reads
 * per-client data without a scope is the bug this rule exists to prevent; the
 * parameter is not optional so that forgetting it is a type error.
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

/**
 * The property is in one of these communes. An empty list is `false`, never
 * "no filter": a client watching no commune is shown no market.
 */
export function inCommunes(communes: string[]): SQL {
  return communes.length > 0 ? inArray(properties.communeInsee, communes) : sql`false`;
}

/** The listing comes from one of these sources. Empty is `false`, as above. */
export function fromSources(sourceIds: string[]): SQL {
  return sourceIds.length > 0 ? inArray(portalListings.sourceId, sourceIds) : sql`false`;
}

/** `column in (ids)` for a hand-written subquery with its own aliases; empty is `false`. */
function uuidIn(column: SQL, ids: string[]): SQL {
  return ids.length > 0
    ? sql`${column} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql`false`;
}

/** The match belongs to one of this client's buyers. */
export function ownMatches(scope: MarketScope): SQL {
  return eq(buyers.clientId, scope.clientId);
}

/**
 * ON THE MARKET, AS THE CLIENT'S APP SEES IT.
 *
 * Active, in the client's communes, and SERVED: carried by at least one
 * active listing from a source that is still collected and that the client
 * subscribes to — `servedProperty`, the predicate /api/v1 uses
 * (lib/api/served.ts). Until 2026-10-15 the screens counted every active row:
 * 7 392 "active properties" on the Overview against 6 278 served to the
 * client's app, cards priced from Figaro as read in September by a collector
 * switched off on the 16th, and a portal filter offering sources nobody runs.
 * Two screens showing two markets, with nothing to say which is right.
 *
 * Every list and count of properties on the screens goes through this.
 */
export function liveProperty(scope: MarketScope): SQL {
  return and(
    eq(properties.status, "active"),
    inCommunes(scope.communeInsee),
    servedProperty(scope.sourceIds),
  )!;
}

/**
 * The same rule for one listing, inside a hand-written subquery over
 * `portal_listings pl join portal_sources ps`: active, from a source still
 * collected, that the client subscribes to.
 */
function servedListing(scope: MarketScope): SQL {
  return sql`pl.status = 'active' and ps.enabled and ${uuidIn(sql`pl.source_id`, scope.sourceIds)}`;
}

/** "Prix sur demande", said by a listing the client is served. A null price alone is not evidence. */
function priceOnRequest(scope: MarketScope): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${portalListings} pl
    join ${portalSources} ps on ps.id = pl.source_id
    where pl.property_id = ${properties.id}
      and ${servedListing(scope)}
      and (pl.raw->>'priceOnRequest') = 'true'
  )`;
}

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
  /**
   * The agency withheld the price — "prix sur demande" — as opposed to a
   * price we failed to read. True only when a portal carrying the property
   * says so (`raw.priceOnRequest`); a null price on its own is not evidence.
   */
  priceOnRequest: boolean;
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
  /**
   * `source` is the site the link opens. For a listing collected through an
   * aggregator that is the portal read off the URL, and `via` names the
   * aggregator — the card says "Belles Demeures", not "stream-estate".
   */
  portals: { source: string; url: string; via?: string }[];
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

/** Newest first, and total: see the note where `listProperties` uses it. */
export const LISTING_ORDER = [desc(properties.firstListedAt), desc(properties.id)] as const;

/**
 * Properties, with the portals carrying each one.
 *
 * The unit is the deduplicated PROPERTY, not the listing. A villa on four
 * portals is one row with a "×4" badge — showing it four times is the single
 * fastest way to make the whole product look broken to someone who knows the
 * market.
 */
export async function listProperties(
  scope: MarketScope,
  f: ListingFilters = {},
): Promise<{
  rows: ListingRow[];
  /** Properties matching the filter, across every page. */
  total: number;
  /** Portal entries those properties were folded from, across every page. */
  totalListings: number;
}> {
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;

  const conditions = [
    // What /api/v1 serves this client. A commune outside the scope narrows to
    // nothing rather than widening.
    liveProperty({ ...scope, communeInsee: communesWithin(scope.communeInsee, f.communeInsee) }),
  ];
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
          and ${servedListing(scope)}
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
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(
      and(
        eq(portalListings.status, "active"),
        // Only the entries the client is served: not a switched-off collector's.
        eq(portalSources.enabled, true),
        fromSources(scope.sourceIds),
        inArray(portalListings.propertyId, matching),
      ),
    );

  const rows = await db
    .select({
      id: properties.id,
      title: properties.title,
      description: properties.description,
      imageUrl: properties.imageUrl,
      imageUrls: properties.imageUrls,
      priceEur: properties.priceEur,
      /**
       * Whether any portal says the agency withheld the price. The screen
       * used to print "on request" for every null — 228 properties on
       * 2026-10-07, of which 58 were on request and the rest were prices
       * the parser had not read (Green-Acres in dollars, mostly).
       */
      priceOnRequest: priceOnRequest(scope),
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
    /**
     * `id` breaks the ties. `first_listed_at` is not unique — a backfill
     * stamps hundreds of properties in the same pass — and OFFSET over an
     * order with ties lets Postgres put the tied rows in a different order on
     * every query, so page two repeated some of page one and skipped others.
     * With the id the order is total and each page is the next one. Served by
     * `properties_active_listed_idx` (drizzle/0010).
     */
    .orderBy(...LISTING_ORDER)
    .limit(limit)
    .offset(offset);

  const ids = rows.map((r) => r.id);
  const portals = await portalsFor(scope, ids);

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

async function portalsFor(
  scope: MarketScope,
  propertyIds: string[],
): Promise<Map<string, ListingRow["portals"]>> {
  if (propertyIds.length === 0) return new Map();
  const rows = await db
    .select({
      propertyId: portalListings.propertyId,
      source: portalSources.key,
      url: portalListings.url,
      /** Only the carried listings, not the whole `raw` — that is kilobytes per row. */
      carried: sql<unknown>`${portalListings.raw}->'listings'`,
    })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(
      and(
        inArray(portalListings.propertyId, propertyIds),
        eq(portalListings.status, "active"),
        // No chip for a collector switched off: its link is a month-old reading.
        eq(portalSources.enabled, true),
        fromSources(scope.sourceIds),
      ),
    );

  const byProperty = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.propertyId) continue;
    byProperty.set(r.propertyId, [...(byProperty.get(r.propertyId) ?? []), r]);
  }

  const out = new Map<string, ListingRow["portals"]>();
  for (const [propertyId, listings] of byProperty) out.set(propertyId, cardPortals(listings));
  return out;
}

/**
 * The chips on a card: one entry per DIRECT listing — so a portal carrying
 * the villa twice still shows "×2", the deduplication fault worth seeing —
 * then one per portal an aggregator row carries, skipping any portal we
 * already hold directly. A Stream.Estate row with SeLoger and Leboncoin is
 * two chips, not one "stream-estate".
 */
function cardPortals(listings: { source: string; url: string; carried?: unknown }[]): ListingRow["portals"] {
  const direct = listings.filter((l) => !AGGREGATORS[l.source]);
  const held = new Set(direct.map((l) => l.source));
  const viaAggregator = portalLinks(listings.filter((l) => AGGREGATORS[l.source]))
    .filter((p) => !held.has(p.key))
    .map((p) => ({ source: p.key, url: p.url, via: p.via }));
  return [...direct.map((l) => ({ source: l.source, url: l.url })), ...viaAggregator];
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
 *
 * Only matches on properties still on the market as the client's app sees it
 * (`liveProperty`). The card shows no "delisted" mark, so a match on a
 * property that has gone, or that only a switched-off collector still
 * carries, read as a live proposal at a stale price.
 */
export async function listMatches(
  scope: MarketScope,
  opts: {
    includeTestData?: boolean;
    includeDismissed?: boolean;
    buyerId?: string;
    limit?: number;
  } = {},
): Promise<MatchRow[]> {
  const limit = Math.min(opts.limit ?? 100, 300);

  // This client's buyers. A `buyerId` of another client's buyer finds nothing.
  const conditions: SQL[] = [ownMatches(scope), liveProperty(scope)];
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
      priceOnRequest: priceOnRequest(scope),
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
    .where(and(...conditions))
    .orderBy(desc(buyerMatches.score), desc(buyerMatches.createdAt))
    .limit(limit);

  const portals = await portalsFor(scope, rows.map((r) => r.propertyId));

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
      priceOnRequest: r.priceOnRequest,
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

/**
 * An agent acting on a match: seen, sent, dismissed.
 *
 * Only a match of THIS client's buyers. Until 2026-10-15 `PATCH /api/matches`
 * updated any match by id, so anyone signed in could dismiss another client's
 * proposals — and a dismissal, with its reason, is the one piece of feedback
 * the scoring ever gets. Another client's match id answers as missing, not
 * forbidden: whether it exists is not this client's business.
 */
export async function setMatchStatus(
  scope: MarketScope,
  change: { id: string; status: "new" | "seen" | "sent" | "dismissed"; dismissedReason?: string },
): Promise<{ id: string; status: string } | null> {
  const [updated] = await db
    .update(buyerMatches)
    .set({
      status: change.status,
      dismissedReason: change.status === "dismissed" ? (change.dismissedReason ?? null) : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(buyerMatches.id, change.id),
        inArray(
          buyerMatches.buyerId,
          db.select({ id: buyers.id }).from(buyers).where(eq(buyers.clientId, scope.clientId)),
        ),
      ),
    )
    .returning({ id: buyerMatches.id, status: buyerMatches.status });
  return updated ?? null;
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
 *
 * What it says comes from sources still collected, as in /api/v1. A
 * switched-off collector's listing is a reading nobody has checked since —
 * Figaro's, by 2026-10-15, a month old — and putting its price beside last
 * night's makes up a disagreement. Delisted listings of running sources stay:
 * they are the history. A property that only switched-off or unsubscribed
 * sources ever carried is not found.
 */
export async function propertyDetail(
  scope: MarketScope,
  id: string,
): Promise<PropertyDetail | null> {
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
    // Outside the client's communes it is not in its market: not found.
    .where(and(eq(properties.id, id), inCommunes(scope.communeInsee)))
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
    .where(
      and(
        eq(portalListings.propertyId, id),
        eq(portalSources.enabled, true),
        fromSources(scope.sourceIds),
      ),
    )
    .orderBy(portalSources.key);

  // Nothing of it reaches this client through a source it subscribes to and we still run.
  if (listingRows.length === 0) return null;

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
    /**
     * Through the listing, as /api/v1/events does — not the event's own
     * `property_id`. That copy is written when the event is, usually before
     * resolve has given the listing its property, and nothing fills it in
     * afterwards: on 2026-10-15 it was null on 28 512 of 40 484 events and
     * pointed at a since-merged property on 2 346 more, so this History said
     * "Nothing recorded yet" about most of the market.
     */
    .innerJoin(portalListings, eq(portalListings.id, portalListingEvents.listingId))
    .where(
      and(
        eq(portalListings.propertyId, id),
        // The event's own source still collected, as /api/v1/events has it.
        eq(portalSources.enabled, true),
        scope.sourceIds.length > 0
          ? inArray(portalListingEvents.sourceId, scope.sourceIds)
          : sql`false`,
      ),
    )
    .orderBy(desc(portalListingEvents.occurredAt))
    .limit(100);

  let agencyActive = 0;
  if (row.agencyId) {
    const [c] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(properties)
      .where(and(eq(properties.agencyId, row.agencyId), liveProperty(scope)));
    agencyActive = Number(c?.n ?? 0);
  }

  const areaM2 = row.areaM2 === null ? null : Number(row.areaM2);
  const portalsList = cardPortals(
    listingRows
      .filter((l) => l.status === "active")
      .map((l) => ({ source: l.source, url: l.url, carried: l.raw?.listings })),
  );

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
      priceOnRequest: listingRows.some(
        (l) => l.status === "active" && l.raw?.priceOnRequest === true,
      ),
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
      // "SeLoger, Leboncoin · via Stream.Estate": every portal the row carries, then who brought it.
      sourceName: AGGREGATORS[l.source]
        ? `${carriedPortals(l.source, l.url, l.raw?.listings).map((p) => p.name).join(", ") || (portalOf(l.url)?.name ?? l.sourceName)} · via ${AGGREGATORS[l.source]}`
        : l.sourceName,
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
  /**
   * NULL until we have been watching for thirty days.
   *
   * Otherwise the figure is not "new this month", it is "everything we have
   * collected", and it comes out larger than the active count — 921 new
   * against 913 active in Sainte-Maxime on 30 August, four days after that
   * portal was first read. Arithmetically correct, and it reads as a market
   * that turned over completely in a month.
   *
   * `newThisWeek` on the Overview has refused to answer for the same reason
   * since the day it was written; this is that rule applied where it was
   * missed.
   */
  newIn30d: number | null;
};

/**
 * Per-commune market summary.
 *
 * MEDIAN, not mean, everywhere. One 30M villa in Ramatuelle drags an average
 * far away from anything a buyer would recognise as the local price, and a
 * report whose numbers do not match what agents see on the ground is a report
 * they stop opening.
 */
export async function communeStats(scope: MarketScope): Promise<CommuneStat[]> {
  /**
   * `properties` is not aliased here, on purpose: the shared predicates
   * (`inCommunes`, `servedProperty`) name it as "properties", and an alias
   * would hide it from them.
   */
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
      ${properties.communeInsee} as commune_insee,
      count(*) filter (where ${properties.status} = 'active')::int as active,
      percentile_cont(0.5) within group (order by ${properties.priceEur})
        filter (where ${properties.priceEur} is not null) as median_price,
      percentile_cont(0.5) within group (
        order by ${properties.priceEur} / nullif(${properties.areaM2}::numeric, 0)
      ) filter (where ${properties.priceEur} is not null and ${properties.areaM2} is not null) as median_ppm2,
      percentile_cont(0.5) within group (
        order by extract(epoch from (coalesce(${properties.delistedAt}, now()) - ${properties.firstListedAt})) / 86400
      ) filter (where ${properties.firstListedAt} is not null) as median_dom,
      (
        select count(*)::int from ${portalListingEvents} e
        join ${portalListings} l on l.id = e.listing_id
        join ${portalSources} s on s.id = e.source_id
        where l.property_id in (
          select p2.id from ${properties} p2 where p2.commune_insee = ${properties.communeInsee}
        )
        -- A cut seen by a source still collected, as /api/v1/events serves them.
        and s.enabled and ${uuidIn(sql`e.source_id`, scope.sourceIds)}
        and e.type = 'price_changed'
        and (e.payload->>'direction') = 'down'
        and e.occurred_at > now() - interval '30 days'
      ) as price_cuts_30d,
      count(*) filter (where ${properties.firstListedAt} > now() - interval '30 days')::int as new_30d
    from ${properties}
    where ${inCommunes(scope.communeInsee)}
      /**
       * The live market as the client's app sees it, plus what has gone. A
       * delisted property stays in, because days-on-market is measured on what
       * left; an active one counts only if it is served — not the 1 114 on
       * 2026-10-15 that only a switched-off collector still carried, at its
       * last price.
       */
      and (
        ${servedProperty(scope.sourceIds)}
        or (${properties.status} <> 'active' and exists (
          select 1 from ${portalListings} pl
          where pl.property_id = ${properties.id} and ${uuidIn(sql`pl.source_id`, scope.sourceIds)}
        ))
      )
    group by ${properties.communeInsee}
    order by active desc
  `);

  /**
   * How long our own record actually runs. A window we have not lived through
   * cannot be reported on, and saying "—" is the only honest answer until we
   * have.
   */
  const [{ oldest }] = await db
    .select({ oldest: sql<Date | null>`min(first_seen_at)` })
    .from(portalListings)
    .where(fromSources(scope.sourceIds));
  const watchedLongEnough =
    oldest !== null && Date.now() - new Date(oldest).getTime() >= 30 * 86_400_000;

  return rows.rows.map((r) => ({
    insee: r.commune_insee,
    label: COMMUNE_LABELS[r.commune_insee] ?? r.commune_insee,
    active: Number(r.active),
    medianPriceEur: r.median_price === null ? null : Math.round(Number(r.median_price)),
    medianPricePerM2: r.median_ppm2 === null ? null : Math.round(Number(r.median_ppm2)),
    medianDaysOnMarket: r.median_dom === null ? null : Math.round(Number(r.median_dom)),
    priceCuts30d: Number(r.price_cuts_30d),
    newIn30d: watchedLongEnough ? Number(r.new_30d) : null,
  }));
}

/**
 * The portals that actually carry stock, for the filter bar.
 *
 * Counted from the data rather than from `portal_sources`, because a seeded
 * source with nothing behind it makes a filter chip that leads to an empty
 * screen — and an empty screen in this product reads as "no market here",
 * which is the one impression it must never give by accident.
 *
 * Only sources still collected. A switched-off one keeps its active rows, so
 * until 2026-10-15 the bar offered Figaro, SMC, Superimmo and JamesEdition as
 * filters — each leading to listings nobody had checked in weeks.
 */
export async function listSourceOptions(scope: MarketScope): Promise<
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
    .innerJoin(properties, eq(properties.id, portalListings.propertyId))
    .where(
      and(
        // The join is the served rule itself: an active listing, of a running,
        // subscribed source, on an active property in the client's communes.
        eq(portalListings.status, "active"),
        eq(portalSources.enabled, true),
        fromSources(scope.sourceIds),
        eq(properties.status, "active"),
        inCommunes(scope.communeInsee),
      ),
    )
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
export async function agencyStats(scope: MarketScope, limit = 25): Promise<AgencyStat[]> {
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
    .where(liveProperty(scope))
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
export async function overview(scope: MarketScope): Promise<{
  activeProperties: number;
  /** Null until we hold more than seven days of history — see the query. */
  newThisWeek: number | null;
  buyersReal: number;
  buyersTest: number;
  matchesOpen: number;
  /** The sources this client subscribes to, switched on or not. */
  sources: { key: string; name: string; enabled: boolean; lastRunAt: Date | null }[];
}> {
  // The figure /api/v1/status gives the client's app — see `liveProperty`.
  const [{ active }] = await db
    .select({ active: sql<number>`count(*)::int` })
    .from(properties)
    .where(liveProperty(scope));

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
   *
   * The count is of what is live now; the earliest sighting is of everything,
   * because it measures how long we have been watching, not the market.
   */
  const [{ fresh, earliest }] = await db
    .select({
      fresh: sql<number>`count(*) filter (
        where ${liveProperty(scope)} and ${properties.firstListedAt} > now() - interval '7 days'
      )::int`,
      earliest: sql<Date | null>`min(${properties.firstListedAt})`,
    })
    .from(properties)
    .where(inCommunes(scope.communeInsee));

  const windowStart = new Date(Date.now() - 7 * 86_400_000);
  const haveAWeek = earliest !== null && new Date(earliest) < windowStart;

  const buyerCounts = await db
    .select({
      isTest: buyers.isTestData,
      n: sql<number>`count(*)::int`,
    })
    .from(buyers)
    .where(and(eq(buyers.active, true), eq(buyers.clientId, scope.clientId)))
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
    .innerJoin(properties, eq(properties.id, buyerMatches.propertyId))
    .where(
      and(
        ownMatches(scope),
        // The same matches the Matches screen lists: on a property still live.
        liveProperty(scope),
        inArray(buyerMatches.status, ["new", "seen"]),
        eq(buyers.isTestData, false),
      ),
    );

  const sources =
    scope.sourceIds.length === 0
      ? []
      : await db
          .select({
            key: portalSources.key,
            name: portalSources.name,
            enabled: portalSources.enabled,
            lastRunAt: portalSources.lastRunAt,
          })
          .from(portalSources)
          .where(inArray(portalSources.id, scope.sourceIds))
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

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

export type SourceRun = {
  status: string;
  mode: string;
  startedAt: Date;
  completedAt: Date | null;
  seen: number;
  added: number;
  gone: number;
  failed: number;
  communes: number;
  abortedReason: string | null;
  error: string | null;
};

export type SourceStat = {
  key: string;
  name: string;
  /** Every site this one adapter covers — SMC is two brands on one engine. */
  hosts: string[];
  enabled: boolean;
  /** Live now. */
  active: number;
  /** Ever seen, including what has since gone. */
  everSeen: number;
  delisted: number;
  /** Communes this source has any live stock in. */
  communes: number;
  /** Live listings first seen inside the window. */
  newLast24h: number;
  newLast7d: number;
  /** Oldest and newest first sighting we hold — how far back our own record runs. */
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  /** Listings whose page we have not re-read in over a week. */
  stale: number;
  lastRun: SourceRun | null;
};

/**
 * Everything the Sources screen shows, in one query set.
 *
 * The screen exists because "how much have we got" was, for a week, a question
 * answered by counting files on a laptop. Three separate truncations hid inside
 * that gap — a page ceiling, an ignored pagination parameter, an index error
 * read as an ending — and each was found by hand, days late, because nothing
 * put a source's own numbers where somebody would see them.
 *
 * Note what is deliberately NOT here: a "listings on the portal" figure to
 * compare against. We cannot know it without asking the portal, and a number
 * that looks authoritative while being a guess is worse than an absent one.
 * What the screen gives instead is every signal that moves when collection
 * breaks — the last run's counts, how much is stale, whether a pass aborted —
 * so a wrong total shows up as a wrong shape.
 *
 * Scoped to the sources the client subscribes to, but each source's counts are
 * the collector's own, across every commune. This screen is about whether a
 * collector is healthy, and a listing whose commune the parser could not read
 * (635 active on 2026-10-15) is still a page that collector holds; narrowing
 * by commune would hide exactly the ones worth looking at. They are counts,
 * never rows, of market data that is shared by design.
 */
export async function sourceStats(scope: MarketScope): Promise<SourceStat[]> {
  if (scope.sourceIds.length === 0) return [];
  const sources = await db
    .select({
      id: portalSources.id,
      key: portalSources.key,
      name: portalSources.name,
      hosts: portalSources.hosts,
      enabled: portalSources.enabled,
    })
    .from(portalSources)
    .where(inArray(portalSources.id, scope.sourceIds))
    .orderBy(portalSources.key);

  const counts = await db.execute(sql`
    select
      l.source_id,
      count(*) filter (where l.status = 'active')::int                    as active,
      count(*)::int                                                       as ever_seen,
      count(*) filter (where l.status <> 'active')::int                   as delisted,
      count(distinct l.commune_insee) filter (where l.status = 'active')::int as communes,
      count(*) filter (
        where l.status = 'active' and l.first_seen_at > now() - interval '24 hours'
      )::int                                                              as new_24h,
      count(*) filter (
        where l.status = 'active' and l.first_seen_at > now() - interval '7 days'
      )::int                                                              as new_7d,
      count(*) filter (
        where l.status = 'active' and l.updated_at < now() - interval '7 days'
      )::int                                                              as stale,
      min(l.first_seen_at)                                                as first_seen,
      max(l.first_seen_at)                                                as last_seen
    from portal_listings l
    group by l.source_id
  `);

  const byId = new Map<string, Record<string, unknown>>();
  for (const r of counts.rows as unknown as Record<string, unknown>[]) {
    byId.set(String(r.source_id), r);
  }

  const runs = await db.execute(sql`
    select distinct on (r.source_id)
      r.source_id, r.status, r.mode, r.started_at, r.completed_at,
      r.seen_count, r.new_count, r.gone_count, r.failed_count,
      cardinality(r.commune_insee) as communes,
      r.aborted_reason, r.error
    from portal_runs r
    order by r.source_id, r.started_at desc
  `);

  const runById = new Map<string, Record<string, unknown>>();
  for (const r of runs.rows as unknown as Record<string, unknown>[]) {
    runById.set(String(r.source_id), r);
  }

  const n = (v: unknown): number => Number(v ?? 0);
  const d = (v: unknown): Date | null => (v ? new Date(String(v)) : null);

  return sources.map((s) => {
    const c = byId.get(s.id);
    const r = runById.get(s.id);
    return {
      key: s.key,
      name: s.name,
      hosts: (s.hosts ?? []).filter((h) => !h.startsWith("www.")),
      enabled: s.enabled,
      active: n(c?.active),
      everSeen: n(c?.ever_seen),
      delisted: n(c?.delisted),
      communes: n(c?.communes),
      newLast24h: n(c?.new_24h),
      newLast7d: n(c?.new_7d),
      stale: n(c?.stale),
      firstSeenAt: d(c?.first_seen),
      lastSeenAt: d(c?.last_seen),
      lastRun: r
        ? {
            status: String(r.status),
            mode: String(r.mode),
            startedAt: new Date(String(r.started_at)),
            completedAt: d(r.completed_at),
            seen: n(r.seen_count),
            added: n(r.new_count),
            gone: n(r.gone_count),
            failed: n(r.failed_count),
            communes: n(r.communes),
            abortedReason: r.aborted_reason ? String(r.aborted_reason) : null,
            error: r.error ? String(r.error) : null,
          }
        : null,
    };
  });
}

/**
 * When the market tables were last pushed to the hosted database.
 *
 * Written by `scripts/sync-to-supabase.sh`, because nothing else knows: the
 * sync is a shell script outside the application, and until it recorded this
 * the deployed site could sit a day behind with no way to tell from inside it.
 * A stale figure that looks live is the most expensive kind on a screen an
 * agent acts from.
 */
export async function lastSyncAt(): Promise<Date | null> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "last_sync_at"))
    .limit(1);
  const v = row[0]?.value;
  return v ? new Date(v) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This client's frozen reports, newest period first.
 *
 * `listReports()` in lib/reports/queries.ts reads Med-Estates' by a hardcoded
 * slug, and `getReport(id)` opens any report by its uuid whoever owns it. So
 * the ids are chosen here, by the client's own id, and each is shaped by
 * `getReport` so there is still one reading of a report row. One query per
 * report: there is one report per period, a dozen a year.
 *
 * The detail screen picks its report out of this list rather than loading the
 * id from the URL: an id that is not this client's — or not a uuid at all —
 * is simply not in it.
 */
export async function clientReports(scope: MarketScope): Promise<ReportRow[]> {
  const owned = await db
    .select({ id: marketReports.id })
    .from(marketReports)
    .where(eq(marketReports.clientId, scope.clientId))
    .orderBy(desc(marketReports.periodStart));
  const rows = await Promise.all(owned.map((r) => getReport(r.id)));
  return rows.filter((r): r is ReportRow => r !== null);
}
