import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * Where the gaps are, and whether they are our fault.
 *
 *   npm run quality
 *
 * The collector already prints a null-rate at the end of a pass, but that
 * number is computed over the whole table rather than over the pass — so after
 * a parser fix it keeps reporting the old rows and looks like the fix did not
 * work. It also cannot tell an honest gap from a broken selector: a plot of
 * land has no rooms, and counting that as a miss buries the misses that matter.
 *
 * This splits both ways: by source and property type (is it terrain?) and by
 * ingest day (is it stale rows from before a fix?).
 *
 * Read-only.
 */

type Row = Record<string, unknown>;

/**
 * Column names, not field names.
 *
 * `agency` is `agency_id` — the agency lives in its own table and the listing
 * only points at it. Counting a non-existent `agency_name` here is what made
 * the first version of this script fail, and it is the same class of mistake as
 * writing a selector against markup you have not read.
 */
const FIELDS = [
  ["price", "price_eur"],
  ["area", "area_m2"],
  ["rooms", "rooms"],
  ["agency", "agency_id"],
  ["ref", "agency_ref"],
] as const;

function bar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "·".repeat(10 - filled);
}

function pct(have: number, total: number): number {
  return total === 0 ? 0 : Math.round(((total - have) / total) * 100);
}

async function main(): Promise<void> {
  const cols = FIELDS.map(([label, col]) => `count(${col})::int as "${label}"`).join(", ");

  const byType = await db.execute<Row>(
    sql.raw(`
      select s.key as source,
             coalesce(l.property_type, '(none)') as type,
             count(*)::int as total,
             ${cols}
      from portal_listings l
      join portal_sources s on s.id = l.source_id
      group by 1, 2
      order by 1, 3 desc
    `),
  );

  if (byType.rows.length === 0) {
    console.log("\nNothing collected yet.\n");
    return;
  }

  console.log(`\n── missing fields, by source and property type ──\n`);
  let lastSource = "";
  for (const r of byType.rows) {
    const source = String(r.source);
    if (source !== lastSource) {
      console.log(`  ${source}`);
      lastSource = source;
    }
    const total = Number(r.total);
    const parts = FIELDS.map(([label]) => {
      const missing = pct(Number(r[label]), total);
      return `${label} ${String(missing).padStart(3)}%`;
    }).join("  ");
    console.log(`    ${String(r.type).padEnd(12)} n=${String(total).padStart(4)}   ${parts}`);
  }

  /**
   * Rooms on a plot of land are not a gap. Reporting them as one makes the
   * number look bad for a reason nobody can fix, and hides the rows where a
   * selector really did miss.
   */
  const habitable = await db.execute<Row>(
    sql.raw(`
      select s.key as source,
             count(*)::int as total,
             ${cols}
      from portal_listings l
      join portal_sources s on s.id = l.source_id
      where coalesce(l.property_type, '') not ilike '%terrain%'
        and coalesce(l.property_type, '') not ilike '%land%'
      group by 1
      order by 1
    `),
  );

  console.log(`\n── excluding land, where rooms and area do not apply ──\n`);
  for (const r of habitable.rows) {
    const total = Number(r.total);
    console.log(`  ${String(r.source).padEnd(14)} n=${String(total).padStart(4)}`);
    for (const [label] of FIELDS) {
      const missing = pct(Number(r[label]), total);
      console.log(`    ${label.padEnd(7)} ${bar(missing)} ${String(missing).padStart(3)}% missing`);
    }
    console.log();
  }

  /**
   * Split by the batch a row was first ingested in. After a parser fix, old
   * rows keep their old values until something makes them refresh — so a rate
   * that has not moved may mean the fix works and the sample is stale, which is
   * a very different problem from the fix not working.
   *
   * To the minute, not to the day. A daily granularity groups every run of an
   * afternoon's debugging into one line and answers nothing — which is exactly
   * what the first version of this did. In production, where runs are a day
   * apart, minute-level still gives one line per run.
   */
  const byBatch = await db.execute<Row>(
    sql.raw(`
      select s.key as source,
             date_trunc('minute', l.first_seen_at) as batch,
             count(*)::int as total,
             ${cols}
      from portal_listings l
      join portal_sources s on s.id = l.source_id
      group by 1, 2
      order by 1, 2
    `),
  );

  console.log(`── by ingest batch, to tell a stale sample from a broken parser ──\n`);
  for (const r of byBatch.rows) {
    const total = Number(r.total);
    const when = new Date(String(r.batch)).toISOString().slice(0, 16).replace("T", " ");
    const parts = FIELDS.map(([label]) => `${label} ${String(pct(Number(r[label]), total)).padStart(3)}%`).join("  ");
    console.log(`  ${String(r.source).padEnd(14)} ${when}  n=${String(total).padStart(4)}   ${parts}`);
  }
  console.log(
    `\nPercentages are MISSING, not present. A field that jumps between batches\n` +
      `is a parser change, not the market.\n`,
  );

  /**
   * A percentage says how much is broken; it never says what to look at. These
   * are the URLs to open — from the most recent batch only, because older rows
   * were parsed by older code and re-debugging them proves nothing.
   */
  await examples();
}

async function examples(): Promise<void> {
  console.log(`── most recent batch: rows still missing something ──\n`);

  for (const [label, col] of FIELDS) {
    const rows = await db.execute<Row>(
      sql.raw(`
        with latest as (
          select l.*, s.key as source,
                 max(date_trunc('minute', l.first_seen_at)) over (partition by l.source_id) as newest
          from portal_listings l
          join portal_sources s on s.id = l.source_id
        )
        select source, url, property_type
        from latest
        where date_trunc('minute', first_seen_at) = newest
          and ${col} is null
        order by source
        limit 3
      `),
    );

    if (rows.rows.length === 0) continue;
    console.log(`  ${label}:`);
    for (const r of rows.rows) {
      console.log(`    [${r.source}] ${r.property_type ?? "?"} — ${r.url}`);
    }
    console.log();
  }

  console.log(
    `Open one and read the markup before changing a selector. Every wrong fix in\n` +
      `this project so far came from guessing at a page nobody had looked at.\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Drizzle truncates the driver's message, which hides the one useful line
    // ("column X does not exist"). Dig the cause out rather than making the
    // next person re-run the query by hand in psql to find out what broke.
    const e = err as Error & { cause?: { message?: string; detail?: string; hint?: string } };
    console.error("\n[quality] failed:", e.cause?.message ?? e.message);
    if (e.cause?.detail) console.error("  detail:", e.cause.detail);
    if (e.cause?.hint) console.error("  hint:", e.cause.hint);
    console.error();
    process.exit(1);
  });
