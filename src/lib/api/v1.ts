import "server-only";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
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
  /** How many portals carry it. A proxy for how confident the deduplication is. */
  sourceCount: number;
  status: string;
  /** When WE first saw it. Not a publication date — see the caveat on responses. */
  firstListedAt: string | null;
  lastSeenAt: string | null;
  /** One entry per portal carrying this property. */
  listings: { source: string; url: string; externalId: string }[];
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

/** Attach the portal links to a set of properties, in one extra query. */
async function withListings(rows: PropertyPayload[]): Promise<PropertyPayload[]> {
  if (rows.length === 0) return rows;
  const links = await db
    .select({
      propertyId: portalListings.propertyId,
      source: portalSources.key,
      url: portalListings.url,
      externalId: portalListings.externalId,
    })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(
      and(
        inArray(
          portalListings.propertyId,
          rows.map((r) => r.id),
        ),
        eq(portalListings.status, "active"),
      ),
    );

  const byProperty = new Map<string, PropertyPayload["listings"]>();
  for (const l of links) {
    if (!l.propertyId) continue;
    const list = byProperty.get(l.propertyId) ?? [];
    list.push({ source: l.source, url: l.url, externalId: l.externalId });
    byProperty.set(l.propertyId, list);
  }
  for (const r of rows) r.listings = byProperty.get(r.id) ?? [];
  return rows;
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
