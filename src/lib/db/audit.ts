import { sql } from "drizzle-orm";
import { dbErrorMessage } from "./errors";
import { db } from "./client";

/**
 * The numbers behind the client's open questions, read straight off the
 * database — nothing here writes.
 *
 *   npm run db:audit
 *
 * Written 2026-09-24 because the four Slack points that need a figure rather
 * than an argument (rentals in the sale pool, listings without a commune,
 * which portals have stopped delivering new listings, whether the picture
 * fixes need a reparse) could not be answered from the code alone, and the
 * database is reachable only from this machine. One command, paste the
 * output, done.
 *
 * Every block prints its own SQL question in plain words first, so the output
 * reads on its own a week later.
 */

type Row = Record<string, unknown>;

const pad = (v: unknown, n: number) => String(v ?? "").padStart(n);

async function block(title: string, query: ReturnType<typeof sql>): Promise<Row[]> {
  console.log(`\n── ${title}`);
  const r = await db.execute<Row>(query);
  if (r.rows.length === 0) {
    console.log("   (no rows)");
    return [];
  }
  const cols = Object.keys(r.rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...r.rows.map((row) => String(row[c] ?? "").length)),
  );
  console.log("   " + cols.map((c, i) => pad(c, widths[i])).join("  "));
  for (const row of r.rows) {
    console.log("   " + cols.map((c, i) => pad(row[c], widths[i])).join("  "));
  }
  return r.rows;
}

async function main(): Promise<void> {
  const w = await db.execute<Row>(sql`select current_database() db, now()::text t`);
  console.log(`\naudit of ${w.rows[0]?.db} at ${w.rows[0]?.t}`);

  await block(
    "0. Listings by portal and status — the baseline every figure below is a share of",
    sql`
      select s.key as portal, l.status, count(*)::int as n
      from portal_listings l join portal_sources s on s.id = l.source_id
      group by 1, 2 order by 1, 2
    `,
  );

  await block(
    "1. Portal health — last run per portal, and when it last produced a NEW listing",
    sql`
      select s.key as portal, s.enabled,
             (select r.status from portal_runs r where r.source_id = s.id
               order by r.started_at desc limit 1) as last_run,
             (select r.started_at::date::text from portal_runs r where r.source_id = s.id
               order by r.started_at desc limit 1) as last_run_on,
             (select r.started_at::date::text from portal_runs r
               where r.source_id = s.id and r.status in ('done','ok','partial')
               order by r.started_at desc limit 1) as last_good_on,
             max(l.first_seen_at)::date::text as last_new_listing,
             count(*) filter (where l.first_seen_at >= now() - interval '7 days')::int  as new_7d,
             count(*) filter (where l.first_seen_at >= now() - interval '30 days')::int as new_30d
      from portal_sources s left join portal_listings l on l.source_id = s.id
      group by s.id, s.key, s.enabled order by s.key
    `,
  );

  await block(
    "2. Rentals sitting in the sale pool (JamesEdition /for-rent-, Figaro /location-vacances/, and any title that says rent/louer)",
    sql`
      select s.key as portal, l.status,
             count(*) filter (where l.url ~* '/for-rent-')::int            as je_for_rent_url,
             count(*) filter (where l.url ~* '/location-vacances/')::int   as figaro_holiday_url,
             count(*) filter (where l.title ~* '\\m(for rent|à louer|a louer|location saisonni|seasonal rental)\\M')::int as rent_in_title,
             count(*) filter (where l.url ~* '/for-rent-|/location-vacances/'
                                 or l.title ~* '\\m(for rent|à louer|a louer|location saisonni|seasonal rental)\\M')::int as any_signal
      from portal_listings l join portal_sources s on s.id = l.source_id
      group by 1, 2 having count(*) filter (where l.url ~* '/for-rent-|/location-vacances/'
                                 or l.title ~* '\\m(for rent|à louer|a louer|location saisonni|seasonal rental)\\M') > 0
      order by 1, 2
    `,
  );

  await block(
    "2b. Sample of those rentals — url + price, to eyeball before anything is touched",
    sql`
      select s.key as portal, l.status, l.price_eur, left(l.url, 90) as url
      from portal_listings l join portal_sources s on s.id = l.source_id
      where l.url ~* '/for-rent-|/location-vacances/'
         or l.title ~* '\\m(for rent|à louer|a louer|location saisonni|seasonal rental)\\M'
      order by s.key, l.price_eur desc nulls last limit 15
    `,
  );

  await block(
    "3. Listings with NO commune (commune_insee null) — these cannot be matched or shown per commune",
    sql`
      select s.key as portal, l.status, count(*)::int as n,
             count(*) filter (where l.commune_raw is not null)::int as has_raw_name,
             count(*) filter (where l.property_id is not null)::int as attached_to_property
      from portal_listings l join portal_sources s on s.id = l.source_id
      where l.commune_insee is null
      group by 1, 2 order by 3 desc
    `,
  );

  await block(
    "3b. What commune_raw those null-INSEE rows carry (top 20) — tells us whether it is a mapping gap or a parse gap",
    sql`
      select s.key as portal, coalesce(l.commune_raw, '<null>') as commune_raw, count(*)::int as n
      from portal_listings l join portal_sources s on s.id = l.source_id
      where l.commune_insee is null and l.status = 'active'
      group by 1, 2 order by 3 desc limit 20
    `,
  );

  await block(
    "4. Green-Acres rooms/bedrooms null — the lines dropped on 2026-09-05; split by whether the row was (re)read after that date",
    sql`
      select l.status,
             case when l.updated_at >= '2026-09-05' then 'touched since 09-05' else 'untouched since' end as period,
             count(*)::int as n,
             count(*) filter (where l.rooms is null)::int as rooms_null,
             count(*) filter (where l.bedrooms is null)::int as bedrooms_null
      from portal_listings l join portal_sources s on s.id = l.source_id
      where s.key = 'green-acres'
      group by 1, 2 order by 1, 2
    `,
  );

  await block(
    "5. Cover photo vs gallery — rows where the cover is not gallery[0] byte-for-byte (the duplicate-photo cause); sized per portal for the reparse",
    sql`
      select s.key as portal, count(*)::int as active,
             count(*) filter (where l.image_url is null)::int as no_cover,
             count(*) filter (where cardinality(l.image_urls) = 0)::int as no_gallery,
             count(*) filter (where l.image_url is not null and cardinality(l.image_urls) > 0
                                and l.image_url <> l.image_urls[1])::int as cover_not_first,
             count(*) filter (where cardinality(l.image_urls) > 0
                                and (select count(distinct u) from unnest(l.image_urls) u) < cardinality(l.image_urls))::int as gallery_has_dupes,
             count(*) filter (where exists (select 1 from unnest(l.image_urls) u where u like '%/miniPhotos/%'))::int as has_thumbnails
      from portal_listings l join portal_sources s on s.id = l.source_id
      where l.status = 'active'
      group by 1 order by 1
    `,
  );

  await block(
    "6. JamesEdition images — how many rows have a cover, and 5 URLs to open in a browser",
    sql`
      select l.status, count(*)::int as n,
             count(*) filter (where l.image_url is not null)::int as with_cover,
             count(*) filter (where cardinality(l.image_urls) > 0)::int as with_gallery,
             (array_agg(l.image_url) filter (where l.image_url is not null))[1:5] as sample_covers
      from portal_listings l join portal_sources s on s.id = l.source_id
      where s.key = 'jamesedition'
      group by 1
    `,
  );

  await block(
    "7. Properties (merged view the client sees) — how many, how many without a commune, how many with more than one source",
    sql`
      select status, count(*)::int as n,
             count(*) filter (where commune_insee is null)::int as no_commune,
             count(*) filter (where source_count > 1)::int as multi_source,
             count(*) filter (where image_url is null)::int as no_cover
      from properties group by 1 order by 1
    `,
  );

  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[db:audit] failed:", dbErrorMessage(err));
    process.exit(1);
  });
