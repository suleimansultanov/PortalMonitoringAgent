import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalListings, properties } from "@/lib/db/schema";
import { getNumberSetting, SETTING_KEYS } from "@/lib/settings/store";
import {
  candidatePairs,
  cluster,
  incoherentMembers,
  scoreMatch,
  type Candidate,
  type MatchSignals,
} from "./score";

/**
 * Turning listings into properties.
 *
 * Runs after collection, over one commune at a time. Clustering is global
 * within a commune rather than incremental per new listing, because a new
 * arrival can reveal that two properties we thought were separate are one — the
 * third portal is often the one carrying the mandate reference that ties the
 * first two together.
 *
 * The cost of that choice is honest: this is O(n²) inside a commune. At Gulf of
 * Saint-Tropez volumes — hundreds per commune, not tens of thousands — that is
 * a few hundred thousand comparisons, seconds of work. If a client ever brings
 * a market where a commune holds five figures, this needs MinHash banding
 * instead of pairwise scoring. Better a clear limit than a clever one nobody
 * can reason about.
 */

const DEFAULT_MATCH_THRESHOLD = 0.8;

export type ResolveSummary = {
  communeInsee: string;
  listings: number;
  properties: number;
  merged: number;
};

export async function resolveCommuneIdentities(communeInsee: string): Promise<ResolveSummary> {
  const threshold = await getNumberSetting(
    SETTING_KEYS.MATCH_THRESHOLD,
    DEFAULT_MATCH_THRESHOLD,
  );

  const rows = await db
    .select({
      id: portalListings.id,
      sourceId: portalListings.sourceId,
      communeInsee: portalListings.communeInsee,
      priceEur: portalListings.priceEur,
      areaM2: portalListings.areaM2,
      rooms: portalListings.rooms,
      bedrooms: portalListings.bedrooms,
      agencyId: portalListings.agencyId,
      agencyRef: portalListings.agencyRef,
      title: portalListings.title,
      description: portalListings.description,
      imageUrl: portalListings.imageUrl,
      imageUrls: portalListings.imageUrls,
      propertyId: portalListings.propertyId,
      propertyType: portalListings.propertyType,
      landM2: portalListings.landM2,
      firstSeenAt: portalListings.firstSeenAt,
      lastSeenAt: portalListings.lastSeenAt,
    })
    .from(portalListings)
    .where(
      and(
        eq(portalListings.communeInsee, communeInsee),
        eq(portalListings.status, "active"),
      ),
    );

  if (rows.length === 0) {
    return { communeInsee, listings: 0, properties: 0, merged: 0 };
  }

  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
    sourceId: r.sourceId,
    communeInsee: r.communeInsee,
    priceEur: r.priceEur,
    areaM2: r.areaM2 === null ? null : Number(r.areaM2),
    rooms: r.rooms,
    agencyId: r.agencyId,
    agencyRef: r.agencyRef,
    title: r.title,
    description: r.description,
  }));

  // ── Score ───────────────────────────────────────────────────────────────
  const matched: [string, string][] = [];
  const bestSignals = new Map<string, { confidence: number; signals: MatchSignals }>();

  for (const [a, b] of candidatePairs(candidates)) {
    const verdict = scoreMatch(a, b);
    if (!verdict.same || verdict.confidence < threshold) continue;

    matched.push([a.id, b.id]);

    /**
     * Keep the strongest evidence per listing, not the last. A listing that
     * matched three others should carry the reason that is easiest to defend —
     * which is almost always the exact mandate reference, if one fired.
     */
    for (const id of [a.id, b.id]) {
      const prev = bestSignals.get(id);
      if (!prev || verdict.confidence > prev.confidence) {
        bestSignals.set(id, { confidence: verdict.confidence, signals: verdict.signals });
      }
    }
  }

  const clusters = cluster(
    candidates.map((c) => c.id),
    matched,
  );

  // ── Group ───────────────────────────────────────────────────────────────
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = clusters.get(row.id) ?? row.id;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  /**
   * Break apart clusters that are not internally plausible.
   *
   * Union-find is transitive, so one wrong edge welds two blobs together and
   * every further wrong edge doubles the damage. This ran for real: a single
   * "property" in Sainte-Maxime held 47 listings priced from €739k to €7.8M,
   * chained through dozens of accidental text matches.
   *
   * The pair rules have been tightened, but a check on the RESULT is a
   * different kind of guard — it does not depend on getting the scoring right,
   * which is exactly why it is worth having.
   */
  let evicted = 0;
  for (const [key, group] of [...groups]) {
    if (group.length < 2) continue;
    const outliers = incoherentMembers(
      group.map((g) => ({ id: g.id, priceEur: g.priceEur })),
    );
    if (outliers.length === 0) continue;

    const keep = group.filter((g) => !outliers.includes(g.id));
    groups.set(key, keep);
    // Each evicted listing becomes a property of its own. Wrongly separating
    // two listings is a duplicate on a screen; wrongly merging them hides a
    // property from the client entirely.
    for (const row of group.filter((g) => outliers.includes(g.id))) {
      groups.set(row.id, [row]);
      evicted += 1;
    }
  }
  if (evicted > 0) {
    console.warn(
      `[resolve] ${communeInsee}: ${evicted} listing(s) split out of incoherent clusters ` +
        `(price spread too wide to be one property)`,
    );
  }

  let merged = 0;

  for (const [, group] of groups) {
    if (group.length > 1) merged += group.length - 1;

    /**
     * Reuse an existing property rather than creating a new one on every pass.
     * Without this, a nightly re-resolve would orphan yesterday's property rows
     * and every id the client app had bookmarked would go stale.
     */
    const existingId = group.find((g) => g.propertyId)?.propertyId ?? null;
    const best = pickRepresentative(group);

    const values = {
      title: best.title,
      description: best.description,
      priceEur: best.priceEur,
      areaM2: best.areaM2,
      landM2: best.landM2,
      rooms: best.rooms,
      /**
       * Bedrooms were missing from this list, so every property in the product
       * showed "—" for beds however well the adapters had parsed them. The
       * listing rows were right; the copy into `properties` simply forgot the
       * column, and nothing downstream could tell that apart from a portal that
       * does not publish bedroom counts.
       */
      bedrooms: best.bedrooms,
      /**
       * Prefer a photo from ANY listing in the group over the representative's.
       * The representative is chosen for completeness of fields, and the portal
       * with the best data is not always the one with a picture.
       */
      imageUrl: best.imageUrl ?? group.find((g) => g.imageUrl)?.imageUrl ?? null,
      /** The richest gallery among the merged listings, not the first one found. */
      imageUrls: group.reduce<string[]>(
        (best_, g) => (g.imageUrls.length > best_.length ? g.imageUrls : best_),
        [],
      ),
      propertyType: best.propertyType,
      communeInsee,
      agencyId: best.agencyId,
      agencyRef: best.agencyRef,
      sourceCount: new Set(group.map((g) => g.sourceId)).size,
      status: "active" as const,
      firstListedAt: group.reduce<Date>(
        (min, g) => (g.firstSeenAt < min ? g.firstSeenAt : min),
        group[0].firstSeenAt,
      ),
      lastSeenAt: group.reduce<Date>(
        (max, g) => (g.lastSeenAt > max ? g.lastSeenAt : max),
        group[0].lastSeenAt,
      ),
      updatedAt: new Date(),
    };

    let propertyId: string;
    if (existingId) {
      await db.update(properties).set(values).where(eq(properties.id, existingId));
      propertyId = existingId;
    } else {
      const [created] = await db.insert(properties).values(values).returning({ id: properties.id });
      propertyId = created.id;
    }

    for (const row of group) {
      const evidence = bestSignals.get(row.id);
      await db
        .update(portalListings)
        .set({
          propertyId,
          // A single-listing group has nothing to be confident about — it is a
          // property by default, not by evidence. Recording 1.0 there would
          // make "confidence" meaningless the moment anyone filtered on it.
          matchConfidence: group.length > 1 ? String(evidence?.confidence ?? 1) : null,
          matchSignals: group.length > 1 ? (evidence?.signals ?? {}) : null,
          updatedAt: new Date(),
        })
        .where(eq(portalListings.id, row.id));
    }
  }

  return {
    communeInsee,
    listings: rows.length,
    properties: groups.size,
    merged,
  };
}

/**
 * Which listing speaks for the property.
 *
 * Completeness first, then recency. Portals truncate differently and some omit
 * area entirely, so the fullest record is the one worth showing — not the one
 * that happened to be crawled last.
 */
function pickRepresentative<T extends { priceEur: number | null; areaM2: unknown; description: string | null; agencyRef: string | null; lastSeenAt: Date }>(
  group: T[],
): T {
  return [...group].sort((a, b) => score(b) - score(a) || +b.lastSeenAt - +a.lastSeenAt)[0];

  function score(x: T): number {
    let s = 0;
    if (x.priceEur !== null) s += 3;
    if (x.areaM2 !== null) s += 2;
    if (x.agencyRef) s += 2;
    s += Math.min((x.description?.length ?? 0) / 500, 2);
    return s;
  }
}

/** Communes with active listings — what a post-collection resolve should walk. */
export async function communesWithListings(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ communeInsee: portalListings.communeInsee })
    .from(portalListings)
    .where(
      and(eq(portalListings.status, "active"), isNotNull(portalListings.communeInsee)),
    );
  return rows.map((r) => r.communeInsee).filter((c): c is string => c !== null);
}
