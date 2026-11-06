import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, withDbRetry } from "@/lib/db/client";
import { portalListings, portalSources, properties } from "@/lib/db/schema";
import { placedAbroad } from "./abroad";
import { resolveCommune } from "./communes";

/**
 * Re-file stored listings after a change to `resolveCommune`.
 *
 *   npx tsx src/lib/portals/recommune.ts                      what would move, nothing written
 *   npx tsx src/lib/portals/recommune.ts --apply --save=<f>   write it; <f> keeps the old values
 *   then: npm run resolve -- --communes=<the ones it names>, and npm run dedup:audit
 *
 * Ingest resolves a commune when it parses a page, and a page whose content hash
 * has not changed is never parsed again. So a better rule reaches tomorrow's new
 * listings and nothing already stored: on 2026-11-05, 693 live rows sat in a
 * commune their own stated place did not name. This replays the rule over the
 * fields ingest stored, which are the fields it read. No page is downloaded.
 *
 * A PROPERTY MOVES WITH ITS LISTINGS, WHEN ALL OF THEM GO TO THE SAME COMMUNE.
 * The resolve reuses a property id only inside the commune written on the
 * property (`chooseExistingId`). Moving the listings alone would give every card
 * a new id in its new commune and leave the old one to be delisted, which the
 * client reads as a home sold and a home listed, and its saved lists lose the
 * card. A property whose listings split across communes stays where it is, and
 * the ones that left find or start a card where they now are.
 *
 * One case is left alone on purpose: a row filed under Les Issambres whose place
 * says only "Roquebrune-sur-Argens", with no postcode and no district named. The
 * rule would take it off the client's market; nothing says it is elsewhere, so
 * that is a decision for a person, not for a replay.
 */

type Row = {
  id: string;
  source: string;
  status: string;
  old: string | null;
  raw: string | null;
  postal: string | null;
  url: string;
  propertyId: string | null;
};

const SHARED_POSTCODES = new Set(["83310", "83120"]);

/** Whether the text can change the INSEE code the rule gives. A district never does: it shares its commune's code. */
function needsText(r: Row): boolean {
  if (r.old === null || r.raw === null) return true;
  if (/roquebrune/i.test(r.raw)) return true;
  return !!r.postal && SHARED_POSTCODES.has(r.postal.trim()) && resolveCommune(r.raw, null, null) === null;
}

async function readRows(): Promise<Row[]> {
  const sources = new Map((await db.select({ id: portalSources.id, key: portalSources.key }).from(portalSources)).map((s) => [s.id, s.key]));
  const out: Row[] = [];
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    // Pages by id: every query on this pool stops at ten seconds, and the whole table in one does not fit.
    const page = await withDbRetry(() =>
      db
        .select({
          id: portalListings.id,
          sourceId: portalListings.sourceId,
          status: portalListings.status,
          old: portalListings.communeInsee,
          raw: portalListings.communeRaw,
          postal: portalListings.postalCode,
          url: portalListings.url,
          propertyId: portalListings.propertyId,
        })
        .from(portalListings)
        .where(gt(portalListings.id, after))
        .orderBy(asc(portalListings.id))
        .limit(4000),
    );
    for (const r of page) out.push({ ...r, source: sources.get(r.sourceId) ?? "?" });
    if (page.length < 4000) return out;
    after = page[page.length - 1].id;
  }
}

async function readTexts(ids: string[]): Promise<Map<string, { title: string | null; description: string | null }>> {
  const out = new Map<string, { title: string | null; description: string | null }>();
  for (let i = 0; i < ids.length; i += 300) {
    const rows = await withDbRetry(() =>
      db.select({ id: portalListings.id, title: portalListings.title, description: portalListings.description }).from(portalListings).where(inArray(portalListings.id, ids.slice(i, i + 300))),
    );
    for (const r of rows) out.set(r.id, { title: r.title, description: r.description });
  }
  return out;
}

export type Move = Row & { now: string | null };

/** What the rule says now, for every stored row it would change. Pure but for its inputs. */
export function plan(rows: Row[], texts: Map<string, { title: string | null; description: string | null }>): { moves: Move[]; kept: Move[] } {
  const moves: Move[] = [];
  const kept: Move[] = [];
  for (const r of rows) {
    const t = texts.get(r.id);
    const abroad = r.old === null && !!placedAbroad(r.url, t?.title, t?.description);
    const now = abroad ? null : (resolveCommune(r.raw, r.postal, t ? `${t.title ?? ""} ${t.description ?? ""}` : null)?.insee ?? null);
    if (now === r.old) continue;
    const move = { ...r, now };
    if (r.old === "83107" && now === null && !r.postal && /roquebrune/i.test(r.raw ?? "")) kept.push(move);
    else moves.push(move);
  }
  return { moves, kept };
}

/** Properties whose every live listing ends up in one other commune: they move whole and keep their id. */
export function propertiesMovingWhole(rows: Row[], moves: Move[], propertyCommune: Map<string, string | null>): Map<string, string> {
  const finalOf = new Map(moves.map((m) => [m.id, m.now]));
  const byProperty = new Map<string, Set<string | null>>();
  for (const r of rows) {
    if (r.status !== "active" || !r.propertyId) continue;
    const c = finalOf.has(r.id) ? finalOf.get(r.id)! : r.old;
    byProperty.set(r.propertyId, (byProperty.get(r.propertyId) ?? new Set()).add(c));
  }
  const out = new Map<string, string>();
  for (const [pid, communes] of byProperty) {
    if (communes.size !== 1) continue;
    const [c] = [...communes];
    if (c && propertyCommune.has(pid) && propertyCommune.get(pid) !== c) out.set(pid, c);
  }
  return out;
}

const count = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const save = process.argv.find((a) => a.startsWith("--save="))?.split("=").slice(1).join("=");
  if (apply && !save) throw new Error("--apply needs --save=<file>: the old values are the only way back");

  const rows = await readRows();
  const textIds = rows.filter(needsText).map((r) => r.id);
  const texts = await readTexts(textIds);
  const { moves, kept } = plan(rows, texts);

  const touchedProperties = [...new Set(rows.filter((r) => r.status === "active" && r.propertyId && moves.some((m) => m.propertyId === r.propertyId)).map((r) => r.propertyId!))];
  const propertyCommune = new Map<string, string | null>();
  for (let i = 0; i < touchedProperties.length; i += 300) {
    const ps = await withDbRetry(() =>
      db.select({ id: properties.id, commune: properties.communeInsee }).from(properties).where(and(inArray(properties.id, touchedProperties.slice(i, i + 300)), eq(properties.status, "active"))),
    );
    for (const p of ps) propertyCommune.set(p.id, p.commune);
  }
  const whole = propertiesMovingWhole(rows, moves, propertyCommune);
  const live = moves.filter((m) => m.status === "active");
  const communes = [...new Set(moves.flatMap((m) => [m.old, m.now]).filter((c): c is string => !!c))].sort();

  console.log(`\n${rows.length} listings read, the text of ${texts.size}. ${moves.length} would move (${live.length} live); ${kept.length} left alone (Roquebrune, nothing stated).`);
  console.log("\nLive, by source:");
  for (const [k, n] of count(live, (m) => m.source)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log("\nLive, from → to:");
  for (const [k, n] of count(live, (m) => `${m.old ?? "none"} → ${m.now ?? "none"}`).slice(0, 25)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log(`\nProperties: ${touchedProperties.length} live ones touched, ${whole.size} move whole and keep their id; the rest split and their moved listings find or start a card.`);
  console.log(`Communes to resolve afterwards: ${communes.join(",")}`);

  if (!apply) {
    console.log("\nNothing written. --apply --save=<file> to write.\n");
    return;
  }

  await fs.writeFile(
    save!,
    JSON.stringify({ at: new Date().toISOString(), listings: moves.map((m) => ({ id: m.id, old: m.old, now: m.now })), properties: [...whole].map(([id, now]) => ({ id, old: propertyCommune.get(id) ?? null, now })) }),
    "utf8",
  );
  console.log(`\nOld values saved to ${save}.`);

  await db.transaction(async (tx) => {
    for (const [target, group] of groupBy(moves, (m) => m.now ?? "")) {
      const ids = group.map((m) => m.id);
      for (let i = 0; i < ids.length; i += 500) {
        await tx.update(portalListings).set({ communeInsee: target || null, updatedAt: new Date() }).where(inArray(portalListings.id, ids.slice(i, i + 500)));
      }
    }
    for (const [target, group] of groupBy([...whole], ([, c]) => c)) {
      const ids = group.map(([id]) => id);
      for (let i = 0; i < ids.length; i += 500) {
        await tx.update(properties).set({ communeInsee: target, updatedAt: new Date() }).where(inArray(properties.id, ids.slice(i, i + 500)));
      }
    }
  });
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(portalListings).where(inArray(portalListings.id, moves.slice(0, 500).map((m) => m.id)));
  console.log(`Written: ${moves.length} listings, ${whole.size} properties (${n} of the first 500 read back).`);
  console.log(`Next: npm run resolve -- --communes=${communes.join(",")}  then  npm run dedup:audit\n`);
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
