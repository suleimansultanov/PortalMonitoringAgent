import { pathToFileURL } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalAgencies, portalListings, portalSources, properties } from "@/lib/db/schema";
import { servedProperty } from "@/lib/api/served";
import { getNumberSetting, SETTING_KEYS } from "@/lib/settings/store";
import {
  candidatePairs,
  clusterCandidates,
  incoherentAreas,
  incoherentMembers,
  scoreMatch,
  type Candidate,
  type MatchSignals,
} from "./matching/score";

/**
 * Duplicates left after deduplication, measured with the rules themselves.
 *
 *   npm run dedup:audit                       every commune the clients watch
 *   npm run dedup:audit -- --communes=83048   one, with every pair listed
 *
 * Runs after the nightly resolve too, as a line in the summary. Read-only:
 * it reports and never merges, because a merge that is wrong hides a property
 * from the client entirely while a split only shows one twice — the asymmetry
 * the whole matcher is built around, and the reason a person looks first.
 *
 * THREE QUESTIONS:
 *
 *   TWINS. Every active property the client is served is scored against every
 *   other in its commune exactly as two listings would be — `candidatePairs`
 *   and `scoreMatch`, the resolve's own threshold. A pair the rules call one
 *   house is a duplicate on the client's screen by our own definition. The
 *   client's complaint of 2026-10-15 (one villa, two cards, 179 against
 *   210 m²) became a rule that day; this checks the rule is being applied,
 *   every night, over what is stored rather than over what the matcher
 *   believed in memory.
 *
 *   Each twin is then asked the sharper question: WOULD THE RESOLVE ITSELF
 *   MERGE THEM? The whole pipeline is replayed over the commune's listings —
 *   `clusterCandidates`, the same function the resolve writes from — and if
 *   the two properties' listings land in one group, the resolve disagrees
 *   with what is stored: an anomaly, something to find. If they land in two,
 *   the cluster guard separated them on purpose — a chain whose ends do not
 *   fit, two plots, a stale row from a source no longer collected — and the
 *   pair is a rule to question, listed with what kept it apart.
 *
 *   WELDED. A property whose served listings disagree on price or floor area
 *   by more than the guard allows is two houses under one card. The
 *   guard runs inside the resolve and should leave none; this reads the rows
 *   back and says whether it did.
 *
 * Not caught, and said plainly: two listings of one house that the rules do
 * not join — a price the agencies state differently, a size a quarter apart.
 * The audit measures the rules; a client's eye measures the market. When the
 * client reports a pair this audit does not list, the rule is what to change.
 */

export type AuditProperty = {
  id: string;
  communeInsee: string | null;
  priceEur: number | null;
  areaM2: number | null;
  landM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  propertyType: string | null;
  agencyId: string | null;
  agencyName: string | null;
  agencyRef: string | null;
  title: string | null;
  description: string | null;
};

export type AuditListing = {
  id: string;
  propertyId: string;
  source: string;
  priceEur: number | null;
  areaM2: number | null;
  landM2: number | null;
  propertyType: string | null;
};

export type Twin = {
  a: AuditProperty;
  b: AuditProperty;
  confidence: number;
  /** What joined them: the mandate, the measurements alone, or the prose. */
  by: "mandate" | "size" | "text";
  /**
   * Replaying the resolve over the commune's listings puts the two properties'
   * listings in one group: the resolve disagrees with what is stored. Null
   * when no replay was supplied.
   */
  wouldMerge: boolean | null;
  signals: MatchSignals;
};

export type Welded = {
  property: AuditProperty;
  listings: AuditListing[];
  on: "price" | "area";
};

export type AuditResult = {
  properties: number;
  twins: Twin[];
  welded: Welded[];
};

/** The matcher's default, the same one the resolve falls back to. */
const DEFAULT_MATCH_THRESHOLD = 0.8;

function asCandidate(p: AuditProperty): Candidate {
  return {
    id: p.id,
    sourceId: "property",
    communeInsee: p.communeInsee,
    priceEur: p.priceEur,
    areaM2: p.areaM2,
    landM2: p.landM2,
    rooms: p.rooms,
    bedrooms: p.bedrooms,
    propertyType: p.propertyType,
    agencyId: p.agencyId,
    agencyRef: p.agencyRef,
    title: p.title,
    description: p.description,
  };
}

/**
 * Pure: arithmetic over rows already in hand, so it can be argued with in a
 * test. `groupOf` is the resolve replayed — listing id → the group the
 * pipeline would put it in — supplied by `loadForAudit` or by a test.
 */
export function auditDuplicates(input: {
  properties: AuditProperty[];
  listings: AuditListing[];
  threshold?: number;
  groupOf?: (listingId: string) => string | undefined;
}): AuditResult {
  const threshold = input.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const byId = new Map(input.properties.map((p) => [p.id, p]));
  const listingsOf = new Map<string, AuditListing[]>();
  for (const l of input.listings) {
    const list = listingsOf.get(l.propertyId);
    if (list) list.push(l);
    else listingsOf.set(l.propertyId, [l]);
  }

  // ── Twins ─────────────────────────────────────────────────────────────
  const twins: Twin[] = [];
  const candidates = input.properties.filter((p) => p.communeInsee !== null).map(asCandidate);
  for (const [a, b] of candidatePairs(candidates)) {
    const v = scoreMatch(a, b);
    if (!v.same || v.confidence < threshold) continue;
    const pa = byId.get(a.id)!;
    const pb = byId.get(b.id)!;
    let wouldMerge: boolean | null = null;
    if (input.groupOf) {
      const groupsA = new Set((listingsOf.get(pa.id) ?? []).map((l) => input.groupOf!(l.id)).filter((g): g is string => !!g));
      wouldMerge = (listingsOf.get(pb.id) ?? []).some((l) => {
        const g = input.groupOf!(l.id);
        return !!g && groupsA.has(g);
      });
    }
    twins.push({
      a: pa,
      b: pb,
      confidence: v.confidence,
      by: v.signals.agencyRefExact ? "mandate" : v.signals.structuralOnly ? "size" : "text",
      wouldMerge,
      signals: v.signals,
    });
  }
  twins.sort((x, y) => Number(y.wouldMerge) - Number(x.wouldMerge) || y.confidence - x.confidence);

  // ── Welded ────────────────────────────────────────────────────────────
  const welded: Welded[] = [];
  for (const p of input.properties) {
    const ls = listingsOf.get(p.id) ?? [];
    if (ls.length < 2) continue;
    const members = ls.map((l) => ({ id: l.id, priceEur: l.priceEur, areaM2: l.areaM2, landM2: l.landM2, propertyType: l.propertyType }));
    if (incoherentMembers(members).length > 0) welded.push({ property: p, listings: ls, on: "price" });
    else if (incoherentAreas(members).length > 0) welded.push({ property: p, listings: ls, on: "area" });
  }

  return { properties: input.properties.length, twins, welded };
}

/**
 * What the client is served — active properties carried by a source still
 * collected, and those listings — plus the resolve replayed over EVERY active
 * listing of each commune, switched-off sources included, because that is what
 * the resolve clusters.
 */
export async function loadForAudit(
  threshold: number,
  communes?: string[],
): Promise<{ properties: AuditProperty[]; listings: AuditListing[]; groupOf: (listingId: string) => string | undefined }> {
  const rows = await db
    .select({
      id: properties.id,
      communeInsee: properties.communeInsee,
      priceEur: properties.priceEur,
      areaM2: properties.areaM2,
      landM2: properties.landM2,
      rooms: properties.rooms,
      bedrooms: properties.bedrooms,
      propertyType: properties.propertyType,
      agencyId: properties.agencyId,
      agencyName: portalAgencies.name,
      agencyRef: properties.agencyRef,
      title: properties.title,
      description: properties.description,
    })
    .from(properties)
    .leftJoin(portalAgencies, eq(portalAgencies.id, properties.agencyId))
    .where(
      and(
        eq(properties.status, "active"),
        servedProperty(null),
        ...(communes && communes.length > 0 ? [inArray(properties.communeInsee, communes)] : []),
      ),
    );
  const props: AuditProperty[] = rows.map((r) => ({
    ...r,
    areaM2: r.areaM2 === null ? null : Number(r.areaM2),
    landM2: r.landM2 === null ? null : Number(r.landM2),
  }));
  const served = new Set(props.map((p) => p.id));

  const listings: AuditListing[] = [];
  const groupOf = new Map<string, string>();
  const communesSeen = [...new Set(props.map((p) => p.communeInsee).filter((c): c is string => c !== null))];
  for (const commune of communesSeen) {
    // Every active row of the commune, as the resolve reads it.
    const all = await db
      .select({
        id: portalListings.id,
        propertyId: portalListings.propertyId,
        sourceId: portalListings.sourceId,
        source: portalSources.key,
        enabled: portalSources.enabled,
        communeInsee: portalListings.communeInsee,
        priceEur: portalListings.priceEur,
        areaM2: portalListings.areaM2,
        landM2: portalListings.landM2,
        rooms: portalListings.rooms,
        bedrooms: portalListings.bedrooms,
        propertyType: portalListings.propertyType,
        agencyId: portalListings.agencyId,
        agencyRef: portalListings.agencyRef,
        title: portalListings.title,
        description: portalListings.description,
      })
      .from(portalListings)
      .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
      .where(and(eq(portalListings.communeInsee, commune), eq(portalListings.status, "active")));
    const candidates: Candidate[] = all.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      communeInsee: r.communeInsee,
      priceEur: r.priceEur,
      areaM2: r.areaM2 === null ? null : Number(r.areaM2),
      landM2: r.landM2 === null ? null : Number(r.landM2),
      rooms: r.rooms,
      bedrooms: r.bedrooms,
      propertyType: r.propertyType,
      agencyId: r.agencyId,
      agencyRef: r.agencyRef,
      title: r.title,
      description: r.description,
    }));
    const { groups } = clusterCandidates(candidates, threshold);
    for (const [key, ids] of groups) for (const id of ids) groupOf.set(id, `${commune}:${key}`);
    for (const r of all) {
      if (!r.enabled || !r.propertyId || !served.has(r.propertyId)) continue;
      listings.push({
        id: r.id,
        propertyId: r.propertyId,
        source: r.source,
        priceEur: r.priceEur,
        areaM2: r.areaM2 === null ? null : Number(r.areaM2),
        landM2: r.landM2 === null ? null : Number(r.landM2),
        propertyType: r.propertyType,
      });
    }
  }
  return { properties: props, listings, groupOf: (id) => groupOf.get(id) };
}

/** Load, replay, and say it in one line — what the nightly appends to its summary. */
export async function auditLine(): Promise<{ line: string; worst: string[] }> {
  const threshold = await getNumberSetting(SETTING_KEYS.MATCH_THRESHOLD, DEFAULT_MATCH_THRESHOLD);
  const r = auditDuplicates({ ...(await loadForAudit(threshold)), threshold });
  const anomalies = r.twins.filter((t) => t.wouldMerge);
  const guarded = r.twins.filter((t) => !t.wouldMerge);
  const count = (list: Twin[], by: Twin["by"]) => list.filter((t) => t.by === by).length;
  const line =
    r.twins.length === 0 && r.welded.length === 0
      ? `duplicate audit: ${r.properties} served properties — none the rules call one house, none welded`
      : `duplicate audit: ${r.properties} served properties; ${anomalies.length} pair(s) the resolve itself would merge yet still apart; ` +
        `${guarded.length} pair(s) one house by the pair rule but kept apart by the cluster guard ` +
        `(mandate ${count(guarded, "mandate")}, size ${count(guarded, "size")}, text ${count(guarded, "text")}); ` +
        `${r.welded.length} propert(ies) welded — \`npm run dedup:audit\` lists them`;
  return { line, worst: [...anomalies.slice(0, 5).map(describeTwin), ...r.welded.slice(0, 3).map(describeWelded)] };
}

const eur = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("fr-FR")} €`);
const m2 = (n: number | null) => (n === null ? "—" : `${n} m²`);

function describeTwin(t: Twin): string {
  return (
    `${t.a.communeInsee}  ${eur(t.a.priceEur)}  ${m2(t.a.areaM2)} / ${m2(t.b.areaM2)}` +
    (t.a.landM2 !== null || t.b.landM2 !== null ? `  on ${m2(t.a.landM2)} / ${m2(t.b.landM2)}` : "") +
    `  [${t.a.agencyName ?? "?"}] vs [${t.b.agencyName ?? "?"}]  by ${t.by} @${t.confidence}` +
    (t.wouldMerge === true ? "  ← THE RESOLVE WOULD MERGE THESE" : t.wouldMerge === false ? "  (the guard keeps them apart)" : "") +
    `\n      ${t.a.id}  ${(t.a.title ?? "").slice(0, 50)}\n      ${t.b.id}  ${(t.b.title ?? "").slice(0, 50)}`
  );
}

function describeWelded(w: Welded): string {
  return (
    `${w.property.communeInsee}  ${w.property.id}  welded on ${w.on}: ` +
    w.listings.map((l) => `${l.source} ${eur(l.priceEur)} ${m2(l.areaM2)}${l.landM2 !== null ? `/${l.landM2}` : ""}`).join(" | ")
  );
}

async function main(): Promise<void> {
  const only = process.argv.find((a) => a.startsWith("--communes="))?.slice("--communes=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = await getNumberSetting(SETTING_KEYS.MATCH_THRESHOLD, DEFAULT_MATCH_THRESHOLD);
  const data = await loadForAudit(threshold, only);
  const r = auditDuplicates({ ...data, threshold });
  const anomalies = r.twins.filter((t) => t.wouldMerge);
  const guarded = r.twins.filter((t) => !t.wouldMerge);
  const limit = only ? Infinity : 25;

  console.log(`\n── duplicate audit ── ${r.properties} served properties, ${data.listings.length} listings, threshold ${threshold}\n`);
  console.log(`THE RESOLVE ITSELF WOULD MERGE THESE, yet they are two properties — anomalies: ${anomalies.length}`);
  for (const t of anomalies.slice(0, limit)) console.log("  " + describeTwin(t));

  console.log(`\nONE HOUSE BY THE PAIR RULE, KEPT APART BY THE CLUSTER GUARD: ${guarded.length}`);
  const byCommune = new Map<string, number>();
  for (const t of guarded) byCommune.set(t.a.communeInsee ?? "?", (byCommune.get(t.a.communeInsee ?? "?") ?? 0) + 1);
  if (byCommune.size > 0) console.log("  by commune: " + [...byCommune].sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} ${n}`).join(", "));
  const byKind = { mandate: 0, size: 0, text: 0 };
  for (const t of guarded) byKind[t.by] += 1;
  console.log(`  by evidence: mandate ${byKind.mandate}, size ${byKind.size}, text ${byKind.text}`);
  for (const t of guarded.slice(0, limit)) console.log("  " + describeTwin(t));
  if (guarded.length > limit) console.log(`  … ${guarded.length - limit} more: run with --communes=<insee> to list a commune in full`);

  console.log(`\nWELDED — properties whose listings disagree beyond the guard: ${r.welded.length}`);
  for (const w of r.welded.slice(0, 20)) console.log("  " + describeWelded(w));
  console.log("\nReport only. A pair here is a rule to question before it is a row to merge.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
