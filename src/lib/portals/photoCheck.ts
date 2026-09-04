import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * Where do the photographs stop?
 *
 *   npm run photos:check
 *
 * A property showing one picture can be one of three different faults, and they
 * have three different fixes:
 *
 *   1. The ADAPTER never collected a gallery → the portal's parser.
 *   2. The listings have galleries but the PROPERTIES do not → `npm run resolve`,
 *      which is what copies the richest gallery of a cluster onto the property.
 *   3. Both are full here → the fault is downstream, in the client's own copy.
 *
 * Guessing between them costs a re-seed and an afternoon. Two counts settle it.
 *
 * Read-only.
 *
 * `image_urls` is a Postgres `text[]` here, not jsonb — `array_length`, not
 * `jsonb_array_length`. Worth writing down: the client's copy of the same
 * column IS jsonb, because it arrives over JSON, and a query written for one
 * fails against the other.
 */

async function main(): Promise<void> {
  const listings = await db.execute(sql`
    select s.key                                                              as source,
           count(*)::int                                                      as listings,
           count(*) filter (where coalesce(array_length(l.image_urls, 1), 0) > 1)::int as with_gallery,
           max(coalesce(array_length(l.image_urls, 1), 0))::int                as most
    from portal_listings l
    join portal_sources s on s.id = l.source_id
    where l.status = 'active'
    group by s.key
    order by s.key
  `);

  const props = await db.execute(sql`
    select count(*)::int                                                      as properties,
           count(*) filter (where coalesce(array_length(image_urls, 1), 0) > 1)::int as with_gallery,
           max(coalesce(array_length(image_urls, 1), 0))::int                  as most
    from properties
    where status = 'active'
  `);

  console.log("\nLISTINGS — what the adapters collected");
  for (const r of listings.rows as Record<string, unknown>[]) {
    console.log(
      `  ${String(r.source).padEnd(16)} ${String(r.listings).padStart(6)} active   ` +
        `${String(r.with_gallery).padStart(6)} with a gallery   biggest ${r.most}`,
    );
  }

  const p = (props.rows as Record<string, unknown>[])[0];
  console.log("\nPROPERTIES — what the API serves and the client copies");
  console.log(
    `  ${String(p.properties).padStart(6)} active   ` +
      `${String(p.with_gallery).padStart(6)} with a gallery   biggest ${p.most}`,
  );
  console.log(
    "\nIf the listings have galleries and the properties do not, `npm run resolve`\n" +
      "is the fix: the gallery is copied onto the property there, nowhere else.\n",
  );
  process.exit(0);
}

void main();
