import { pathToFileURL } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalAgencies, portalListings, portalSources, properties } from "@/lib/db/schema";
import { servedProperty } from "@/lib/api/served";
import { getNumberSetting, SETTING_KEYS } from "@/lib/settings/store";
import {
  candidatePairs,
  cluster,
  incoherentAreas,
  incoherentMembers,
  scoreMatch,
  splitIncoherent,
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
 * TWO QUESTIONS, in both directions the matcher can be wrong:
 *
 *   TWINS LEFT APART. Every active property the client is served is scored
 *   against every other in its commune exactly as two listings would be —
 *   `candidatePairs` and `scoreMatch`, the same threshold the resolve reads.
 *   A pair the rules call one house is a duplicate on the client's screen by
 *   our own definition. Measured with the rules rather than with a looser
 *   "same price, close size" net on purpose: the client's complaint of
 *   2026-10-15 (one villa, two cards, 179 against 210 m²) became a rule that
 *   day, and this is what checks the rule is being applied, every night, over
 *   what is stored rather than over what the matcher believed in memory.
 *
 *   Some of these are deliberate. The coherence guard splits a cluster whose
 *   ends do not fit together even when each adjacent pair does, so a pair the
 *   guard separated scores as a twin here every night. They are told apart:
 *   the twins are clustered and guarded the way the resolve does it, and a
 *   pair the guard would split again is reported as such, not as a miss.
 *
 *   HOUSES WELDED TOGETHER. A property whose served listings disagree on
 *   price by more than the cluster guard allows, or on floor area, is two
 *   houses under one card. The guard runs inside the resolve and should
 *   leave none; this reads the rows and says whether it did.
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
  /** True when the resolve's own guard would split this pair again: reported, not a miss. */
  guarded: boolean;
  signals: MatchSignals;
};

export type Welded = {
  property: AuditProperty;
  listings: AuditListing[];
  /** Which dimension disagrees. */
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

/** Pure: everything below is arithmetic over rows already in hand, so it can be argued with in a test. */
export function auditDuplicates(
  input: { properties: AuditProperty[]; listings: AuditListing[]; threshold?: number },
): AuditResult {
  const threshold = input.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const byId = new Map(input.properties.map((p) => [p.id, p]));

  // ── Twins left apart ──────────────────────────────────────────────────
  const candidates = input.properties.filter((p) => p.communeInsee !== null).map(asCandidate);
  const edges: [string, string][] = [];
  const verdicts = new Map<string, { confidence: number; signals: MatchSignals }>();
  for (const [a, b] of candidatePairs(candidates)) {
    const v = scoreMatch(a, b);
    if (!v.same || v.confidence < threshold) continue;
    edges.push([a.id, b.id]);
    verdicts.set(`${a.id}|${b.id}`, { confidence: v.confidence, signals: v.signals });
  }

  /**
   * Cluster and guard the twins the way the resolve does, so a pair the guard
   * would separate again is told apart from a pair the resolve simply never
   * joined. Same functions, same order: price first, then floor area.
   */
  const roots = cluster(
    candidates.map((c) => c.id),
    edges,
  );
  const groups = new Map<string, AuditProperty[]>();
  for (const c of candidates) {
    const root = roots.get(c.id) ?? c.id;
    const list = groups.get(root);
    const p = byId.get(c.id)!;
    if (list) list.push(p);
    else groups.set(root, [p]);
  }
  splitIncoherent(groups, edges);
  const groupOf = new Map<string, string>();
  for (const [key, members] of groups) for (const m of members) groupOf.set(m.id, key);

  const twins: Twin[] = [];
  for (const [key, v] of verdicts) {
    const [aId, bId] = key.split("|");
    const a = byId.get(aId)!;
    const b = byId.get(bId)!;
    twins.push({
      a,
      b,
      confidence: v.confidence,
      by: v.signals.agencyRefExact ? "mandate" : v.signals.structuralOnly ? "size" : "text",
      guarded: groupOf.get(aId) !== groupOf.get(bId),
      signals: v.signals,
    });
  }
  twins.sort((x, y) => Number(x.guarded) - Number(y.guarded) || y.confidence - x.confidence);

  // ── Houses welded together ────────────────────────────────────────────
  const listingsOf = new Map<string, AuditListing[]>();
  for (const l of input.listings) {
    const list = listingsOf.get(l.propertyId);
    if (list) list.push(l);
    else listingsOf.set(l.propertyId, [l]);
  }
  const welded: Welded[] = [];
  for (const p of input.properties) {
    const ls = listingsOf.get(p.id) ?? [];
    if (ls.length < 2) continue;
    const members = ls.map((l, i) => ({ id: String(i), priceEur: l.priceEur, areaM2: l.areaM2, landM2: l.landM2, propertyType: l.propertyType }));
    if (incoherentMembers(members).length > 0) welded.push({ property: p, listings: ls, on: "price" });
    else if (incoherentAreas(members).length > 0) welded.push({ property: p, listings: ls, on: "area" });
  }

  return { properties: input.properties.length, twins, welded };
}

/** What the client is served: active properties carried by a source still collected, and those listings. */
export async function loadForAudit(communes?: string[]): Promise<{ properties: AuditProperty[]; listings: AuditListing[] }> {
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

  const ids = props.map((p) => p.id);
  const listings: AuditListing[] = [];
  // In slices: `in (…)` over seven thousand ids is one statement too many for the pooler's 10 s.
  for (let i = 0; i < ids.length; i += 1000) {
    const slice = ids.slice(i, i + 1000);
    const ls = await db
      .select({
        propertyId: portalListings.propertyId,
        source: portalSources.key,
        priceEur: portalListings.priceEur,
        areaM2: portalListings.areaM2,
        landM2: portalListings.landM2,
        propertyType: portalListings.propertyType,
      })
      .from(portalListings)
      .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
      .where(and(inArray(portalListings.propertyId, slice), eq(portalListings.status, "active"), eq(portalSources.enabled, true)));
    for (const l of ls) {
      if (!l.propertyId) continue;
      listings.push({
        propertyId: l.propertyId,
        source: l.source,
        priceEur: l.priceEur,
        areaM2: l.areaM2 === null ? null : Number(l.areaM2),
        landM2: l.landM2 === null ? null : Number(l.landM2),
        propertyType: l.propertyType,
      });
    }
  }
  return { properties: props, listings };
}

/** Load, score, and say it in one line — what the nightly appends to its summary. */
export async function auditLine(): Promise<{ line: string; worst: string[] }> {
  const threshold = await getNumberSetting(SETTING_KEYS.MATCH_THRESHOLD, DEFAULT_MATCH_THRESHOLD);
  const r = auditDuplicates({ ...(await loadForAudit()), threshold });
  const misses = r.twins.filter((t) => !t.guarded);
  const guarded = r.twins.length - misses.length;
  const count = (by: Twin["by"]) => misses.filter((t) => t.by === by).length;
  const line =
    misses.length === 0 && r.welded.length === 0
      ? `duplicate audit: ${r.properties} served properties, none that the rules call one house, none welded`
      : `duplicate audit: ${misses.length} pair(s) the rules call one house still apart ` +
        `(mandate ${count("mandate")}, size ${count("size")}, text ${count("text")})` +
        (guarded > 0 ? `, ${guarded} more the guard keeps apart on purpose` : "") +
        `; ${r.welded.length} propert(ies) welded from two houses — \`npm run dedup:audit\` lists them`;
  return { line, worst: [...misses.slice(0, 5).map(describeTwin), ...r.welded.slice(0, 3).map(describeWelded)] };
}

const eur = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("fr-FR")} €`);
const m2 = (n: number | null) => (n === null ? "—" : `${n} m²`);

function describeTwin(t: Twin): string {
  return (
    `${t.a.communeInsee}  ${eur(t.a.priceEur)}  ${m2(t.a.areaM2)} / ${m2(t.b.areaM2)}` +
    (t.a.landM2 !== null || t.b.landM2 !== null ? `  on ${m2(t.a.landM2)} / ${m2(t.b.landM2)}` : "") +
    `  [${t.a.agencyName ?? "?"}] vs [${t.b.agencyName ?? "?"}]  by ${t.by} @${t.confidence}` +
    (t.guarded ? "  (guard keeps apart)" : "") +
    `\n      ${t.a.id}  ${(t.a.title ?? "").slice(0, 50)}\n      ${t.b.id}  ${(t.b.title ?? "").slice(0, 50)}`
  );
}

function describeWelded(w: Welded): string {
  return (
    `${w.property.communeInsee}  ${w.property.id}  welded on ${w.on}: ` +
    w.listings.map((l) => `${l.source} ${eur(l.priceEur)} ${m2(l.areaM2)}`).join(" | ")
  );
}

async function main(): Promise<void> {
  const only = process.argv.find((a) => a.startsWith("--communes="))?.slice("--communes=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = await getNumberSetting(SETTING_KEYS.MATCH_THRESHOLD, DEFAULT_MATCH_THRESHOLD);
  const data = await loadForAudit(only);
  const r = auditDuplicates({ ...data, threshold });
  const misses = r.twins.filter((t) => !t.guarded);
  const guarded = r.twins.filter((t) => t.guarded);

  console.log(`\n── duplicate audit ── ${r.properties} served properties, ${data.listings.length} listings, threshold ${threshold}\n`);
  console.log(`TWINS LEFT APART — pairs the rules call one house: ${misses.length}`);
  const byCommune = new Map<string, number>();
  for (const t of misses) byCommune.set(t.a.communeInsee ?? "?", (byCommune.get(t.a.communeInsee ?? "?") ?? 0) + 1);
  if (byCommune.size > 0) console.log("  by commune: " + [...byCommune].sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} ${n}`).join(", "));
  const byKind = { mandate: 0, size: 0, text: 0 };
  for (const t of misses) byKind[t.by] += 1;
  console.log(`  by evidence: mandate ${byKind.mandate}, size ${byKind.size}, text ${byKind.text}`);
  for (const t of misses.slice(0, only ? misses.length : 25)) console.log("  " + describeTwin(t));
  if (misses.length > 25 && !only) console.log(`  … ${misses.length - 25} more: run with --communes=<insee> to list a commune in full`);

  console.log(`\nKEPT APART BY THE GUARD — twins in a cluster whose ends do not fit: ${guarded.length}`);
  for (const t of guarded.slice(0, only ? guarded.length : 10)) console.log("  " + describeTwin(t));

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
