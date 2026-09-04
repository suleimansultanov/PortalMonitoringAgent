import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalListings, portalSources } from "@/lib/db/schema";
import {
  candidatePairs,
  cluster,
  incoherentAreas,
  incoherentMembers,
  scoreMatch,
  type Candidate,
} from "./matching/score";

/**
 * What would the matcher do, before it is allowed to do it?
 *
 *   npm run dedup:check
 *   npm run dedup:check -- --communes=83101,83119
 *
 * `npm run resolve` rewrites every property row in the market. This runs the
 * exact same scoring over the exact same data and writes nothing — so a change
 * to the matching rules can be measured on the real market first, which is the
 * only place its failure modes actually live.
 *
 * Two numbers matter. How many properties collapse (too few and the rule is
 * useless, too many and it is eating the market), and what the biggest cluster
 * looks like (over-merging shows up there first, and it shows up as a group of
 * listings that do not belong together).
 *
 * Read-only. Reports; changes nothing.
 */

const THRESHOLD = 0.8;

/**
 * One commune at a time, printed as it goes.
 *
 * Scoring is quadratic inside a commune and the whole market takes as long as
 * the nightly clustering does — the better part of an hour. A run that prints
 * nothing until it finishes is indistinguishable from a run that has hung, and
 * the first thing anyone does is kill it. So: a line per commune, and a way to
 * ask for one commune and have an answer in seconds.
 */
const only = process.argv
  .find((a) => a.startsWith("--communes="))
  ?.slice("--communes=".length)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const sourceKeys = new Map<string, string>();

async function main(): Promise<void> {
  for (const s of await db.select({ id: portalSources.id, key: portalSources.key }).from(portalSources)) {
    sourceKeys.set(s.id, s.key);
  }

  const rows = await db
    .select({
      id: portalListings.id,
      sourceId: portalListings.sourceId,
      communeInsee: portalListings.communeInsee,
      priceEur: portalListings.priceEur,
      areaM2: portalListings.areaM2,
      landM2: portalListings.landM2,
      rooms: portalListings.rooms,
      agencyId: portalListings.agencyId,
      agencyRef: portalListings.agencyRef,
      title: portalListings.title,
      description: portalListings.description,
      propertyId: portalListings.propertyId,
    })
    .from(portalListings)
    .where(eq(portalListings.status, "active"));

  const byCommune = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.communeInsee) continue;
    const list = byCommune.get(r.communeInsee);
    if (list) list.push(r);
    else byCommune.set(r.communeInsee, [r]);
  }

  const existing = new Set<string>();
  for (const r of rows) {
    if (!r.propertyId) continue;
    if (only && (!r.communeInsee || !only.includes(r.communeInsee))) continue;
    existing.add(r.propertyId);
  }

  console.log(
    `\nScoring ${only ? only.length : byCommune.size} commune(s). ` +
      `Quadratic inside each — the whole market is the better part of an hour.\n`,
  );

  let listings = 0;
  let clusters = 0;
  let textEdges = 0;
  let structuralEdges = 0;
  let split = 0;
  const samples: string[] = [];
  const big: string[] = [];

  for (const [commune, list] of byCommune) {
    if (only && !only.includes(commune)) continue;
    const startedAt = Date.now();
    const candidates: Candidate[] = list.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      communeInsee: r.communeInsee,
      priceEur: r.priceEur,
      areaM2: r.areaM2 === null ? null : Number(r.areaM2),
      landM2: r.landM2 === null ? null : Number(r.landM2),
      rooms: r.rooms,
      agencyId: r.agencyId,
      agencyRef: r.agencyRef,
      title: r.title,
      description: r.description,
    }));
    const byId = new Map(candidates.map((c) => [c.id, c]));

    const matched: [string, string][] = [];
    for (const [a, b] of candidatePairs(candidates)) {
      const v = scoreMatch(a, b);
      if (!v.same || v.confidence < THRESHOLD) continue;
      matched.push([a.id, b.id]);
      if (v.signals.structuralOnly) {
        structuralEdges++;
        if (samples.length < 10 && a.sourceId !== b.sourceId) {
          samples.push(
            `  ${commune} @${v.confidence}\n` +
              `    A ${describe(a)}\n` +
              `    B ${describe(b)}`,
          );
        }
      } else {
        textEdges++;
      }
    }

    const assigned = cluster(
      candidates.map((c) => c.id),
      matched,
    );
    const sizes = new Map<string, string[]>();
    for (const [id, root] of assigned) {
      const members = sizes.get(root);
      if (members) members.push(id);
      else sizes.set(root, [id]);
    }

    /**
     * The same coherence guards `resolve` applies, or this reports a number the
     * real run will never produce. Measuring a pipeline without the half that
     * corrects it is worse than not measuring: it reads as evidence.
     */
    for (const [root, ids] of [...sizes]) {
      if (ids.length < 2) continue;
      const m = ids.map((id) => byId.get(id)!);
      const out = new Set([
        ...incoherentMembers(m.map((x) => ({ id: x.id, priceEur: x.priceEur }))),
        ...incoherentAreas(m.map((x) => ({ id: x.id, areaM2: x.areaM2 }))),
      ]);
      if (out.size === 0) continue;
      sizes.set(
        root,
        ids.filter((id) => !out.has(id)),
      );
      for (const id of out) sizes.set(id, [id]);
      split += out.size;
    }

    listings += candidates.length;
    clusters += sizes.size;

    const before = new Set(list.map((r) => r.propertyId).filter(Boolean)).size;
    console.log(
      `  ${commune}  ${String(candidates.length).padStart(5)} listings  ` +
        `${String(before).padStart(5)} → ${String(sizes.size).padStart(5)} properties  ` +
        `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
    );

    for (const members of sizes.values()) {
      if (members.length < 6) continue;
      const m = members.map((id) => byId.get(id)!);
      const prices = m.map((x) => x.priceEur).filter((p): p is number => p !== null);
      const span =
        prices.length > 1
          ? (Math.max(...prices) - Math.min(...prices)) / Math.max(...prices)
          : 0;
      big.push(
        `  ${commune}: ${members.length} listings, price span ${(span * 100).toFixed(0)}% — ` +
          m.slice(0, 6).map((x) => `${sourceKeys.get(x.sourceId) ?? "?"}/${x.priceEur}€/${x.areaM2}m²`).join(" | "),
      );
    }
  }

  console.log("\nPER COMMUNE — done above. TOTALS:");
  console.log("\nNOW");
  console.log(`  active listings   ${listings}`);
  console.log(`  properties        ${existing.size}`);
  console.log("\nIF RESOLVE RAN NOW");
  console.log(`  properties        ${clusters}   (${existing.size - clusters} fewer)`);
  console.log(`  edges: text ${textEdges}, measurements only ${structuralEdges}`);
  console.log(`  listings split back out by the coherence guards: ${split}`);
  console.log("\nMEASUREMENT-ONLY MERGES — SPOT CHECK THESE");
  console.log(samples.join("\n") || "  none");
  if (big.length) {
    console.log("\nCLUSTERS OF SIX OR MORE — where over-merging shows up first");
    console.log(big.slice(0, 15).join("\n"));
  }
  console.log();
  process.exit(0);
}

function describe(c: Candidate): string {
  return (
    `${(sourceKeys.get(c.sourceId) ?? c.sourceId).padEnd(14)} ${c.priceEur}€ ${c.areaM2}m² ` +
    `land ${c.landM2 ?? "-"} rooms ${c.rooms ?? "-"} :: ${(c.title ?? "").slice(0, 60)}`
  );
}

void main();
