import "server-only";
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withDbRetry } from "@/lib/db/client";
import { apiUsage, clients, clientSources, dataHealthChecks, portalListingEvents, portalListings, portalSources, properties } from "@/lib/db/schema";
import type { KeyScope } from "@/lib/api/keys";
import { servedProperty } from "@/lib/api/served";
import { notADuplicateOfOwn, ownAgencies, snapshot, status } from "@/lib/api/v1";
import { AGGREGATORS, carriedPortals, servedListings } from "@/lib/portals/portalOf";
import { periodStart, V1_DEFAULT_RESERVE, V1_PLAN_ITEMS } from "@/lib/portals/streamV1";
import { MOJIBAKE_PATTERN, type FeedProperty } from "./contract";
import { historyFromFeed, type HealthInput, type HistoryRow, type PriceMissing } from "./portalChecks";

/** Why a listing has no price, where its page said so (`PriceMissing`); null otherwise. */
const priceMissingSql = sql<string | null>`case when ${portalListings.priceEur} is null then
  case when ${portalListings.raw}->>'priceOnRequest' = 'true' then 'on_request'
       when ${portalListings.raw}->'foreignPrice' is not null then 'foreign_currency' end end`;
const PriceMissingValue = z.enum(["on_request", "foreign_currency"]).nullable();
const priceMissingOf = (v: unknown): PriceMissing | undefined => PriceMissingValue.parse(v) ?? undefined;

/**
 * The live listings whose page said why it gave no price, by URL: the feed does
 * not carry it per listing. About 125 rows on 2026-11-12, only those
 * with no price and a reason, so one statement fits the ten-second limit.
 */
async function loadPriceMissing(scope: KeyScope): Promise<Map<string, PriceMissing>> {
  const rows = await withDbRetry(() =>
    db
      .select({ url: portalListings.url, why: priceMissingSql })
      .from(portalListings)
      .where(and(inArray(portalListings.sourceId, scope.sourceIds), eq(portalListings.status, "active"), sql`${priceMissingSql} is not null`)),
  );
  const out = new Map<string, PriceMissing>();
  for (const r of rows) {
    const why = priceMissingOf(r.why);
    if (why) out.set(r.url, why);
  }
  return out;
}

/**
 * Data health, the gathering. Only reads.
 *
 * THE FEED IS READ THROUGH `snapshot()`, the function /api/v1/properties calls,
 * not through a query of our own that resembles it. The point is to judge what
 * the client is actually sent: which listings survive the split into portals,
 * which are dropped as a duplicate of its own agency's, which sources it
 * subscribes to. A second definition of the feed would drift from the first, and
 * then a green here would say nothing about the client's screen.
 *
 * That costs about 40 MB and a minute and a half for the feed (6 556 properties,
 * measured 2026-11-04), so it belongs in the nightly. By hand on mobile data it is
 * noticeable, not ruinous; `--feed` re-judges a saved one for nothing.
 */

/**
 * One commune at a time, one after another. Every query on this pool stops at ten
 * seconds (db/client.ts, each of those limits paid for by an outage), and the whole
 * market in one statement does not fit in that; one commune does.
 */
async function inTurn<T>(communes: string[], read: (commune: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (const c of communes) out.push(await withDbRetry(() => read(c)));
  return out;
}

export async function scopeFor(clientSlug: string): Promise<KeyScope> {
  const [client] = await db
    .select({ id: clients.id, slug: clients.slug, communeInsee: clients.communeInsee })
    .from(clients)
    .where(eq(clients.slug, clientSlug))
    .limit(1);
  if (!client) throw new Error(`no client ${clientSlug}`);
  const subscribed = await db
    .select({ sourceId: clientSources.sourceId })
    .from(clientSources)
    .where(and(eq(clientSources.clientId, client.id), eq(clientSources.enabled, true)));
  return {
    keyId: "data-health",
    clientId: client.id,
    clientSlug: client.slug,
    communeInsee: client.communeInsee,
    sourceIds: subscribed.map((s) => s.sourceId),
  };
}

async function loadFeed(scope: KeyScope): Promise<FeedProperty[]> {
  const out: FeedProperty[] = [];
  let after: string | undefined;
  for (;;) {
    // A small page, retried: `raw` makes a page heavy, and over a slow link it can outrun the ten-second limit.
    const { rows, nextCursor } = await withDbRetry(() => snapshot(scope, { communeInsee: scope.communeInsee, after, limit: 100 }));
    out.push(...rows);
    if (!nextCursor) return out;
    after = nextCursor;
  }
}

/**
 * What the client still holds after a property left the market, for the checks
 * that look back at what arrived and when.
 *
 * Vault never deletes, so a property gone from the market still counts towards the
 * night it arrived, and leaving these out would read a portal's fast sellers as a
 * portal that stopped bringing anything. Live properties come from the feed itself
 * (`historyFromFeed`): when two aggregators carry one portal the feed keeps
 * whichever row comes first, so splitting the rows again here would keep a
 * different one, and it moved SeLoger's night by seven (2026-11-04).
 */
async function loadDelistedHistory(scope: KeyScope): Promise<HistoryRow[]> {
  const own = await ownAgencies(scope);
  const readCommune = (commune: string) => db
    .select({
      source: portalSources.key,
      url: portalListings.url,
      firstSeenAt: portalListings.firstSeenAt,
      priceEur: portalListings.priceEur,
      priceMissing: priceMissingSql,
      areaM2: portalListings.areaM2,
      bedrooms: portalListings.bedrooms,
      propertyId: portalListings.propertyId,
      propertyBedrooms: properties.bedrooms,
      propertyType: properties.propertyType,
      communeInsee: properties.communeInsee,
      /** Only the carried links, not the whole `raw`: that is kilobytes per row. */
      carried: sql<unknown>`${portalListings.raw}->'listings'`,
      // The photo the client ends up with: its contract refuses anything not on https.
      hasPhoto: sql<boolean>`coalesce(${properties.imageUrl} like 'https://%', false) or exists (select 1 from unnest(${properties.imageUrls}) u where u like 'https://%')`,
    })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .innerJoin(properties, eq(properties.id, portalListings.propertyId))
    .where(
      and(
        eq(portalSources.enabled, true),
        inArray(portalListings.sourceId, scope.sourceIds),
        eq(properties.communeInsee, commune),
        ne(properties.status, "active"),
        notADuplicateOfOwn(own),
      ),
    );
  const rows = (await inTurn(scope.communeInsee, readCommune)).flat();

  const byProperty = new Map<string, (HistoryRow & { source: string; via: string | null })[]>();
  for (const r of rows) {
    if (!r.propertyId) continue;
    const priceMissing = priceMissingOf(r.priceMissing);
    const base = {
      propertyId: r.propertyId,
      firstSeenAt: r.firstSeenAt,
      hasPrice: r.priceEur !== null,
      ...(priceMissing ? { priceMissing } : {}),
      hasArea: r.areaM2 !== null,
      hasBedrooms: r.bedrooms !== null,
      propertyHasBedrooms: r.propertyBedrooms !== null,
      propertyType: r.propertyType,
      hasPhoto: r.hasPhoto,
      hasCommune: r.communeInsee !== null,
    };
    const list = byProperty.get(r.propertyId) ?? [];
    if (!AGGREGATORS[r.source]) list.push({ ...base, portal: r.source, source: r.source, via: null });
    else for (const p of carriedPortals(r.source, r.url, r.carried)) list.push({ ...base, portal: p.key, source: p.key, via: r.source });
    byProperty.set(r.propertyId, list);
  }

  const history: HistoryRow[] = [];
  for (const list of byProperty.values()) history.push(...servedListings(list));
  return history;
}

/** Active rows per source of ours, before the split: the denominator for "who supplied it". */
async function loadActiveBySource(scope: KeyScope): Promise<Map<string, number>> {
  const readCommune = (commune: string) => db
    .select({ source: portalSources.key, n: sql<number>`count(*)::int` })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .innerJoin(properties, eq(properties.id, portalListings.propertyId))
    .where(and(eq(portalListings.status, "active"), eq(properties.status, "active"), eq(properties.communeInsee, commune)))
    .groupBy(portalSources.key);
  const out = new Map<string, number>();
  for (const r of (await inTurn(scope.communeInsee, readCommune)).flat()) out.set(r.source, (out.get(r.source) ?? 0) + r.n);
  return out;
}

/**
 * The client's duplicate net, as of vault eaed31c: two active cards are one when
 * the commune, the price within 1 % and the area agree (20 % from 1 M€, 3 % below,
 * where round prices repeat across different flats), or when the cover is the very
 * same photo. It decides what the client hides, so it is the measure of what our
 * own deduplication left behind. The client's inventory is not in our feed, so
 * "its own listing stays" has no effect here.
 */
async function loadHiddenDuplicates(scope: KeyScope): Promise<Set<string>> {
  const readCommune = async (commune: string) => {
    const res = await db.execute(sql`
    with a as (
      select id, commune_insee, price_eur, bedrooms, source_count, first_listed_at, image_url,
             case when area_m2 is null or area_m2 < 25 or (price_eur is not null and price_eur / nullif(area_m2::float, 0) > 100000) then null else area_m2::float end as area_ok,
             (area_m2 is not null and (area_m2 < 25 or (price_eur is not null and price_eur / nullif(area_m2::float, 0) > 100000))) as area_bad,
             case
               when coalesce(property_type, '') ~* '(appart|studio|duplex|loft|flat)' then 'flat'
               when coalesce(property_type, '') ~* '(maison|villa|house|bastide|propri)' then 'house'
               when coalesce(property_type, '') ~* '(terrain|land)' then 'land'
               when coalesce(title, '') ~* '(maison|villa|house|bastide|\\mmas\\M)' then 'house'
               when coalesce(title, '') ~* '(appart|studio|duplex|loft)' then 'flat'
               when coalesce(title, '') ~* '(terrain|\\mland\\M)' then 'land'
             end as kind
      from ${properties}
      where status = 'active' and commune_insee = ${commune} and ${servedProperty(scope.sourceIds)}
    ),
    ranked as (
      select *, row_number() over (order by source_count desc, first_listed_at asc nulls last, id) as rk from a
    ),
    pairs as (
      select y.id as dup, x.rk
      from ranked x
      join ranked y on y.commune_insee = x.commune_insee and y.id <> x.id and x.rk < y.rk
      where (
        x.price_eur is not null and y.price_eur is not null
        and abs(x.price_eur - y.price_eur) <= 0.01 * greatest(x.price_eur, y.price_eur)
        and (x.kind is null or y.kind is null or x.kind = y.kind)
        and (x.bedrooms is null or y.bedrooms is null or abs(x.bedrooms - y.bedrooms) <= 1)
        and (
          (x.area_ok is not null and y.area_ok is not null and abs(x.area_ok - y.area_ok) <= (case when x.price_eur >= 1000000 then 0.2 else 0.03 end) * greatest(x.area_ok, y.area_ok))
          or ((x.area_bad or y.area_bad) and (x.area_ok is not null or x.area_bad) and (y.area_ok is not null or y.area_bad)
              and x.kind is not null and x.kind = y.kind
              and (x.bedrooms is null or y.bedrooms is null or x.bedrooms = y.bedrooms))
        )
      ) or (x.image_url is not null and x.image_url = y.image_url)
    )
    select distinct dup from pairs`);
    return z.array(z.object({ dup: z.string() })).parse(res.rows).map((r) => r.dup);
  };
  return new Set((await inTurn(scope.communeInsee, readCommune)).flat());
}

/**
 * Which of our sources holds a value the client refuses, for each property.
 *
 * Asked of the database for the refused values only, so it stays a few rows. A
 * property's gallery is the richest among all its listings, switched-off
 * collectors included, so the row that supplied it can be one the feed never names.
 */
async function loadOrigins(scope: KeyScope): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  const Row = z.object({ property_id: z.string(), key: z.string(), photos: z.boolean(), cover: z.boolean(), title: z.boolean(), description: z.boolean() });
  // The refused properties first, then their listings: a few hundred rows joined on an index, not every listing compared.
  const readCommune = async (commune: string) => {
    const res = await db.execute(sql`
    with bad as materialized (
      select id, title, description, image_url, image_urls
      from ${properties}
      where status = 'active' and commune_insee = ${commune}
        and (title ~ ${MOJIBAKE_PATTERN} or description ~ ${MOJIBAKE_PATTERN} or image_url !~ '^https://'
             or exists (select 1 from unnest(image_urls) u where u !~ '^https://'))
    )
    select b.id as property_id, s.key,
           coalesce(exists (select 1 from unnest(b.image_urls) u where u !~ '^https://' and u = any(l.image_urls)), false) as photos,
           coalesce(b.image_url !~ '^https://' and (b.image_url = l.image_url or b.image_url = any(l.image_urls)), false) as cover,
           coalesce(b.title = l.title and b.title ~ ${MOJIBAKE_PATTERN}, false) as title,
           coalesce(b.description = l.description and b.description ~ ${MOJIBAKE_PATTERN}, false) as description
    from bad b
    join ${portalListings} l on l.property_id = b.id and l.status = 'active'
    join ${portalSources} s on s.id = l.source_id`);
    return z.array(Row).parse(res.rows);
  };
  for (const r of (await inTurn(scope.communeInsee, readCommune)).flat()) {
    const fields = out.get(r.property_id) ?? new Map<string, string[]>();
    for (const field of ["photos", "cover", "title", "description"] as const) {
      if (r[field]) fields.set(field, [...(fields.get(field) ?? []), r.key]);
    }
    out.set(r.property_id, fields);
  }
  return out;
}

async function loadClosedByAge(scope: KeyScope, now: Date): Promise<Map<number, number>> {
  if (scope.communeInsee.length === 0) return new Map();
  const iso = now.toISOString();
  const rows = await db
    .select({
      age: sql<number>`floor(extract(epoch from (${iso}::timestamptz - ${properties.delistedAt})) / 86400)::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(properties)
    .where(
      and(
        ne(properties.status, "active"),
        inArray(properties.communeInsee, scope.communeInsee),
        gte(properties.delistedAt, new Date(now.getTime() - 9 * 86_400_000)),
        lte(properties.delistedAt, now),
      ),
    )
    .groupBy(sql`1`);
  return new Map(rows.map((r) => [r.age, r.n]));
}

async function loadPriceJumps(scope: KeyScope, now: Date): Promise<number> {
  if (scope.communeInsee.length === 0 || scope.sourceIds.length === 0) return 0;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(portalListingEvents)
    .innerJoin(portalListings, eq(portalListings.id, portalListingEvents.listingId))
    .innerJoin(properties, eq(properties.id, portalListings.propertyId))
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(
      and(
        eq(portalListingEvents.type, "price_changed"),
        gte(portalListingEvents.occurredAt, new Date(now.getTime() - 86_400_000)),
        lte(portalListingEvents.occurredAt, now),
        eq(portalSources.enabled, true),
        inArray(portalListings.sourceId, scope.sourceIds),
        inArray(properties.communeInsee, scope.communeInsee),
        sql`${portalListingEvents.priceFrom} > 0 and ${portalListingEvents.priceTo} > 0
            and (${portalListingEvents.priceTo}::numeric / ${portalListingEvents.priceFrom} >= 5
              or ${portalListingEvents.priceTo}::numeric / ${portalListingEvents.priceFrom} <= 0.2)`,
      ),
    );
  return r?.n ?? 0;
}

/** Items this plan period, the way the meter counts them: every ledger row, since a settle gives back what a reserve took. */
async function loadMeter(now: Date): Promise<HealthInput["meter"]> {
  const start = periodStart(now);
  const [r] = await db
    .select({ items: sql<number>`coalesce(sum(${apiUsage.items}), 0)::int` })
    .from(apiUsage)
    .where(and(eq(apiUsage.sourceKey, "stream-estate-v1"), gte(apiUsage.at, start)));
  return { items: r?.items ?? 0, cap: V1_PLAN_ITEMS - V1_DEFAULT_RESERVE, periodStart: start };
}

/**
 * What earlier runs stored, for the checks that compare with their own past.
 *
 * A missing table means the migration has not run yet, which leaves those checks
 * saying "no history" rather than stopping a report that only reads.
 */
async function loadPrevious(clientId: string, now: Date): Promise<Pick<HealthInput, "previous" | "previousPortals">> {
  let rows: { checkKey: string; source: string; value: number | null; detail: Record<string, unknown> }[] = [];
  try {
    rows = await db
      .select({ checkKey: dataHealthChecks.checkKey, source: dataHealthChecks.source, value: dataHealthChecks.value, detail: dataHealthChecks.detail })
      .from(dataHealthChecks)
      .where(and(eq(dataHealthChecks.clientId, clientId), gte(dataHealthChecks.ranAt, new Date(now.getTime() - 8 * 86_400_000)), lte(dataHealthChecks.ranAt, now)))
      .orderBy(asc(dataHealthChecks.ranAt));
  } catch (err) {
    console.warn(`[health] no earlier runs to compare with: ${(err as Error).message.split("\n")[0]}`);
  }
  const previous = (key: string, source = "") => rows.filter((r) => r.checkKey === key && r.source === source && r.value !== null).map((r) => r.value as number);
  const lastPortals = rows.filter((r) => r.checkKey === "market.sources_changed").at(-1)?.detail.portals;
  const parsed = z.array(z.string()).safeParse(lastPortals);
  return { previous, previousPortals: parsed.success ? parsed.data : null };
}

/** `feed`: one already read, so a rule can be re-judged without downloading the market again. */
export async function loadHealthInput(scope: KeyScope, now: Date, feed?: FeedProperty[]): Promise<HealthInput> {
  const properties_ = feed ?? (await loadFeed(scope));
  const history = [...historyFromFeed(properties_, await loadPriceMissing(scope)), ...(await loadDelistedHistory(scope))];
  const activeBySource = await loadActiveBySource(scope);
  const feedStatus = await status(scope);
  const closedByAge = await loadClosedByAge(scope, now);
  const priceJumps = await loadPriceJumps(scope, now);
  const hiddenDuplicates = await loadHiddenDuplicates(scope);
  const origins = await loadOrigins(scope);
  const meter = await loadMeter(now);
  const prev = await loadPrevious(scope.clientId, now);
  return {
    now,
    properties: properties_,
    history,
    status: feedStatus.sources,
    lastCollectionAt: feedStatus.lastSuccessfulCollectionAt,
    closedByAge,
    priceJumps,
    hiddenDuplicates,
    origins,
    activeBySource,
    meter,
    ...prev,
  };
}
