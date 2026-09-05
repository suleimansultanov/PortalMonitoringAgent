import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * The plot's size, sitting in the floor-area column.
 *
 *   npm run land            — list what would change
 *   npm run land -- --fix   — clear those floor areas
 *
 * Ninety-eight active listings carry their garden's size as their living
 * space. "Villa T3 sur 2168 m² de terrain" is stored as a villa with 2168 m² of
 * floor area, and nothing rejects it: 2168 is an ordinary number. It surfaces
 * only in the price per square metre — twenty times too low — which is then
 * averaged into the median the client reads in a report, next to figures that
 * are correct.
 *
 * ONE SHAPE, AND ONLY ONE: A TERRAIN WHOSE FLOOR AREA EQUALS ITS PLOT.
 *
 * A plot of land has no floor area at all — there is no building — so the
 * number in that column is the land, which the land column already holds. The
 * floor area is cleared and nothing is lost.
 *
 * TWO OTHER SHAPES WERE IN THIS SCRIPT AND WERE REMOVED BEFORE IT EVER RAN
 * WITH --fix. Both looked decidable and were not:
 *
 *   - "a dwelling whose floor area exactly equals its plot". True of some
 *     mistakes and true of a village house on a 120 m² plot. And where it IS a
 *     mistake, the title usually shows the FLOOR area is the correct one and
 *     the plot is the copy — so clearing the floor area deletes the good value
 *     and keeps the bad one.
 *
 *   - "a dwelling whose title says this number is the plot". This matched on
 *     the French preposition `de`, which introduces a size and says nothing
 *     about land: "Appartement de 17 m² à rafraîchir" is a seventeen-square-
 *     metre flat, not a flat on a seventeen-square-metre plot. It would have
 *     moved the floor area of about a hundred flats into the plot column and
 *     emptied it — worse than the fault it was written to repair.
 *
 * Both were caught by reading the --dry list rather than by reasoning about
 * the rule, which is the only reason this note exists instead of an apology.
 *
 * WHAT THIS DOES NOT DO: invent a floor area. We do not know it — the page says
 * it somewhere, but reading it correctly is the parser's job and the parser is
 * what put us here. The column is emptied instead. An empty field is visibly
 * incomplete; a wrong one that looks right is the kind of error nobody catches.
 *
 * AND IT IS A PATCH, NOT A CURE. The adapters still misread these pages. If a
 * portal edits one of them and we re-fetch it, the wrong number comes back.
 * Pages rarely change, so this holds in practice — but the parser is the real
 * repair and this only buys time.
 */

const LAND_TYPE = "(property_type ilike '%terrain%' or property_type ilike '%land%')";

async function main(): Promise<void> {
  const fix = process.argv.includes("--fix");

  const rows = await db.execute(sql`
    select s.key                       as source,
           l.property_type,
           l.area_m2,
           l.land_m2,
           left(l.title, 64)           as title,
           l.url
      from portal_listings l
      join portal_sources s on s.id = l.source_id
     where l.status = 'active'
       and l.area_m2 is not null
       and l.area_m2 = l.land_m2
       and ${sql.raw(LAND_TYPE)}
     order by l.area_m2 desc
  `);

  const found = rows.rows as Record<string, unknown>[];
  if (found.length === 0) {
    console.log("\nNo listing is carrying its plot as its floor area.\n");
    process.exit(0);
  }

  console.log(`\n${found.length} listing(s) whose floor area is really the plot:\n`);
  for (const r of found) {
    console.log(
      `  ${String(r.source).padEnd(14)} ${String(r.property_type ?? "—").padEnd(12)} ` +
        `area ${String(r.area_m2).padStart(8)} → cleared,  land ${String(r.land_m2).padStart(8)} kept`,
    );
    console.log(`                 ${String(r.title)}`);
    console.log(`                 ${String(r.url)}`);
  }

  if (!fix) {
    console.log(
      "\nRe-run with --fix to clear these floor areas. The plot size is kept —\n" +
        "it is the same number and it is in the right column already.\n",
    );
    process.exit(0);
  }

  /**
   * Move the number to the plot where the plot is empty, then clear the floor
   * area everywhere. Order matters: the move reads the value the clear removes.
   */
  const cleared = await db.execute(sql`
    update portal_listings
       set area_m2 = null, price_per_m2 = null, updated_at = now()
     where status = 'active'
       and area_m2 is not null
       and area_m2 = land_m2
       and ${sql.raw(LAND_TYPE)}
  `);

  /**
   * And on `properties`, because that is the table the API serves. Fixing only
   * the listings leaves the wrong number on the client's screen until a resolve
   * happens to touch that commune.
   */
  const props = await db.execute(sql`
    update properties
       set area_m2 = null, updated_at = now()
     where status = 'active'
       and area_m2 is not null
       and area_m2 = land_m2
       and ${sql.raw(LAND_TYPE)}
  `);

  const n = (r: unknown) => Number((r as { rowCount?: number }).rowCount ?? 0);
  console.log(
    `\nfloor area cleared on plots: ${n(cleared)} listing(s), ${n(props)} propert(ies)\n\n` +
      "The parser is unchanged and will reproduce this on any page it re-reads.\n",
  );
  process.exit(0);
}

void main();
