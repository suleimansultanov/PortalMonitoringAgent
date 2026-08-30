import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * How much would one more portal actually add?
 *
 *   npm run coverage
 *
 * The question this answers is not "how many portals do we read" but "how much
 * of the gulf's stock do we see", and those are different questions with
 * different answers. Agencies list the same property on several portals at
 * once — 1194 of ours already appear on more than one — so a portal we cannot
 * reach may be carrying nothing we do not already have.
 *
 * The number that matters is at the bottom: agencies whose stock reaches us
 * through exactly ONE source. Those are the properties that would vanish if
 * that source broke, and the shape of what an unreachable portal might hold.
 *
 * A portal is a door into one room, not a room of its own. Counting doors is
 * not the same as measuring the room.
 *
 * Read-only.
 */

async function main(): Promise<void> {
  const perSource = await db.execute(sql`
    select
      s.key,
      count(distinct l.agency_id)::int as agencies,
      count(*)::int                    as listings
    from portal_listings l
    join portal_sources s on s.id = l.source_id
    where l.status = 'active' and l.agency_id is not null
    group by s.key
    order by count(distinct l.agency_id) desc
  `);

  /** Agencies reaching us through exactly one source, and which one. */
  const exclusive = await db.execute(sql`
    with reach as (
      select l.agency_id, count(distinct l.source_id)::int as sources, min(s.key) as only_source
      from portal_listings l
      join portal_sources s on s.id = l.source_id
      where l.status = 'active' and l.agency_id is not null
      group by l.agency_id
    )
    select only_source, count(*)::int as agencies
    from reach where sources = 1
    group by only_source order by count(*) desc
  `);

  const totals = await db.execute(sql`
    select
      count(distinct l.agency_id)::int as agencies,
      count(*)::int                    as listings
    from portal_listings l
    where l.status = 'active' and l.agency_id is not null
  `);

  const t = (totals.rows as unknown as { agencies: number; listings: number }[])[0];

  console.log(`\n── what each source brings ──`);
  for (const r of perSource.rows as unknown as { key: string; agencies: number; listings: number }[]) {
    console.log(`   ${r.key.padEnd(14)} ${String(r.agencies).padStart(4)} agencies  ${String(r.listings).padStart(5)} listings`);
  }

  console.log(`\n── agencies we would lose with a source ──`);
  const ex = exclusive.rows as unknown as { only_source: string; agencies: number }[];
  if (ex.length === 0) {
    console.log(`   none — every agency reaches us through at least two sources`);
  }
  for (const r of ex) {
    const share = ((r.agencies / t.agencies) * 100).toFixed(0);
    console.log(`   ${r.only_source.padEnd(14)} ${String(r.agencies).padStart(4)} agencies seen nowhere else  (${share}% of all)`);
  }

  console.log(
    `\n   ${t.agencies} agencies, ${t.listings} active listings in total.\n\n` +
      `   Read it this way: a source with few exclusive agencies is one whose\n` +
      `   stock reaches us anyway, and an unreachable portal is most likely the\n` +
      `   same — the agencies are the market, the portals are just windows onto it.\n` +
      `   A source with many is a single point of failure worth knowing about.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
