import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalListingEvents, portalListings, portalSnapshots } from "@/lib/db/schema";
import { contentHash } from "@/lib/utils/crypto";
import { pageKey, putPage } from "@/lib/s3/pages";
import { resolveAgency } from "../agencies";
import { resolveCommune } from "../communes";
import type { PoliteFetch, PortalAdapter, RawListing } from "../types";
import { computeEvents, mergeParsed, type ListingState } from "./events";

/**
 * One listing, end to end: fetch, store, parse, reconcile, record history.
 *
 * Deliberately not a transaction across all of it. The page lands in S3 before
 * anything tries to understand it, precisely so a parse failure leaves evidence
 * rather than nothing. Rolling that back on a parser bug would throw away the
 * only copy of the thing we need in order to fix the parser.
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
  target: { externalId: string; url: string },
): Promise<IngestOutcome> {
  const { externalId, url } = target;

  // ── 1. Fetch ────────────────────────────────────────────────────────────
  let html: string;
  try {
    html = await deps.fetch(url);
  } catch (err) {
    // A failed fetch is NOT a delisting. The caller decides what a missing page
    // means; here it is only a failure to look.
    return { externalId, status: "fetch_failed", error: (err as Error).message };
  }

  const hash = contentHash(html);

  // ── 2. Skip work the page itself says is unnecessary ────────────────────
  const [lastSnapshot] = await db
    .select({ contentHash: portalSnapshots.contentHash })
    .from(portalSnapshots)
    .where(
      and(
        eq(portalSnapshots.sourceId, deps.sourceId),
        eq(portalSnapshots.externalId, externalId),
      ),
    )
    .orderBy(desc(portalSnapshots.fetchedAt))
    .limit(1);

  const existing = await loadListing(deps.sourceId, externalId);

  if (lastSnapshot?.contentHash === hash && existing) {
    // Byte-identical to what we already parsed. Parsing again cannot produce a
    // different answer, so only the "still here" timestamp moves.
    await db
      .update(portalListings)
      .set({ lastSeenAt: new Date(), status: "active", updatedAt: new Date() })
      .where(eq(portalListings.id, existing.id));
    return { externalId, status: "unchanged", listingId: existing.id };
  }

  // ── 3. Store the page before interpreting it ────────────────────────────
  const s3Key = pageKey(deps.sourceKey, externalId);
  await putPage(s3Key, html);
  await db.insert(portalSnapshots).values({
    sourceId: deps.sourceId,
    runId: deps.runId,
    externalId,
    url,
    s3Key,
    byteSize: Buffer.byteLength(html, "utf8"),
    contentHash: hash,
  });

  // ── 4. Parse ────────────────────────────────────────────────────────────
  const result = deps.adapter.parse(html, url);

  if (result.status === "failed") {
    /**
     * Record the failure against the row and move on. The listing keeps
     * whatever we already knew — a broken parser must not be able to blank a
     * record — and the page is in S3 to re-parse once the adapter is fixed.
     */
    if (existing) {
      await db
        .update(portalListings)
        .set({
          parseStatus: "failed",
          parseError: result.error.slice(0, 500),
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(portalListings.id, existing.id));
    }
    return { externalId, status: "parse_failed", error: result.error };
  }

  const parsed = result.listing;
  const parseStatus = result.status === "partial" ? "partial" : "ok";

  // ── 5. Normalise ────────────────────────────────────────────────────────
  const agencyId = parsed.agencyName
    ? await resolveAgency({
        name: parsed.agencyName,
        address: parsed.agencyAddress,
        postalCode: parsed.agencyPostalCode,
        city: parsed.agencyCity,
        phone: parsed.agencyPhone,
      })
    : null;

  const commune = resolveCommune(
    parsed.communeRaw,
    parsed.postalCode,
    `${parsed.title ?? ""} ${parsed.description ?? ""}`,
  );

  const pricePerM2 =
    parsed.priceEur !== null && parsed.areaM2 !== null && parsed.areaM2 > 0
      ? Math.round(parsed.priceEur / parsed.areaM2)
      : null;

  const incoming = {
    url,
    title: parsed.title,
    description: parsed.description,
    imageUrl: parsed.imageUrl,
    imageUrls: parsed.imageUrls,
    priceEur: parsed.priceEur,
    pricePerM2,
    areaM2: parsed.areaM2 === null ? null : String(parsed.areaM2),
    landM2: parsed.landM2 === null ? null : String(parsed.landM2),
    rooms: parsed.rooms,
    bedrooms: parsed.bedrooms,
    bathrooms: parsed.bathrooms,
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
    raw: parsed.raw,
  };

  // ── 6. Reconcile and record history ─────────────────────────────────────
  const before: ListingState | null = existing
    ? {
        priceEur: existing.priceEur,
        areaM2: existing.areaM2 === null ? null : Number(existing.areaM2),
        rooms: existing.rooms,
        availability: existing.availability,
        status: existing.status === "delisted" ? "delisted" : "active",
      }
    : null;

  const after: ListingState = {
    priceEur: parsed.priceEur,
    areaM2: parsed.areaM2,
    rooms: parsed.rooms,
    availability: parsed.availability,
    status: "active",
  };

  const events = computeEvents(before, after);

  let listingId: string;
  const now = new Date();

  if (existing) {
    /**
     * mergeParsed drops nulls, so a degraded parse can only ever add
     * information. Better a stale number than a hole: a stale number is wrong
     * in a way somebody eventually notices, a hole just quietly shrinks the
     * dataset.
     */
    const patch = mergeParsed(existing as unknown as Record<string, unknown>, incoming);
    await db
      .update(portalListings)
      .set({
        ...patch,
        status: "active",
        delistedAt: null,
        parseStatus,
        parseError: null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(portalListings.id, existing.id));
    listingId = existing.id;
  } else {
    const [created] = await db
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
      // Two passes can reach the same new listing at once. The unique index is
      // the arbiter; the loser updates rather than exploding.
      .onConflictDoUpdate({
        target: [portalListings.sourceId, portalListings.externalId],
        set: { lastSeenAt: now, updatedAt: now },
      })
      .returning({ id: portalListings.id });
    listingId = created.id;
  }

  if (events.length > 0) {
    await db.insert(portalListingEvents).values(
      events.map((e) => ({
        listingId,
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

  return { externalId, status: "ingested", listingId, events: events.map((e) => e.type) };
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

  for (const externalId of externalIds) {
    const existing = await loadListing(sourceId, externalId);
    if (!existing || existing.status === "delisted") continue;

    await db
      .update(portalListings)
      .set({ status: "delisted", delistedAt: now, updatedAt: now })
      .where(eq(portalListings.id, existing.id));

    await db.insert(portalListingEvents).values({
      listingId: existing.id,
      propertyId: existing.propertyId,
      sourceId,
      runId,
      type: "delisted",
      priceFrom: existing.priceEur,
      payload: { lastAvailability: existing.availability },
      occurredAt: now,
    });
    count += 1;
  }

  return count;
}

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
