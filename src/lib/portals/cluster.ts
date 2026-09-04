import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalListings, portalSources, properties } from "@/lib/db/schema";

/**
 * Everything inside one merged property, listing by listing.
 *
 *   npm run cluster -- <property-id>
 *
 * `npm run merges` says which clusters look wrong. This is how you find out
 * whether they are: a cluster of thirty-four is one villa on six portals if the
 * external ids repeat across portals, and thirty-four flats in one building if
 * they do not. That distinction is invisible from a count and obvious from a
 * list, and it decides whether a matching rule stays.
 *
 * Read-only.
 */

async function main(): Promise<void> {
  const id = process.argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
  if (!id) {
    console.error("Usage: npm run cluster -- <property-id>");
    process.exit(1);
  }

  const [p] = await db.select().from(properties).where(eq(properties.id, id)).limit(1);
  if (!p) {
    console.error(`No property ${id}`);
    process.exit(1);
  }

  const rows = await db
    .select({
      source: portalSources.key,
      externalId: portalListings.externalId,
      priceEur: portalListings.priceEur,
      areaM2: portalListings.areaM2,
      landM2: portalListings.landM2,
      rooms: portalListings.rooms,
      bedrooms: portalListings.bedrooms,
      agencyRef: portalListings.agencyRef,
      status: portalListings.status,
      confidence: portalListings.matchConfidence,
      signals: portalListings.matchSignals,
      title: portalListings.title,
      url: portalListings.url,
    })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(eq(portalListings.propertyId, id))
    .orderBy(asc(portalSources.key));

  console.log(`\n${p.title ?? "(untitled)"}`);
  console.log(`${p.priceEur ?? "—"} €  ${p.areaM2 ?? "—"} m²  commune ${p.communeInsee}\n`);

  for (const r of rows) {
    const sig = (r.signals ?? {}) as Record<string, unknown>;
    const why = sig.agencyRefExact
      ? "mandate"
      : sig.structuralOnly
        ? "measurements"
        : `text ${sig.textContainment ?? "?"}`;
    console.log(
      `${r.source.padEnd(14)} ${String(r.priceEur ?? "—").padStart(9)} €  ` +
        `${String(r.areaM2 ?? "—").padStart(7)} m²  ` +
        `land ${String(r.landM2 ?? "—").padStart(6)}  ` +
        `${String(r.rooms ?? "—").padStart(2)}p ${String(r.bedrooms ?? "—").padStart(2)}ch  ` +
        `ref ${(r.agencyRef ?? "—").padEnd(14)} ` +
        `@${r.confidence ?? "—"} via ${why}`,
    );
    console.log(`               ${(r.title ?? "").slice(0, 96)}`);
    console.log(`               ${r.url}`);
  }

  /**
   * The tell. One property on six portals has roughly six listings and its
   * external ids differ between portals but not within one; a building's worth
   * of flats has many ids on the SAME portal, because that portal really is
   * carrying many different homes.
   */
  const perSource = new Map<string, number>();
  for (const r of rows) perSource.set(r.source, (perSource.get(r.source) ?? 0) + 1);
  console.log(
    `\n${rows.length} listings across ${perSource.size} portals — ` +
      [...perSource].map(([k, n]) => `${k} ${n}`).join(", "),
  );
  const worst = Math.max(...perSource.values());
  if (worst > 2) {
    console.log(
      `\nOne portal carries ${worst} of them. A portal lists a given property once;\n` +
        `several entries on one portal usually means several homes — a development,\n` +
        `or one agency's stock re-listed — not one property seen repeatedly.`,
    );
  }
  process.exit(0);
}

void main();
