import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalListings, portalSnapshots, portalSources } from "@/lib/db/schema";
import { getPage, storageDescription } from "@/lib/s3/pages";
import { getAdapter } from "./registry";
import { resolveAgency } from "./agencies";
import { resolveCommune } from "./communes";
import { resolveCommuneIdentities } from "./matching/resolve";

/**
 * Re-run the parsers over pages already on disk. NO NETWORK.
 *
 *   npm run reparse
 *   npm run reparse -- --source=green-acres
 *   npm run reparse -- --dry
 *
 * WHY THIS EXISTS
 *
 * A Green-Acres listing page is 815 kB. One commune is 127 MB; the whole gulf
 * is about a gigabyte. So every parser fix cannot mean re-downloading the
 * market — and on a metered connection it cannot mean downloading anything at
 * all.
 *
 * The collector already keeps every page it fetched, precisely so fields can be
 * re-derived without asking the portal again. This is the command that uses
 * that. It is also the polite option: the portals gave us permission on the
 * understanding we would be reasonable, and re-fetching a thousand unchanged
 * pages because of our own bug is not reasonable.
 *
 * WHAT IT DOES NOT DO
 *
 * It cannot recover a field the saved page does not contain, and it cannot see
 * a listing that was never fetched. It re-derives; it does not discover.
 */

type Args = { source?: string; dry: boolean };

function parseArgs(): Args {
  const get = (n: string) =>
    process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
  return { source: get("source"), dry: process.argv.includes("--dry") };
}

/**
 * Find the saved page for a listing.
 *
 * ASK THE DATABASE WHERE IT IS. Do not reconstruct the path.
 *
 * This used to scan `.pages/` for a file whose name it rebuilt from the
 * external id, and it was wrong twice over.
 *
 * It only ever looked at local disk, so the day pages moved to object storage
 * — which is the day the collector left this laptop — re-parsing would have
 * quietly found nothing for everything collected since, while still working
 * perfectly for the older files sitting next to it. A backfill would not have
 * fixed that; this function never looked in the bucket at all.
 *
 * And the name it rebuilt was not the name that was written. `pageKey` encodes
 * the id with `encodeURIComponent`; this replaced everything outside
 * `[a-zA-Z0-9._-]` with an underscore. For an id carrying a slash or a query
 * character — which `pages.ts` explicitly warns portals do put in them — the
 * two disagree, the file is not found, and the listing is skipped as though no
 * page had ever been saved. Silent, and worst on exactly the ids nobody
 * inspects.
 *
 * `portal_snapshots` has recorded the exact key of every stored page since the
 * first pass, with the time it was fetched. Reading it removes both bugs and
 * the guessing along with them: newest row, its key, through the same storage
 * layer the collector wrote it with — local disk or bucket, whichever is
 * configured.
 */
async function findPage(sourceId: string, externalId: string): Promise<string | null> {
  const [snapshot] = await db
    .select({ s3Key: portalSnapshots.s3Key })
    .from(portalSnapshots)
    .where(
      and(
        eq(portalSnapshots.sourceId, sourceId),
        eq(portalSnapshots.externalId, externalId),
      ),
    )
    // A listing fetched more than once should be re-parsed from the most recent
    // capture, not the first one we happened to store.
    .orderBy(desc(portalSnapshots.fetchedAt))
    .limit(1);

  if (!snapshot) return null;

  try {
    return await getPage(snapshot.s3Key);
  } catch (err) {
    /**
     * A recorded key whose object is gone. Reported rather than swallowed: it
     * means the two sides have drifted — a bucket lifecycle rule deleted it, or
     * the page was written to a laptop and the row synced to a database the
     * bucket does not match. "No page saved" and "the page we saved is missing"
     * need different answers, and only one of them is normal.
     */
    console.warn(`   ⚠ ${externalId}: ${snapshot.s3Key} is recorded but unreadable — ${(err as Error).message}`);
    return null;
  }
}

export async function reparse(args: Args): Promise<void> {
  const sources = await db.select().from(portalSources);
  const wanted = args.source ? sources.filter((s) => s.key === args.source) : sources;

  if (wanted.length === 0) {
    console.error(`No source "${args.source}". Known: ${sources.map((s) => s.key).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nRe-parsing from ${storageDescription()} — no network, no traffic.`);
  if (args.dry) console.log(`dry run: nothing will be written\n`);

  const touchedCommunes = new Set<string>();
  let totalUpdated = 0;

  for (const source of wanted) {
    let adapter;
    try {
      adapter = getAdapter(source.key);
    } catch {
      continue; // A source with no adapter written yet.
    }

    const rows = await db
      .select({
        id: portalListings.id,
        externalId: portalListings.externalId,
        url: portalListings.url,
      })
      .from(portalListings)
      .where(eq(portalListings.sourceId, source.id));

    if (rows.length === 0) continue;

    let updated = 0;
    let missing = 0;
    let failed = 0;
    const changes = new Map<string, number>();

    for (const row of rows) {
      const html = await findPage(source.id, row.externalId);
      if (!html) {
        missing++;
        continue;
      }

      const result = adapter.parse(html, row.url);
      if (result.status === "failed") {
        failed++;
        continue;
      }

      const p = result.listing;
      const commune = resolveCommune(p.communeRaw, p.postalCode, `${p.title ?? ""} ${p.description ?? ""}`);
      if (commune) touchedCommunes.add(commune.insee);

      /**
       * Only non-null values are written.
       *
       * A re-parse must never turn a field we already have into a null: the
       * saved page may be an older capture than the row, and "the parser found
       * nothing this time" is not evidence that the property has no price.
       * Same rule as `mergeParsed` in the ingest path.
       */
      const patch: Record<string, unknown> = {};
      const consider = <K extends string>(key: K, value: unknown) => {
        if (value === null || value === undefined) return;
        patch[key] = value;
        changes.set(key, (changes.get(key) ?? 0) + 1);
      };

      consider("title", p.title);
      consider("description", p.description);
      consider("imageUrl", p.imageUrl);
      // An empty gallery is not evidence of no gallery — same rule as every
      // other field here, so only a non-empty array overwrites.
      if (p.imageUrls.length > 0) consider("imageUrls", p.imageUrls);
      consider("priceEur", p.priceEur);
      consider("areaM2", p.areaM2 === null ? null : String(p.areaM2));
      consider("landM2", p.landM2 === null ? null : String(p.landM2));
      consider("rooms", p.rooms);
      consider("bedrooms", p.bedrooms);
      consider("bathrooms", p.bathrooms);
      consider("propertyType", p.propertyType);
      consider("agencyRef", p.agencyRef);

      /**
       * Re-resolve the AGENCY, not just the reference.
       *
       * The first version of this command missed it, and the symptom was
       * unmistakable: the fix that strips "Contacter l'agent " off a name
       * landed in the parser, the re-parse reported success, and the screen
       * still said "Contacter l'agent ARNAUD VIALLANEIX". The listing rows had
       * been updated; the agency they pointed at had not.
       *
       * Worth stating why that is easy to miss — agency is the one field on a
       * listing that is a foreign key rather than a value, so "re-parse the
       * fields" quietly means "re-parse everything except this".
       */
      if (p.agencyName) {
        const agencyId = await resolveAgency({
          name: p.agencyName,
          address: p.agencyAddress,
          postalCode: p.agencyPostalCode,
          city: p.agencyCity,
          phone: p.agencyPhone,
        });
        consider("agencyId", agencyId);
      }
      consider("communeRaw", p.communeRaw);
      consider("postalCode", p.postalCode);
      consider("publishedAt", p.publishedAt);
      consider("sourceUpdatedAt", p.sourceUpdatedAt);
      consider("raw", p.raw);
      if (commune) consider("communeInsee", commune.insee);

      if (Object.keys(patch).length === 0) continue;

      if (!args.dry) {
        patch.updatedAt = new Date();
        await db.update(portalListings).set(patch).where(eq(portalListings.id, row.id));
      }
      updated++;
    }

    totalUpdated += updated;
    console.log(`  ${source.key.padEnd(14)} ${updated} updated, ${missing} pages not on disk, ${failed} unparseable`);
    const top = [...changes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (top.length > 0) {
      console.log(`    fields written: ${top.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
  }

  /**
   * Re-resolve afterwards. Parsing changes the fields deduplication compares
   * — an agency name that was null and is now known can merge two rows that
   * previously could not be connected — so leaving properties untouched would
   * report a fix that had not fully landed.
   */
  if (!args.dry && totalUpdated > 0) {
    console.log(`\n── re-running deduplication ──`);
    for (const insee of touchedCommunes) {
      const r = await resolveCommuneIdentities(insee);
      console.log(`   ${insee}: ${r.listings} listings → ${r.properties} properties (${r.merged} merged)`);
    }
  }

  console.log(
    `\n${totalUpdated} listings re-derived from saved pages. Nothing was downloaded.\n`,
  );
}

if (process.argv[1]?.endsWith("reparse.ts")) {
  reparse(parseArgs())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[reparse] failed:", (err as Error).message);
      process.exit(1);
    });
}
