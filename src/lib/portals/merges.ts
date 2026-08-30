import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * Is deduplication merging real duplicates, or collapsing the market?
 *
 *   npm run merges
 *
 * The one check worth running after every new source goes live, because
 * over-merging is the failure this pipeline is least able to notice on its own.
 * A property that wrongly swallows four others simply disappears from the
 * client's view, and the count that would have shown it — "3764 properties" —
 * goes DOWN, which reads as better deduplication rather than as lost stock.
 *
 * The signal is price. Two listings for the same villa agree on price to within
 * a rounding error, whatever else differs between portals; two different
 * properties that merged because their titles looked alike almost never do.
 * So a cluster with a wide price span is a merge to go and look at, and one
 * where every listing carries the same figure is almost certainly honest.
 *
 * Why this matters more with every source added: the matcher strips digits
 * before comparing titles — it has to, since portals round area and convert
 * price differently. Superimmo and SMC publish machine-generated titles
 * ("Vente maison 399 360 € 57,07 m² 3 pièces"), and once the digits are gone
 * every house on those portals reduces to the same handful of words. Price
 * coherence is what stands between that and a collapse.
 *
 * Read-only. Reports; changes nothing.
 */

/** Above this spread, a cluster is worth a human opening two tabs. */
const SUSPICIOUS_SPREAD = 0.1;

async function main(): Promise<void> {
  const clusters = await db.execute(sql`
    select
      p.id,
      count(*)::int                            as listings,
      count(distinct s.key)::int               as portals,
      min(l.price_eur)::bigint                 as min_price,
      max(l.price_eur)::bigint                 as max_price,
      min(l.commune_insee)                     as commune,
      min(l.title)                             as title
    from portal_listings l
    join portal_sources s on s.id = l.source_id
    join properties p on p.id = l.property_id
    where l.status = 'active' and l.price_eur is not null
    group by p.id
    having count(*) > 1
    order by count(*) desc
  `);

  const rows = clusters.rows as unknown as {
    id: string;
    listings: number;
    portals: number;
    min_price: string | number;
    max_price: string | number;
    commune: string | null;
    title: string | null;
  }[];

  const spread = (r: (typeof rows)[number]): number => {
    const lo = Number(r.min_price);
    const hi = Number(r.max_price);
    if (!lo || !hi) return 0;
    return (hi - lo) / hi;
  };

  const suspicious = rows.filter((r) => spread(r) > SUSPICIOUS_SPREAD);
  const biggest = rows.slice(0, 5);

  console.log(`\n── merged clusters ──`);
  console.log(`   ${rows.length} properties carry more than one active listing`);
  console.log(`   largest cluster: ${rows[0]?.listings ?? 0} listings`);

  console.log(`\n── the five largest ──`);
  for (const r of biggest) {
    const lo = Number(r.min_price).toLocaleString("fr-FR");
    const hi = Number(r.max_price).toLocaleString("fr-FR");
    const money = lo === hi ? `${lo} €` : `${lo} € … ${hi} €`;
    console.log(
      `   ×${String(r.listings).padStart(2)} on ${r.portals} portal(s)  ${money}` +
        `\n        ${(r.title ?? "").slice(0, 70)}  [${r.commune ?? "?"}]  ${r.id}`,
    );
  }

  console.log(`\n── price-incoherent clusters ──`);
  if (suspicious.length === 0) {
    console.log(
      `   none. Every merged cluster agrees on price to within ` +
        `${SUSPICIOUS_SPREAD * 100}%, which is what a genuine duplicate looks like.`,
    );
  } else {
    console.log(
      `   ${suspicious.length} cluster(s) where the cheapest and dearest listing ` +
        `disagree by more than ${SUSPICIOUS_SPREAD * 100}%.\n` +
        `   These are the ones to open against the live pages. A wide spread is\n` +
        `   not proof of a wrong merge — a portal may carry a stale price — but a\n` +
        `   correct merge rarely produces one.\n`,
    );
    for (const r of suspicious.slice(0, 20)) {
      const lo = Number(r.min_price).toLocaleString("fr-FR");
      const hi = Number(r.max_price).toLocaleString("fr-FR");
      console.log(
        `   ×${String(r.listings).padStart(2)}  ${lo} € → ${hi} €  ` +
          `(+${(spread(r) * 100).toFixed(0)}%)  [${r.commune ?? "?"}]  ${r.id}`,
      );
      console.log(`        ${(r.title ?? "").slice(0, 70)}`);
    }
    if (suspicious.length > 20) console.log(`   … and ${suspicious.length - 20} more`);
  }

  console.log(
    `\n   Open a suspicious one at /listings/<id> and compare it with the live\n` +
      `   pages. Wrong-but-plausible is the failure mode that survives longest.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
