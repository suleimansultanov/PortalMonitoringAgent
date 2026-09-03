import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  portalListings,
  portalListingEvents,
  portalSources,
  properties,
} from "@/lib/db/schema";
import { storageDescription } from "@/lib/s3/pages";
import {
  collectionCommunes,
  communesForSource,
  runSource,
  stalestCommunes,
} from "./runner/run";
import { resolveCommuneIdentities } from "./matching/resolve";
import { listAdapters } from "./registry";

/**
 * Collect from the terminal, without Inngest or Vercel.
 *
 *   npm run collect -- --source=smc --limit=20
 *   npm run collect -- --source=all
 *
 * The point of this existing separately from the scheduled path: the first run
 * against a live portal is where the surprises are, and you want to watch it
 * happen rather than read about it in a log an hour later. It also sidesteps
 * the platform's function timeout, which a full first crawl would otherwise
 * exceed.
 */

type Args = {
  source: string;
  limit?: number;
  communes?: string[];
  /** Take the N communes this source has gone longest without collecting. */
  stale?: number;
  skipResolve: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

  const limitRaw = get("limit");
  const communesRaw = get("communes");
  const staleRaw = get("stale");

  return {
    source: get("source") ?? "all",
    limit: limitRaw ? Number(limitRaw) : undefined,
    communes: communesRaw ? communesRaw.split(",").map((c) => c.trim()) : undefined,
    stale: staleRaw ? Number(staleRaw) : undefined,
    skipResolve: argv.includes("--skip-resolve"),
  };
}

export async function collect(args: Args): Promise<void> {
  const sources = await db.select().from(portalSources);
  const targets =
    args.source === "all" ? sources : sources.filter((s) => s.key === args.source);

  if (targets.length === 0) {
    console.error(
      `No source "${args.source}". Seeded: ${sources.map((s) => s.key).join(", ") || "(none — run npm run db:seed)"}`,
    );
    process.exit(1);
  }

  console.log(`\nstorage: ${storageDescription()}`);
  console.log(`adapters registered: ${listAdapters().map((a) => a.key).join(", ")}`);
  if (args.limit) {
    console.log(`limit: ${args.limit} listings per source — this is a smoke test, not a crawl`);
  }

  for (const source of targets) {
    /**
     * Explicit list wins; then `--stale=N`; then everything subscribed.
     *
     * `--stale` is what makes a week-long backfill runnable as the SAME command
     * every night — see stalestCommunes(). Slow portals need it; fast ones can
     * take the whole list in one go.
     */
    const communes =
      args.communes ??
      (args.stale ? await stalestCommunes(source.id, args.stale) : await communesForSource(source.id));
    if (communes.length === 0) {
      console.log(`\n${source.key}: no client subscribes to it — skipping`);
      continue;
    }

    console.log(
      `\n── ${source.key} ── ${communes.length} communes` +
        (args.stale ? ` (the ${communes.length} least recently collected)` : ""),
    );
    if (!source.enabled) {
      // Run anyway when asked directly. The enabled flag guards the scheduler,
      // not a human who typed the command.
      console.log(`   (source is disabled — running because you asked for it)`);
    }

    const started = Date.now();
    const summary = await runSource({
      sourceKey: source.key,
      communeInsee: communes,
      mode: args.limit ? "manual" : "backfill",
      limit: args.limit,
      // Named on the command line means run it. The flag guards the scheduler.
      force: true,
    });
    const seconds = Math.round((Date.now() - started) / 1000);

    /**
     * `stored` before `new`, and both printed.
     *
     * `new` is what discovery decided to go and fetch; `stored` is what
     * actually landed. On a clean pass they match. On a curtailed one they do
     * not, and printing only the first turned a LuxuryEstate pass that stored
     * about a hundred listings into a line reading "new 1845" — a run that
     * stopped early reporting as a run that finished.
     */
    console.log(
      `   ${summary.status} in ${seconds}s — discovered ${summary.discovered}, ` +
        `stored ${summary.ingested} of ${summary.added} new, ` +
        `refreshed ${summary.refreshed}, delisted ${summary.delisted}, ` +
        `failed ${summary.failed}`,
    );
    if (summary.fetchStoppedEarly) {
      console.log(`   ⚠ fetching stopped early: ${summary.fetchStoppedEarly}`);
      console.log(`     the rest are untouched — re-run to pick them up`);
    }
    if (summary.abortedReason) console.log(`   aborted: ${summary.abortedReason}`);

    if (summary.failureSamples?.length) {
      console.log(`\n   why they failed:`);
      for (const f of summary.failureSamples) {
        console.log(`     ${f.error}`);
        console.log(`       ${f.url}`);
      }
    }
  }

  if (!args.skipResolve) {
    console.log(`\n── deduplication ──`);
    for (const insee of args.communes ?? (await collectionCommunes())) {
      const r = await resolveCommuneIdentities(insee);
      if (r.listings === 0) continue;
      console.log(
        `   ${insee}: ${r.listings} listings → ${r.properties} properties (${r.merged} merged)`,
      );
    }
  }

  await summarise();
}

/**
 * What actually landed.
 *
 * Null rates matter more than counts here. A run that "succeeded" while
 * returning nulls for two thirds of its prices has not succeeded — and that is
 * exactly what a partially broken parser looks like from the outside.
 */
async function summarise(): Promise<void> {
  /**
   * COUNTED IN THE DATABASE, NOT IN NODE.
   *
   * This used to be three `select *` — every listing, every property, every
   * event — pulled across the wire and tallied in JavaScript. Against a local
   * Postgres that was instant and nobody noticed. Against Supabase it drags
   * eleven thousand rows, including every description and every `raw` blob,
   * through a 10-second query timeout and dies:
   *
   *   collect failed: DrizzleQueryError … Error: Query read timeout
   *
   * The collection had already succeeded. Only the report at the end failed —
   * and it failed loudly enough, with a stack trace and a non-zero exit, to
   * look exactly like a failed crawl. A summary that reports a good run as a
   * broken one is worse than no summary.
   *
   * Postgres counts rows for a living. Nothing here needs a single row in Node.
   */
  const [totals] = await db
    .select({
      listings: sql<number>`count(*)::int`,
      noPrice: sql<number>`count(*) filter (where ${portalListings.priceEur} is null)::int`,
      noArea: sql<number>`count(*) filter (where ${portalListings.areaM2} is null)::int`,
      noRooms: sql<number>`count(*) filter (where ${portalListings.rooms} is null)::int`,
      noAgency: sql<number>`count(*) filter (where ${portalListings.agencyId} is null)::int`,
      noAgencyRef: sql<number>`count(*) filter (where ${portalListings.agencyRef} is null)::int`,
      noCommune: sql<number>`count(*) filter (where ${portalListings.communeInsee} is null)::int`,
      parseFailed: sql<number>`count(*) filter (where ${portalListings.parseStatus} = 'failed')::int`,
      parsePartial: sql<number>`count(*) filter (where ${portalListings.parseStatus} = 'partial')::int`,
    })
    .from(portalListings);

  const [propTotals] = await db
    .select({
      properties: sql<number>`count(*)::int`,
      multiSource: sql<number>`count(*) filter (where ${properties.sourceCount} > 1)::int`,
    })
    .from(properties);

  const [{ events }] = await db
    .select({ events: sql<number>`count(*)::int` })
    .from(portalListingEvents);

  console.log(`\n── what landed ──`);
  console.log(`   listings   ${totals.listings}`);
  console.log(`   properties ${propTotals.properties}`);
  console.log(`   events     ${events}`);

  if (totals.listings === 0) return;

  /**
   * Null rates matter more than counts. A run that "succeeded" while returning
   * nulls for two thirds of its prices has not succeeded — and that is exactly
   * what a partially broken parser looks like from the outside.
   */
  const pct = (n: number) => Math.round((n / totals.listings) * 100);

  console.log(`\n── missing fields (%) ──`);
  for (const [label, missing] of [
    ["price", totals.noPrice],
    ["area", totals.noArea],
    ["rooms", totals.noRooms],
    ["agency", totals.noAgency],
    ["agency ref", totals.noAgencyRef],
    ["commune", totals.noCommune],
  ] as const) {
    const p = pct(missing);
    console.log(`   ${label.padEnd(11)} ${String(p).padStart(3)}%${p > 30 ? "  ← look at this" : ""}`);
  }

  if (totals.parseFailed || totals.parsePartial) {
    console.log(`\n   parse: ${totals.parseFailed} failed, ${totals.parsePartial} partial`);
  }

  if (propTotals.multiSource > 0) {
    console.log(`\n── deduplication ──`);
    console.log(`   ${propTotals.multiSource} properties seen on more than one portal`);

    const examples = await db
      .select({ title: properties.title, sourceCount: properties.sourceCount })
      .from(properties)
      .where(sql`${properties.sourceCount} > 1`)
      .orderBy(desc(properties.sourceCount))
      .limit(5);
    for (const p of examples) {
      console.log(`   × ${p.sourceCount}  ${(p.title ?? "").slice(0, 60)}`);
    }
  }

  console.log(
    `\nSpot-check a few against the live pages before trusting any of it.\n` +
      `Wrong-but-plausible is the failure mode that survives longest.\n`,
  );
}

if (process.argv[1]?.endsWith("cli.ts")) {
  collect(parseArgs(process.argv))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\ncollect failed:", err);
      process.exit(1);
    });
}

export { eq, portalSources };

