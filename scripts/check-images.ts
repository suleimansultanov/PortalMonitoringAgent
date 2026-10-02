import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * What image URLs does a source store, and do they load? Read-only.
 *   npx tsx scripts/check-images.ts bienici
 * Written 2026-10-02 when Bien'ici cards showed broken images on the client app.
 */
const key = process.argv[2] ?? "bienici";
const rows = await db.execute<{ title: string | null; image_url: string | null; n: number }>(sql`
  select l.title, l.image_url, cardinality(l.image_urls)::int as n
  from portal_listings l join portal_sources s on s.id = l.source_id
  where s.key = ${key} and l.status = 'active'
  order by l.first_seen_at desc limit 6
`);
const hosts = await db.execute<{ host: string; n: number }>(sql`
  select substring(l.image_url from '^https?://([^/]+)') as host, count(*)::int as n
  from portal_listings l join portal_sources s on s.id = l.source_id
  where s.key = ${key} and l.status = 'active' group by 1 order by 2 desc
`);
console.log(`\n${key}: cover hosts`);
for (const h of hosts.rows) console.log(`  ${String(h.n).padStart(5)}  ${h.host ?? "(no cover)"}`);
console.log("\nnewest six, each URL fetched now:");
for (const r of rows.rows) {
  let status = "no url";
  if (r.image_url) {
    try {
      const res = await fetch(r.image_url, { method: "GET", redirect: "follow" });
      status = `${res.status} ${res.headers.get("content-type") ?? ""}`;
    } catch (e) {
      status = `error ${(e as Error).message}`;
    }
  }
  console.log(`  ${(r.title ?? "").slice(0, 40).padEnd(40)} gallery ${String(r.n).padStart(2)}  ${status}`);
  console.log(`     ${r.image_url}`);
}
process.exit(0);
