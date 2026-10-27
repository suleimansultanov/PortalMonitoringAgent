import "server-only";
import { coverFromGallery } from "../images";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, withDbRetry } from "@/lib/db/client";
import { portalListingEvents, portalListings, portalSnapshots } from "@/lib/db/schema";
import { contentHash } from "@/lib/utils/crypto";
import { pageKey, putPage } from "@/lib/s3/pages";
import { resolveAgency } from "../agencies";
import { resolveCommune } from "../communes";
import { placedAbroad } from "../abroad";
import type { PoliteFetch, PortalAdapter, RawListing } from "../types";
import { computeEvents, mergeParsed, type ListingState } from "./events";

/**
 * One listing, end to end: fetch, store, parse, reconcile, record history.
 *
 * Deliberately not a transaction across all of it. The page lands in S3 before
 * anything tries to understand it, precisely so a parse failure leaves evidence
 * rather than nothing. Rolling that back on a parser bug would throw away the
 * only copy of the thing we need in order to fix the parser.
 *
 * EVERY DATABASE CALL GOES THROUGH `withDbRetry`. Until 2026-10-15 none here
 * did (only reparse had it), so one dropped pooler connection on listing N
 * ended the pass as `error`, abandoned the rest of the fetch queue, and wrote
 * no delistings although discovery had been complete — twelve such rows sit in
 * `portal_runs`. A retry is only safe where the write can be repeated, which
 * is why the row and its events are now written together (see `reconcile`).
 */

export type IngestDeps = {
  fetch: PoliteFetch;
  adapter: PortalAdapter;
  sourceId: string;
  sourceKey: string;
  runId: string | null;
};

export type IngestOutcome = {
  externalId: string;
  status: "ingested" | "unchanged" | "parse_failed" | "fetch_failed";
  listingId?: string;
  events?: string[];
  error?: string;
};

export async function ingestListing(
  deps: IngestDeps,
  target: { externalId: string; url: string; document?: string },
): Promise<IngestOutcome> {
  const { externalId, url } = target;

  // ── 1. Fetch ────────────────────────────────────────────────────────────
  let html: string;
  try {
    // Unless discovery already holds the record (DiscoveredListing.document):
    // then there is nothing to ask the portal for.
    html = target.document ?? (await deps.fetch(url));
  } catch (err) {
    // A failed fetch is NOT a delisting. The caller decides what a missing page
    // means; here it is only a failure to look.
    return { externalId, status: "fetch_failed", error: (err as Error).message };
  }

  const hash = contentHash(html);

  // ── 2. Skip work the page itself says is unnecessary ────────────────────
  const [lastSnapshot] = await withDbRetry(() =>
    db
      .select({ contentHash: portalSnapshots.contentHash })
      .from(portalSnapshots)
      .where(
        and(
          eq(portalSnapshots.sourceId, deps.sourceId),
          eq(portalSnapshots.externalId, externalId),
        ),
      )
      .orderBy(desc(portalSnapshots.fetchedAt))
      .limit(1),
  );

  const existing = await withDbRetry(() => loadListing(deps.sourceId, externalId));

  if (lastSnapshot?.contentHash === hash && existing && existing.status === "active") {
    // Byte-identical to what we already parsed. Parsing again cannot produce a
    // different answer, so only the "still here" timestamp moves. Not for a
    // delisted row: an identical page coming back IS a change — a relisting —
    // and the parse path below is what writes the `relisted` event and clears
    // `delisted_at`; this shortcut used to resurrect it silently.
    await withDbRetry(() =>
      db
        .update(portalListings)
        .set({ lastSeenAt: new Date(), status: "active", updatedAt: new Date() })
        .where(eq(portalListings.id, existing.id)),
    );
    return { externalId, status: "unchanged", listingId: existing.id };
  }

  // ── 3. Store the page before interpreting it ────────────────────────────
  const s3Key = pageKey(deps.sourceKey, externalId);
  await putPage(s3Key, html);
  // Repeated on a lost answer, this can leave the same snapshot twice: harmless
  // history, where losing the pass over it is not.
  await withDbRetry(() =>
    db.insert(portalSnapshots).values({
      sourceId: deps.sourceId,
      runId: deps.runId,
      externalId,
      url,
      s3Key,
      byteSize: Buffer.byteLength(html, "utf8"),
      contentHash: hash,
    }),
  );

  // ── 4. Parse ────────────────────────────────────────────────────────────
  const result = deps.adapter.parse(html, url);

  if (result.status === "failed") {
    /**
     * Record the failure against the row and move on. The listing keeps
     * whatever we already knew — a broken parser must not be able to blank a
     * record — and the page is in S3 to re-parse once the adapter is fixed.
     */
    if (existing) {
      await withDbRetry(() =>
        db
          .update(portalListings)
          .set({
            parseStatus: "failed",
            parseError: result.error.slice(0, 500),
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(portalListings.id, existing.id)),
      );
    }
    return { externalId, status: "parse_failed", error: result.error };
  }

  const parsed = result.listing;
  const parseStatus = result.status === "partial" ? "partial" : "ok";

  // ── 5. Normalise ────────────────────────────────────────────────────────
  const agencyName = parsed.agencyName;
  const agencyId = agencyName
    ? await withDbRetry(() =>
        resolveAgency({
          name: agencyName,
          address: parsed.agencyAddress,
          postalCode: parsed.agencyPostalCode,
          city: parsed.agencyCity,
          phone: parsed.agencyPhone,
        }),
      )
    : null;

  /**
   * A home abroad, sold from an office in the gulf and filed by the portal
   * under the agency's town — see abroad.ts. Stored, so discovery keeps
   * knowing it, but in no commune and on no property: nothing clusters it and
   * nothing serves it. A row stored before the advert was recognised loses
   * both below, in `reconcile`, and the resolve delists the card it leaves.
   */
  const abroad = placedAbroad(url, parsed.title, parsed.description);

  const commune = abroad
    ? null
    : resolveCommune(
        parsed.communeRaw,
        parsed.postalCode,
        `${parsed.title ?? ""} ${parsed.description ?? ""}`,
      );

  /**
   * The floor under every adapter, including the ones not written yet.
   *
   * On 2026-08-30 a single Saint-Tropez listing published its price as a RANGE
   * — "De 5000000 a 10000000" — which a number reader turned into
   * 500 000 010 000 000. Postgres refused it, the INSERT threw, and the throw
   * took the whole pass with it: the run died at listing 50 of 2104, seventy
   * minutes of crawling thrown away for one bad string on one page.
   *
   * Two things were wrong there and both are worth fixing separately. The
   * adapter should not have produced the number, and it no longer does. But no
   * amount of care in ten adapters guarantees the eleventh, and the cost of
   * being wrong should be one missing field on one listing — never the pass.
   *
   * So an impossible value is dropped rather than clamped. A listing with no
   * price is honest and visibly incomplete; a listing with a plausible-looking
   * invented price is neither, and it is the kind of wrong that survives.
   */
  const priceEur = sane(parsed.priceEur, MAX_PRICE_EUR, "priceEur", url);
  const pricePerM2Raw =
    priceEur !== null && parsed.areaM2 !== null && parsed.areaM2 > 0
      ? Math.round(priceEur / parsed.areaM2)
      : null;
  const pricePerM2 = sane(pricePerM2Raw, MAX_PRICE_EUR, "pricePerM2", url);

  const incoming = {
    url,
    title: parsed.title,
    description: parsed.description,
    /**
     * The cover is the gallery's first entry, never a separately-sourced
     * `og:image` that merely depicts the same thing — see images.ts for the
     * two portals where that difference put the same photograph on screen
     * three times.
     */
    ...coverFromGallery(parsed.imageUrl, parsed.imageUrls),
    priceEur,
    pricePerM2,
    areaM2: parsed.areaM2 === null ? null : String(parsed.areaM2),
    landM2: parsed.landM2 === null ? null : String(parsed.landM2),
    rooms: sane(parsed.rooms, MAX_ROOMS, "rooms", url),
    bedrooms: sane(parsed.bedrooms, MAX_ROOMS, "bedrooms", url),
    bathrooms: sane(parsed.bathrooms, MAX_ROOMS, "bathrooms", url),
    propertyType: parsed.propertyType,
    communeInsee: commune?.insee ?? null,
    communeRaw: parsed.communeRaw,
    postalCode: parsed.postalCode,
    lat: parsed.lat === null ? null : String(parsed.lat),
    lon: parsed.lon === null ? null : String(parsed.lon),
    agencyId,
    agencyRef: parsed.agencyRef,
    availability: parsed.availability,
    publishedAt: parsed.publishedAt,
    sourceUpdatedAt: parsed.sourceUpdatedAt,
    raw: abroad ? { ...(parsed.raw ?? {}), abroad } : parsed.raw,
  };

  // ── 6. Reconcile and record history ─────────────────────────────────────
  const written = await reconcile(deps, externalId, incoming, parseStatus, existing, {
    areaM2: parsed.areaM2,
    availability: parsed.availability,
    abroad,
  });

  return { externalId, status: "ingested", listingId: written.listingId, events: written.events };
}

type Incoming = Omit<typeof portalListings.$inferInsert, "sourceId" | "externalId">;
type StoredListing = typeof portalListings.$inferSelect;

/**
 * Write the row and the events it implies, as one unit, and only over the
 * state the events were computed from.
 *
 * TWO WAYS THE OLD READ-THEN-WRITE RECORDED THINGS TWICE.
 *
 *   Two passes of one source at once (a manual run over the nightly one) both
 *   read the row at price A, both wrote B, and both logged `price_changed`
 *   A→B — or both found no row and both logged `listed`. The unique index
 *   kept the ROW single; nothing kept the history single.
 *
 *   A retried write. With the retry above, a write whose COMMIT reached the
 *   database but whose answer was lost would run again and log its events a
 *   second time.
 *
 * Both are the same question — "is the row still what I computed from?" —
 * so the update carries the answer as its condition (the five fields events
 * are derived from), the insert yields to an existing row instead of
 * updating it, and the events go in the same transaction. Nothing written →
 * someone else (or our own lost commit) got there first: read the row again
 * and recompute, which finds no change and logs nothing.
 */
async function reconcile(
  deps: IngestDeps,
  externalId: string,
  incoming: Incoming,
  parseStatus: "ok" | "partial",
  first: StoredListing | null,
  parsed: { areaM2: number | null; availability: string | null; abroad: string | null },
): Promise<{ listingId: string; events: string[] }> {
  let existing = first;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const done = await withDbRetry(() => writeOnce(deps, externalId, incoming, parseStatus, existing, parsed));
    if (done) return done;
    existing = await withDbRetry(() => loadListing(deps.sourceId, externalId));
  }
  throw new Error(`${externalId}: the row kept changing underneath the write — gave up after 3 attempts`);
}

/** The state events are computed from. The write is conditional on exactly these fields. */
export function stateOf(row: Pick<StoredListing, "priceEur" | "areaM2" | "rooms" | "availability" | "status">): ListingState {
  return {
    priceEur: row.priceEur,
    areaM2: row.areaM2 === null ? null : Number(row.areaM2),
    rooms: row.rooms,
    availability: row.availability,
    status: row.status === "delisted" ? "delisted" : "active",
  };
}

async function writeOnce(
  deps: IngestDeps,
  externalId: string,
  incoming: Incoming,
  parseStatus: "ok" | "partial",
  existing: StoredListing | null,
  parsed: { areaM2: number | null; availability: string | null; abroad: string | null },
): Promise<{ listingId: string; events: string[] } | null> {
  const before = existing ? stateOf(existing) : null;

  /**
   * From what is STORED, not from the raw parse. `sane()` drops an impossible
   * price from the row; built from `parsed`, the event log recorded the
   * change the row refused — "De 5000000 à 10000000" became a `price_changed`
   * to 5e14 while the row kept its old price.
   */
  const after: ListingState = {
    priceEur: incoming.priceEur ?? null,
    areaM2: parsed.areaM2,
    rooms: incoming.rooms ?? null,
    availability: parsed.availability,
    status: "active",
  };

  const events = computeEvents(before, after);
  const now = new Date();

  return db.transaction(async (tx) => {
    let listingId: string;

    if (existing) {
      /**
       * mergeParsed drops nulls, so a degraded parse can only ever add
       * information. Better a stale number than a hole: a stale number is wrong
       * in a way somebody eventually notices, a hole just quietly shrinks the
       * dataset.
       */
      const patch = mergeParsed(existing as unknown as Record<string, unknown>, incoming);
      const [row] = await tx
        .update(portalListings)
        .set({
          ...patch,
          // mergeParsed never writes a null, so the commune a row was filed
          // under before it was recognised as abroad has to be taken off here.
          ...(parsed.abroad ? { communeInsee: null, propertyId: null } : {}),
          status: "active",
          delistedAt: null,
          parseStatus,
          parseError: null,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(portalListings.id, existing.id),
            sql`${portalListings.priceEur} is not distinct from ${existing.priceEur}::bigint`,
            sql`${portalListings.areaM2} is not distinct from ${existing.areaM2}::numeric`,
            sql`${portalListings.rooms} is not distinct from ${existing.rooms}::integer`,
            sql`${portalListings.availability} is not distinct from ${existing.availability}::text`,
            eq(portalListings.status, existing.status),
          ),
        )
        .returning({ id: portalListings.id });
      if (!row) return null;
      listingId = row.id;
    } else {
      // Two passes can reach the same new listing at once. The unique index is
      // the arbiter, and the loser goes back round as an update of the
      // winner's row — whose `listed` event is the only one there should be.
      const [row] = await tx
        .insert(portalListings)
        .values({
          sourceId: deps.sourceId,
          externalId,
          ...incoming,
          status: "active",
          parseStatus,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing({ target: [portalListings.sourceId, portalListings.externalId] })
        .returning({ id: portalListings.id });
      if (!row) return null;
      listingId = row.id;
    }

    if (events.length > 0) {
      await tx.insert(portalListingEvents).values(
        events.map((e) => ({
          listingId,
          /**
           * Filled where it is known, which is every listing that has been
           * clustered at least once.
           *
           * It was omitted here until 2026-08-31, so `delisted` rows carried a
           * property and `listed` and `price_changed` rows carried null — the
           * exact inverse of what the column is for, and enough to make a
           * property-level query over events return nothing for a new listing.
           *
           * Null remains correct and expected for a listing seen for the first
           * time: clustering runs after collection, so nothing knows yet which
           * property this is. Readers must therefore resolve the property through
           * `portal_listings` rather than trusting this column — which is also
           * the right thing to do after a merge reassigns a listing, since this
           * value is a snapshot and the join is the current answer.
           */
          propertyId: existing?.propertyId ?? null,
          sourceId: deps.sourceId,
          runId: deps.runId,
          type: e.type,
          priceFrom: e.priceFrom ?? null,
          priceTo: e.priceTo ?? null,
          payload: e.payload ?? null,
          occurredAt: now,
        })),
      );
    }

    return { listingId, events: events.map((e) => e.type) };
  });
}

/**
 * Mark listings as gone.
 *
 * Called only when discovery completed and the abort guard let the run through.
 * Both of those are guards against exactly this write — nothing else in the
 * pipeline can damage the dataset the way a false delisting can.
 */
export async function delistListings(
  sourceId: string,
  externalIds: string[],
  runId: string | null,
): Promise<number> {
  if (externalIds.length === 0) return 0;

  const now = new Date();
  let count = 0;

  /**
   * ONE STATEMENT: the flip and its event, for a chunk at a time.
   *
   * This was a loop of read, update, insert per listing — three round trips
   * each, and check-then-write: two passes of one source at once both read
   * `active` and both logged `delisted`. Now the update only takes rows that
   * are not delisted yet and the event is written from what it RETURNS, in
   * the same statement, so the second pass finds nothing to flip and logs
   * nothing. The same property makes a retry safe: a chunk whose commit landed
   * but whose answer was lost flips nothing the second time.
   */
  for (let i = 0; i < externalIds.length; i += DELIST_CHUNK) {
    const chunk = externalIds.slice(i, i + DELIST_CHUNK);
    const result = await withDbRetry(() =>
      db.execute(sql`
        with gone as (
          update ${portalListings}
          set status = 'delisted', delisted_at = ${now}, updated_at = ${now}
          where source_id = ${sourceId}::uuid
            and external_id in (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})
            and status <> 'delisted'
          returning id, property_id, price_eur, availability
        )
        insert into ${portalListingEvents}
          (listing_id, property_id, source_id, run_id, type, price_from, payload, occurred_at)
        select id, property_id, ${sourceId}::uuid, ${runId}::uuid, 'delisted', price_eur,
               jsonb_build_object('lastAvailability', availability), ${now}
        from gone
        returning id
      `),
    );
    count += result.rows.length;
  }

  return count;
}

/** Large enough to make a thousand delistings a few statements, small enough for the 10 s statement timeout. */
const DELIST_CHUNK = 500;

async function loadListing(sourceId: string, externalId: string) {
  const [row] = await db
    .select()
    .from(portalListings)
    .where(
      and(eq(portalListings.sourceId, sourceId), eq(portalListings.externalId, externalId)),
    )
    .limit(1);
  return row ?? null;
}

/** Re-export so callers building a RawListing for tests do not reach past this module. */
export type { RawListing };

/**
 * No property in France is worth two billion euros, and no integer column
 * holds much more: Postgres `integer` stops at 2 147 483 647. Both bounds
 * point at the same number, so one constant serves for the plausibility check
 * and the storage check at once.
 */
/**
 * The ceiling, set by the market rather than by what looks obviously absurd.
 *
 * Two billion was the first version, chosen to be impossible rather than to be
 * right. Wide enough to be safe is also wide enough to admit the next accident
 * of the same shape — a price read out of a range, a figure with a phone number
 * glued to it — and the accident then reaches the client's screen sorted to the
 * top, because a list ordered by price descending shows the worst row first.
 *
 * The most expensive property ever sold on this coast is around 200 million;
 * the highest asking price we hold is 85 million. A quarter of a billion is far
 * above anything real here and far below every parsing accident seen so far,
 * which have all been off by six digits or more.
 *
 * A client watching a different market — Monaco, Dubai — turns this into a
 * per-source setting. It stays a constant while every client watches one coast.
 */
const MAX_PRICE_EUR = 250_000_000;
/** Versailles has 2 300 rooms. Anything past a thousand is a parsing accident. */
const MAX_ROOMS = 1_000;

/**
 * A value only when it could be real. Out of range is dropped and said out
 * loud — silence here would trade a crash for a quiet wrong number, which is
 * the worse of the two.
 */
function sane(value: number | null, max: number, field: string, url: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > max) {
    console.warn(`[ingest] ${field}=${value} is impossible — dropped, listing kept: ${url}`);
    return null;
  }
  return value;
}
