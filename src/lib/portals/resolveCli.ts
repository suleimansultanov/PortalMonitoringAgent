import { COLLECTION_INSEE } from "./communes";
import { resolveCommuneIdentities } from "./matching/resolve";

/**
 * Deduplication on its own, without collecting anything.
 *
 *   npm run resolve
 *   npm run resolve -- --communes=83068,83115
 *
 * Exists so that two collectors can run at the same time.
 *
 * Collection parallelises safely — different portals, different hosts,
 * different `source_id`, and Postgres is perfectly happy with concurrent
 * inserts. Deduplication does not: it rewrites which property each listing
 * belongs to, ACROSS every source, one commune at a time. Two passes doing that
 * to the same commune simultaneously would each be deciding what is already
 * claimed from a view the other is busy invalidating — which is the exact
 * family of bug that took a day to find and fix on 28 and 29 August.
 *
 * So the pattern is: collect in parallel with `--skip-resolve`, then run this
 * once, alone, when they have all finished.
 *
 * Safe to re-run: deduplication is derived from the listings table and
 * recomputed from scratch each time, never accumulated.
 */

const communesArg = process.argv
  .find((a) => a.startsWith("--communes="))
  ?.split("=")
  .slice(1)
  .join("=");

async function main(): Promise<void> {
  const communes = communesArg
    ? communesArg.split(",").map((c) => c.trim()).filter(Boolean)
    : COLLECTION_INSEE;

  console.log(`\n── deduplication ── ${communes.length} communes\n`);

  let listings = 0;
  let properties = 0;
  let merged = 0;

  for (const insee of communes) {
    const r = await resolveCommuneIdentities(insee);
    if (r.listings === 0) continue;
    listings += r.listings;
    properties += r.properties;
    merged += r.merged;
    console.log(
      `   ${insee}: ${r.listings} listings → ${r.properties} properties (${r.merged} merged)`,
    );
  }

  console.log(
    `\n   ${listings} listings → ${properties} properties, ${merged} merged\n` +
      `   Run 'npm run merges' to check the merges are honest before trusting them.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
