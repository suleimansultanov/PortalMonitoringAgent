import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  portalListings,
  portalListingEvents,
  portalSources,
  properties,
} from "@/lib/db/schema";
import { storageDescription } from "@/lib/s3/pages";
import { COLLECTION_INSEE } from "./communes";
import { communesForSource, runSource, stalestCommunes } from "./runner/run";
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

    console.log(
      `   ${summary.status} in ${seconds}s — discovered ${summary.discovered}, ` +
        `new ${summary.added}, refreshed ${summary.refreshed}, ` +
        `delisted ${summary.delisted}, failed ${summary.failed}`,
    );
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
    for (const insee of args.communes ?? COLLECTION_INSEE) {
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
  const listings = await db.select().from(portalListings);
  const props = await db.select().from(properties);
  const events = await db.select().from(portalListingEvents);

  console.log(`\n── what landed ──`);
  console.log(`   listings   ${listings.length}`);
  console.log(`   properties ${props.length}`);
  console.log(`   events     ${events.length}`);

  if (listings.length === 0) return;

  const nulls = (pick: (l: (typeof listings)[number]) => unknown) =>
    Math.round((listings.filter((l) => pick(l) === null).length / listings.length) * 100);

  console.log(`\n── missing fields (%) ──`);
  for (const [label, pick] of [
    ["price", (l: (typeof listings)[number]) => l.priceEur],
    ["area", (l: (typeof listings)[number]) => l.areaM2],
    ["rooms", (l: (typeof listings)[number]) => l.rooms],
    ["agency", (l: (typeof listings)[number]) => l.agencyId],
    ["agency ref", (l: (typeof listings)[number]) => l.agencyRef],
    ["commune", (l: (typeof listings)[number]) => l.communeInsee],
  ] as const) {
    const pct = nulls(pick);
    console.log(`   ${String(label).padEnd(11)} ${String(pct).padStart(3)}%${pct > 30 ? "  ← look at this" : ""}`);
  }

  const failed = listings.filter((l) => l.parseStatus === "failed").length;
  const partial = listings.filter((l) => l.parseStatus === "partial").length;
  if (failed || partial) {
    console.log(`\n   parse: ${failed} failed, ${partial} partial`);
  }

  const multi = props.filter((p) => p.sourceCount > 1);
  if (multi.length > 0) {
    console.log(`\n── deduplication ──`);
    console.log(`   ${multi.length} properties seen on more than one portal`);
    for (const p of multi.slice(0, 5)) {
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

