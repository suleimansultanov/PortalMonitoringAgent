import "server-only";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  portalAgencies,
  portalListingEvents,
  portalListings,
  portalRuns,
  portalSources,
  properties,
} from "@/lib/db/schema";
import type { KeyScope } from "./keys";

/**
 * The queries behind /api/v1 — what a client instance is allowed to read.
 *
 * Separate from `lib/api/queries.ts`, which serves our own screens. The two
 * look similar today and will not stay that way: our screens can change shape
 * whenever we like, while this is a contract with software we do not deploy and
 * cannot fix in the same afternoon. Sharing the query would mean a UI tweak
 * silently altering someone else's integration.
 */

export type PropertyPayload = {
  id: string;
  title: string | null;
  description: string | null;
  priceEur: number | null;
  areaM2: number | null;
  landM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  propertyType: string | null;
  communeInsee: string | null;
  imageUrl: string | null;
  imageUrls: string[];
  agencyRef: string | null;
  /**
   * Internal: which agency row to attach. Not part of the contract — the
   * agency itself is sent as `agency` below, and this is stripped before the
   * response leaves.
   */
  agencyId?: string | null;
  /** How many portals carry it. A proxy for how confident the deduplication is. */
  sourceCount: number;
  status: string;
  /** When WE first saw it. Not a publication date — see the caveat on responses. */
  firstListedAt: string | null;
  lastSeenAt: string | null;
  /**
   * One entry per portal carrying this property, with what THAT portal says.
   *
   * The portals disagree, and the disagreement is the product: one lists 12
   * rooms and another 10, one publishes an energy rating and another does not,
   * one has carried the villa since June and another since last week. Sending
   * only a link would leave a client with nothing to show but our own averaged
   * view of a property, which is the one view they could have built themselves.
   */
  listings: ListingPayload[];
  /** The agency behind the mandate, where the portals name one. */
  agency: AgencyPayload | null;
};

export type ListingPayload = {
  source: string;
  /** Display name — "Propriétés Le Figaro", not "figaro". */
  sourceName: string;
  url: string;
  externalId: string;
  priceEur: number | null;
  areaM2: number | null;
  landM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  agencyRef: string | null;
  /**
   * When the PORTAL published it. Only a few portals state this, and where they
   * do, days-on-market is real rather than inferred from when we first looked.
   */
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /**
   * What this portal prints about the property, as it prints it.
   *
   * Deliberately a list of label/value pairs rather than a fixed schema: the
   * portals do not agree on what a characteristic is, and flattening "Terrain
   * 2 730 m²" and "DPE A" into one normalised model would mean choosing which
   * facts survive. The energy rating is lifted out because it is regulated,
   * comparable, and the one field anyone filters on.
   */
  characteristics: { label: string; value: string }[];
  /** Energy performance certificate, as published. */
  dpe: string | null;
  energyKwhM2Year: number | null;
  ges: string | null;
  ghgCo2M2Year: number | null;
  /** The portal's own feature tags: "pool", "terrace", "airConditioning". */
  flags: string[];
};

export type AgencyPayload = {
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  phone: string | null;
};

/** Cursors are opaque on purpose: the encoding is ours to change. */
export function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): { occurredAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const occurredAt = new Date(iso);
    if (Number.isNaN(occurredAt.getTime()) || !id) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

/**
 * Attach what each portal says, and the agency, in two extra queries.
 *
 * Two queries for a page of properties rather than two per property: this is
 * walked forty pages deep by every client that seeds, and a per-row query there
 * is the difference between half a minute and a coffee break.
 */
async function withListings(rows: PropertyPayload[]): Promise<PropertyPayload[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);

  const links = await db
    .select({
      propertyId: portalListings.propertyId,
      source: portalSources.key,
      sourceName: portalSources.name,
      url: portalListings.url,
      externalId: portalListings.externalId,
      priceEur: portalListings.priceEur,
      areaM2: portalListings.areaM2,
      landM2: portalListings.landM2,
      rooms: portalListings.rooms,
      bedrooms: portalListings.bedrooms,
      bathrooms: portalListings.bathrooms,
      agencyRef: portalListings.agencyRef,
      publishedAt: portalListings.publishedAt,
      sourceUpdatedAt: portalListings.sourceUpdatedAt,
      firstSeenAt: portalListings.firstSeenAt,
      lastSeenAt: portalListings.lastSeenAt,
      raw: portalListings.raw,
    })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(and(inArray(portalListings.propertyId, ids), eq(portalListings.status, "active")));

  const byProperty = new Map<string, ListingPayload[]>();
  for (const l of links) {
    if (!l.propertyId) continue;
    const list = byProperty.get(l.propertyId) ?? [];
    list.push({
      source: l.source,
      sourceName: l.sourceName ?? l.source,
      url: l.url,
      externalId: l.externalId,
      priceEur: l.priceEur,
      areaM2: l.areaM2 === null ? null : Number(l.areaM2),
      landM2: l.landM2 === null ? null : Number(l.landM2),
      rooms: l.rooms,
      bedrooms: l.bedrooms,
      bathrooms: l.bathrooms,
      agencyRef: l.agencyRef,
      publishedAt: l.publishedAt?.toISOString() ?? null,
      sourceUpdatedAt: l.sourceUpdatedAt?.toISOString() ?? null,
      firstSeenAt: l.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: l.lastSeenAt?.toISOString() ?? null,
      ...characteristicsOf(l.raw),
    });
    byProperty.set(l.propertyId, list);
  }
  for (const r of rows) r.listings = byProperty.get(r.id) ?? [];

  await withAgency(rows);
  // Stripped rather than merely undocumented: an internal id in a payload is an
  // id somebody eventually depends on.
  for (const r of rows) delete r.agencyId;
  return rows;
}

/**
 * The parsed page, reduced to what a client can display.
 *
 * `raw` itself is never sent. It is the whole structured markup of a portal
 * page — kilobytes per listing, shaped differently by every adapter, and full
 * of things that are ours for re-deriving fields rather than anyone else's to
 * render. What goes out is the part that means something to a reader.
 */
function characteristicsOf(raw: Record<string, unknown> | null): {
  characteristics: { label: string; value: string }[];
  dpe: string | null;
  energyKwhM2Year: number | null;
  ges: string | null;
  ghgCo2M2Year: number | null;
  flags: string[];
} {
  const r = (raw ?? {}) as {
    characteristics?: Record<string, unknown>;
    flags?: unknown;
    dpe?: unknown;
    ges?: unknown;
    energyKwhM2Year?: unknown;
    ghgCo2M2Year?: unknown;
  };

  const characteristics = Object.entries(r.characteristics ?? {})
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([label, v]) => ({ label, value: String(v) }));

  return {
    characteristics,
    dpe: typeof r.dpe === "string" ? r.dpe : null,
    energyKwhM2Year: typeof r.energyKwhM2Year === "number" ? r.energyKwhM2Year : null,
    ges: typeof r.ges === "string" ? r.ges : null,
    ghgCo2M2Year: typeof r.ghgCo2M2Year === "number" ? r.ghgCo2M2Year : null,
    flags: Array.isArray(r.flags) ? r.flags.filter((f): f is string => typeof f === "string") : [],
  };
}

/** The agency on the property row, in one query for the whole page. */
async function withAgency(rows: PropertyPayload[]): Promise<void> {
  const ids = [...new Set(rows.map((r) => r.agencyId).filter((x): x is string => !!x))];
  if (ids.length === 0) {
    for (const r of rows) r.agency = null;
    return;
  }

  const agencies = await db
    .select({
      id: portalAgencies.id,
      name: portalAgencies.name,
      address: portalAgencies.address,
      postalCode: portalAgencies.postalCode,
      city: portalAgencies.city,
      phone: portalAgencies.phone,
    })
    .from(portalAgencies)
    .where(inArray(portalAgencies.id, ids));

  const byId = new Map(agencies.map((a) => [a.id, a]));
  for (const r of rows) {
    const a = r.agencyId ? byId.get(r.agencyId) : undefined;
    r.agency = a
      ? {
          name: a.name,
          address: a.address,
          postalCode: a.postalCode,
          city: a.city,
          phone: a.phone,
        }
      : null;
  }
}

const propertyColumns = {
  id: properties.id,
  title: properties.title,
  description: properties.description,
  priceEur: properties.priceEur,
  areaM2: properties.areaM2,
  landM2: properties.landM2,
  rooms: properties.rooms,
  bedrooms: properties.bedrooms,
  propertyType: properties.propertyType,
  communeInsee: properties.communeInsee,
  imageUrl: properties.imageUrl,
  imageUrls: properties.imageUrls,
  /** Not sent as-is — it selects the agency block below. */
  agencyId: properties.agencyId,
  agencyRef: properties.agencyRef,
  sourceCount: properties.sourceCount,
  status: properties.status,
  firstListedAt: properties.firstListedAt,
  lastSeenAt: properties.lastSeenAt,
};

function toPayload(r: Record<string, unknown>): PropertyPayload {
  return {
    id: r.id as string,
    title: (r.title as string) ?? null,
    description: (r.description as string) ?? null,
    priceEur: (r.priceEur as number) ?? null,
    areaM2: (r.areaM2 as number) ?? null,
    landM2: (r.landM2 as number) ?? null,
    rooms: (r.rooms as number) ?? null,
    bedrooms: (r.bedrooms as number) ?? null,
    propertyType: (r.propertyType as string) ?? null,
    communeInsee: (r.communeInsee as string) ?? null,
    imageUrl: (r.imageUrl as string) ?? null,
    imageUrls: (r.imageUrls as string[]) ?? [],
    agencyRef: (r.agencyRef as string) ?? null,
    sourceCount: (r.sourceCount as number) ?? 1,
    status: (r.status as string) ?? "active",
    firstListedAt: (r.firstListedAt as Date | null)?.toISOString() ?? null,
    lastSeenAt: (r.lastSeenAt as Date | null)?.toISOString() ?? null,
    listings: [],
    agency: null,
    agencyId: (r.agencyId as string) ?? null,
  };
}

/**
 * The snapshot. Ordered by id rather than by date.
 *
 * A cursor on a mutable column skips and repeats rows while the client is
 * paging through it — and a nightly pass mutates `updated_at` on hundreds of
 * rows underneath a page-by-page read. `id` never changes, so a walk is
 * complete even when it takes an hour and the collector runs during it.
 */
export async function snapshot(
  scope: KeyScope,
  opts: { communeInsee: string[]; after?: string; limit: number },
): Promise<{ rows: PropertyPayload[]; nextCursor: string | null }> {
  if (opts.communeInsee.length === 0) return { rows: [], nextCursor: null };

  const conditions = [
    eq(properties.status, "active"),
    inArray(properties.communeInsee, opts.communeInsee),
  ];
  if (opts.after) conditions.push(gt(properties.id, opts.after));

  const rows = await db
    .select(propertyColumns)
    .from(properties)
    .where(and(...conditions))
    .orderBy(asc(properties.id))
    .limit(opts.limit + 1);

  const page = rows.slice(0, opts.limit).map((r) => toPayload(r as Record<string, unknown>));
  await withListings(page);

  return {
    rows: page,
    nextCursor: rows.length > opts.limit ? page[page.length - 1].id : null,
  };
}

export type EventPayload = {
  id: string;
  type: string;
  occurredAt: string;
  priceFrom: number | null;
  priceTo: number | null;
  property: PropertyPayload | null;
};

/**
 * The delta.
 *
 * PROPERTY RESOLVED THROUGH THE LISTING, NOT THROUGH `events.property_id`.
 *
 * That column is denormalised and is only written on delisting — `ingestListing`
 * has never set it, so every `listed` and `price_changed` row carries null, and
 * a filter on it would hide precisely the events a client came for. Joining
 * through `portal_listings` also gives the CURRENT property, which matters
 * independently: a later merge reassigns a listing, and a client asking "what
 * happened to this property" wants the answer that is true now.
 */
export async function events(
  scope: KeyScope,
  opts: { communeInsee: string[]; since?: string; types?: string[]; limit: number },
): Promise<{ rows: EventPayload[]; nextCursor: string | null }> {
  if (opts.communeInsee.length === 0) return { rows: [], nextCursor: null };

  const cursor = opts.since ? decodeCursor(opts.since) : null;

  const conditions = [
    inArray(properties.communeInsee, opts.communeInsee),
    isNotNull(portalListings.propertyId),
  ];
  if (opts.types?.length) conditions.push(inArray(portalListingEvents.type, opts.types));
  if (cursor) {
    /**
     * Strictly after (occurred_at, id). The pair, not the timestamp: two events
     * written in the same millisecond with a timestamp-only cursor means one of
     * them is stepped over, and stepped over silently.
     */
    conditions.push(
      or(
        gt(portalListingEvents.occurredAt, cursor.occurredAt),
        and(
          eq(portalListingEvents.occurredAt, cursor.occurredAt),
          gt(portalListingEvents.id, cursor.id),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      /**
       * Named apart from the property's `id`, which arrives in the spread
       * below. Both are ids of different things and the collision is silent:
       * the later key wins and the event id disappears — taking the cursor
       * with it.
       */
      eventId: portalListingEvents.id,
      type: portalListingEvents.type,
      occurredAt: portalListingEvents.occurredAt,
      priceFrom: portalListingEvents.priceFrom,
      priceTo: portalListingEvents.priceTo,
      ...propertyColumns,
    })
    .from(portalListingEvents)
    .innerJoin(portalListings, eq(portalListings.id, portalListingEvents.listingId))
    .innerJoin(properties, eq(properties.id, portalListings.propertyId))
    .where(and(...conditions))
    .orderBy(asc(portalListingEvents.occurredAt), asc(portalListingEvents.id))
    .limit(opts.limit + 1);

  const page = rows.slice(0, opts.limit);
  const payloads = page.map((r) => toPayload(r as unknown as Record<string, unknown>));
  await withListings(payloads);

  const out: EventPayload[] = page.map((r, i) => ({
    id: r.eventId,
    type: r.type,
    occurredAt: r.occurredAt.toISOString(),
    priceFrom: r.priceFrom ?? null,
    priceTo: r.priceTo ?? null,
    property: payloads[i],
  }));

  const last = page[page.length - 1];
  return {
    rows: out,
    nextCursor:
      rows.length > opts.limit && last ? encodeCursor(last.occurredAt, last.eventId) : null,
  };
}

/**
 * Whether the market this key can see is current, and when it last became so.
 *
 * `status = 'done'` is NOT sufficient and this is the one place it matters
 * most: a pass whose fetching stopped part-way is still recorded as done, with
 * the reason only in `error`. A client polling on "done" would treat a
 * half-collected night as a complete one and start matching against it.
 */
export async function status(scope: KeyScope): Promise<{
  lastSuccessfulCollectionAt: string | null;
  properties: number;
  sources: { key: string; lastRunAt: string | null; lastOutcome: string }[];
}> {
  /**
   * Scoped to the sources this key may read.
   *
   * "The last time collection succeeded" has to mean the last time it succeeded
   * for YOU. A key that sees three portals should not be told the market is
   * current because a fourth one it cannot read finished an hour ago.
   */
  const [{ at }] = await db
    .select({ at: sql<Date | null>`max(${portalRuns.completedAt})` })
    .from(portalRuns)
    .where(
      and(
        eq(portalRuns.status, "done"),
        isNull(portalRuns.error),
        scope.sourceIds.length > 0
          ? inArray(portalRuns.sourceId, scope.sourceIds)
          : sql`false`,
      ),
    );

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(properties)
    .where(
      and(
        eq(properties.status, "active"),
        scope.communeInsee.length > 0
          ? inArray(properties.communeInsee, scope.communeInsee)
          : sql`false`,
      ),
    );

  /**
   * THE LATEST RUN, AND ITS OWN OUTCOME.
   *
   * This was `max(completed_at)` and `max(status)` aggregated side by side,
   * which is two different rows wearing one name. `max` on a status column
   * sorts the words alphabetically over the source's WHOLE history, so:
   *
   *   Green-Acres reported `error` because it errored once, weeks ago —
   *     'error' > 'done', and it would have said so for ever.
   *   SMC reported `done` while every recent pass aborted — 'aborted' < 'done',
   *     so one old success outvoted every current failure.
   *
   * Two of six sources reported the exact opposite of the truth, on the
   * endpoint a client reads to decide whether to trust the data.
   *
   * A lateral join takes the newest completed run per source and reads its own
   * status, so the timestamp and the outcome describe the same pass.
   */
  /**
   * An empty scope means an empty answer, and it has to be checked HERE rather
   * than inside the statement: `s.id in ()` is not valid SQL, where the
   * previous aggregate could fall back to a `false` predicate. A key with no
   * sources is a real state — one revoked source, or a client configured and
   * not yet subscribed — and it must not throw.
   */
  const runRows = scope.sourceIds.length === 0 ? { rows: [] } : await db.execute<{
    key: string;
    last_run_at: string | null;
    last_outcome: string;
  }>(sql`
    select
      s.key,
      r.completed_at as last_run_at,
      coalesce(
        -- A pass that finished and still recorded an error is not a success,
        -- whatever its status column says.
        case when r.error is not null then 'error' else r.status end,
        'never'
      ) as last_outcome
    from ${portalSources} s
    left join lateral (
      select status, completed_at, error
      from ${portalRuns}
      where source_id = s.id and completed_at is not null
      order by completed_at desc
      limit 1
    ) r on true
    where s.id in (${sql.join(
      scope.sourceIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    order by s.key
  `);

  const runs = (runRows.rows as { key: string; last_run_at: string | null; last_outcome: string }[]).map(
    (r) => ({ key: r.key, lastRunAt: r.last_run_at, lastOutcome: r.last_outcome }),
  );

  return {
    lastSuccessfulCollectionAt: at ? new Date(at).toISOString() : null,
    properties: count,
    sources: runs.map((r) => ({
      key: r.key,
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
      lastOutcome: r.lastOutcome,
    })),
  };
}
