import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * Values that cannot be true, still sitting in the database.
 *
 *   npm run sanity          — report
 *   npm run sanity -- --fix — drop the impossible figures, keep the listings
 *
 * The ingest guard rejects these on the way in. It does not reach backwards:
 * a listing collected before the guard existed keeps whatever it was given,
 * and it is never re-parsed, because the page has not changed and the collector
 * skips a page whose content hash it already holds. That is the right thing for
 * a crawler and it means bad data from before a fix is permanent until somebody
 * goes and gets it.
 *
 * On 2026-09-04 that was a Saint-Tropez villa priced at 20 000 005 000 000 € —
 * twenty trillion, roughly seven times the GDP of France — sitting at the top
 * of the client's list, because sorting by price descending puts the worst row
 * in the product first.
 *
 * A figure that cannot be true is removed rather than corrected. "No price" is
 * honest and visibly incomplete; an invented plausible price is neither, and
 * that is the kind of wrong nobody catches.
 *
 * WHAT COUNTS AS IMPOSSIBLE DEPENDS ON THE TYPE, and the first version of this
 * script got that wrong: it flagged forty-odd plots of land for having six
 * thousand square metres, which is what a plot of land has. Running it with
 * --fix would have erased the correct area of every terrain in the market to
 * remove one broken price. So a plot is judged only for being impossibly
 * SMALL, and the ceiling applies to homes, where floor area is floor area.
 */

/** Above this is not a property in this market. Mirrors the ingest guard. */
const MAX_PRICE_EUR = 250_000_000;
/**
 * No home and no plot is smaller than this. The values below it are not small
 * properties, they are unit errors: Superimmo publishing 0,655 for a house of
 * 655 m², 0,2006 for 200,6, 3 for 300. A decimal separator read as a thousands
 * separator, or ares read as square metres.
 */
const MIN_AREA_M2 = 5;
/**
 * And above this, a DWELLING is a parsing accident — the largest villa in the
 * market is 1035 m². Land is excluded from this test entirely: six thousand
 * square metres is an ordinary building plot in Grimaud, and the adapters put
 * a plot's size in this column because for a terrain that IS its size.
 */
const MAX_DWELLING_M2 = 2_000;
/** Terrain, Land, Plot, Parcelle, Field — whatever each portal calls it. */
const LAND = "(property_type ilike '%terrain%' or property_type ilike '%land%' " +
  "or property_type ilike '%plot%' or property_type ilike '%parcelle%')";

/**
 * The sweep itself, so the nightly can run it without spawning a CLI.
 *
 * Returns what it found and, when fixing, what it cleared — a number the night
 * summary can carry. A check nobody runs is not a check, and the way to make
 * one run is to put it where the work already happens.
 */
export async function sweepImpossibleValues(fix: boolean): Promise<{
  found: number;
  clearedListings: number;
  clearedProperties: number;
  worst: string[];
}> {
  const report = await findImpossible();
  if (report.length === 0 || !fix) {
    return {
      found: report.length,
      clearedListings: 0,
      clearedProperties: 0,
      worst: report.slice(0, 5).map(describe),
    };
  }
  const cleared = await clearImpossible();
  return { found: report.length, ...cleared, worst: report.slice(0, 5).map(describe) };
}

function describe(r: Record<string, unknown>): string {
  return (
    `${String(r.source)} ${String(r.problem)}: ` +
    `${String(r.price_eur ?? "—")} € ${String(r.area_m2 ?? "—")} m² — ${String(r.url)}`
  );
}

/** The rows carrying a value that cannot be true. Read-only. */
async function findImpossible(): Promise<Record<string, unknown>[]> {
  const bad = await db.execute<{
    id: string;
    source: string;
    price_eur: string | null;
    area_m2: string | null;
    property_type: string | null;
    title: string | null;
    url: string;
    problem: string;
  }>(sql`
    select l.id,
           s.key                as source,
           l.price_eur,
           l.area_m2,
           l.property_type,
           l.title,
           l.url,
           case
             when l.price_eur > ${MAX_PRICE_EUR} then 'price'
             when l.area_m2 < ${MIN_AREA_M2} then 'area, unit error'
             else 'area, too large for a home'
           end                  as problem
      from portal_listings l
      join portal_sources s on s.id = l.source_id
     where l.price_eur > ${MAX_PRICE_EUR}
        or (l.area_m2 is not null and l.area_m2 < ${MIN_AREA_M2})
        or (
          l.area_m2 > ${MAX_DWELLING_M2}
          and not ${sql.raw(LAND)}
          and l.property_type is not null
        )
     order by l.price_eur desc nulls last
  `);

  return bad.rows as Record<string, unknown>[];
}

/** Drop those values, keeping every row. Both tables: `properties` is a copy. */
async function clearImpossible(): Promise<{ clearedListings: number; clearedProperties: number }> {
  const listings = await db.execute(sql`
    update portal_listings
       set price_eur = case when price_eur > ${MAX_PRICE_EUR} then null else price_eur end,
           price_per_m2 = case when price_eur > ${MAX_PRICE_EUR} then null else price_per_m2 end,
           area_m2 = case
                       when area_m2 < ${MIN_AREA_M2} then null
                       when area_m2 > ${MAX_DWELLING_M2}
                            and not ${sql.raw(LAND)}
                            and property_type is not null then null
                       else area_m2
                     end,
           updated_at = now()
     where price_eur > ${MAX_PRICE_EUR}
        or (area_m2 is not null and area_m2 < ${MIN_AREA_M2})
        or (area_m2 > ${MAX_DWELLING_M2} and not ${sql.raw(LAND)} and property_type is not null)
  `);

  const props = await db.execute(sql`
    update properties
       set price_eur = case when price_eur > ${MAX_PRICE_EUR} then null else price_eur end,
           area_m2 = case
                       when area_m2 < ${MIN_AREA_M2} then null
                       when area_m2 > ${MAX_DWELLING_M2}
                            and not ${sql.raw(LAND)}
                            and property_type is not null then null
                       else area_m2
                     end,
           updated_at = now()
     where price_eur > ${MAX_PRICE_EUR}
        or (area_m2 is not null and area_m2 < ${MIN_AREA_M2})
        or (area_m2 > ${MAX_DWELLING_M2} and not ${sql.raw(LAND)} and property_type is not null)
  `);

  return {
    clearedListings: Number((listings as { rowCount?: number }).rowCount ?? 0),
    clearedProperties: Number((props as { rowCount?: number }).rowCount ?? 0),
  };
}

async function main(): Promise<void> {
  const fix = process.argv.includes("--fix");
  const rows = await findImpossible();

  if (rows.length === 0) {
    console.log("\nNothing impossible in the listings.\n");
    process.exit(0);
  }

  console.log(`\n${rows.length} listing(s) carrying a value that cannot be true:\n`);
  for (const r of rows) {
    console.log(
      `  ${String(r.source).padEnd(14)} ${String(r.problem).padEnd(26)} ` +
        `${String(r.price_eur ?? "—").padStart(18)} €  ${String(r.area_m2 ?? "—").padStart(9)} m²  ` +
        `${String(r.property_type ?? "—")}`,
    );
    console.log(`                 ${(r.title as string) ?? ""}`);
    console.log(`                 ${r.url as string}`);
  }

  if (!fix) {
    console.log("\nRe-run with --fix to drop these figures. The listings stay.\n");
    process.exit(0);
  }

  const cleared = await clearImpossible();
  console.log(
    `\nDropped the impossible figures from ${cleared.clearedListings} listing(s) and ` +
      `${cleared.clearedProperties} propert(ies). The rows are kept.\n`,
  );
  process.exit(0);
}

void main();
