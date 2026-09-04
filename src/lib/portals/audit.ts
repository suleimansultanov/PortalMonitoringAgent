import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * Data that is wrong while looking right.
 *
 *   npm run audit
 *
 * `sanity` catches the impossible — twenty trillion euros, half a square metre.
 * Those are easy, and they are not the ones that reach a client's report. What
 * reaches a report is the plausible: a villa whose "floor area" is the size of
 * its garden, a price recorded as halving overnight because a portal changed
 * its markup, a listing still shown as for sale six weeks after it vanished.
 *
 * Every check below is a question about DISAGREEMENT rather than about a
 * threshold, because disagreement is the only thing we can measure without a
 * second source of truth: the portals against each other, one row against the
 * commune around it, today against last week.
 *
 * Read-only. It reports; it changes nothing. Some of what it lists will be
 * correct data — an outlier is a question, not a verdict.
 */

const LAND = "(l.property_type ilike '%terrain%' or l.property_type ilike '%land%')";

async function main(): Promise<void> {
  // ── 1. Floor area that is really the garden ─────────────────────────────
  /**
   * The failure this was written for. "Villa T3 sur 2168 m² de terrain" was
   * stored with a floor area of 2168, and every price-per-m² figure derived
   * from it is wrong by a factor of twenty — silently, because 2168 is a
   * perfectly ordinary number.
   */
  const gardens = await db.execute(sql`
    select s.key as source, count(*)::int as n
      from portal_listings l
      join portal_sources s on s.id = l.source_id
     where l.status = 'active'
       and not ${sql.raw(LAND)}
       and l.area_m2 is not null
       and (
         l.area_m2 = l.land_m2
         or (l.title ~* ('(sur|de)[^0-9]{0,12}' || floor(l.area_m2)::text || '[^0-9]{0,4}m'))
       )
     group by s.key
     order by n desc
  `);

  // ── 2. A price per square metre unlike its neighbours ───────────────────
  /**
   * Compared against the commune's own median rather than a constant: 8000 €/m²
   * is unremarkable in Sainte-Maxime and absurd in La Garde-Freinet, and a
   * single threshold would either miss the second or drown in the first.
   */
  const outliers = await db.execute(sql`
    with dwellings as (
      select l.id, l.commune_insee, s.key as source, l.title, l.url,
             l.price_eur, l.area_m2,
             (l.price_eur / nullif(l.area_m2, 0))::numeric as ppm
        from portal_listings l
        join portal_sources s on s.id = l.source_id
       where l.status = 'active'
         and not ${sql.raw(LAND)}
         and l.price_eur is not null
         and l.area_m2 is not null
         and l.area_m2 > 0
    ),
    medians as (
      select commune_insee,
             percentile_cont(0.5) within group (order by ppm) as med
        from dwellings
       group by commune_insee
      having count(*) >= 10
    )
    select d.source, d.commune_insee, d.price_eur, d.area_m2,
           round(d.ppm)::int as ppm, round(m.med)::int as commune_median,
           d.title, d.url
      from dwellings d
      join medians m using (commune_insee)
     where d.ppm > m.med * 6 or d.ppm < m.med / 6
     order by d.ppm desc
     limit 20
  `);

  // ── 3. Portals that disagree inside one merged property ─────────────────
  /**
   * After deduplication every listing under a property is supposed to be the
   * same home. Where the portals disagree about its SIZE by more than rounding,
   * either the merge is wrong or one portal is — and both are worth knowing,
   * because this is the disagreement a client notices first.
   */
  const disagreements = await db.execute(sql`
    select p.id,
           p.commune_insee,
           count(*)::int                                  as listings,
           min(l.area_m2)::numeric                        as min_area,
           max(l.area_m2)::numeric                        as max_area,
           round(100 * (max(l.area_m2) - min(l.area_m2)) / nullif(max(l.area_m2), 0))::int as spread_pct,
           min(p.title)                                   as title
      from properties p
      join portal_listings l on l.property_id = p.id and l.status = 'active'
     where p.status = 'active' and l.area_m2 is not null
     group by p.id, p.commune_insee
    having count(*) > 1
       and (max(l.area_m2) - min(l.area_m2)) / nullif(max(l.area_m2), 0) > 0.05
     order by spread_pct desc
     limit 15
  `);

  // ── 4. Still "for sale" long after anyone last saw it ───────────────────
  /**
   * A listing is marked delisted when a pass looks for it and it is gone. If a
   * source stops being collected — a block, a broken adapter, a portal we lost
   * access to — nothing looks, so nothing is ever marked, and its whole stock
   * silently ages into fiction while the product keeps showing it as available.
   */
  const stale = await db.execute(sql`
    select s.key as source,
           count(*)::int as active,
           max(l.last_seen_at)::date as last_seen
      from portal_listings l
      join portal_sources s on s.id = l.source_id
     where l.status = 'active'
     group by s.key
    having max(l.last_seen_at) < now() - interval '7 days'
     order by last_seen
  `);

  // ── 5. Price changes too large to be repricing ──────────────────────────
  /**
   * An agency cuts a price by five or ten per cent. A price that halves or
   * doubles overnight is usually a portal changing its markup and an adapter
   * reading a different number — and unlike a wrong price sitting still, this
   * one is written into the history that every metric derives from.
   */
  const jumps = await db.execute(sql`
    select s.key as source,
           e.occurred_at::date as day,
           e.price_from, e.price_to,
           l.url
      from portal_listing_events e
      join portal_listings l on l.id = e.listing_id
      join portal_sources s on s.id = e.source_id
     where e.type = 'price_changed'
       and e.price_from is not null and e.price_to is not null
       and e.occurred_at > now() - interval '30 days'
       and (
         e.price_to > e.price_from * 1.6 or e.price_to < e.price_from * 0.625
       )
     order by e.occurred_at desc
     limit 15
  `);

  // ── 6. One price, one commune, two properties ───────────────────────────
  /**
   * THE REVIEW QUEUE.
   *
   * An identical price is the strongest hint the data offers. Two listings in
   * one commune priced the same to the euro are usually one property — that is
   * the whole basis of the matcher — so when they end up as two, either the
   * measurements genuinely disagree (two flats in one development, two villas
   * at a round number) or we have just split a property in half.
   *
   * The matcher cannot tell those apart, and it should not guess: it splits,
   * because a visible duplicate is recoverable and a hidden property is not.
   * But it also should not stay quiet about it. Everything here is a pair worth
   * ten seconds and two browser tabs, and the column that differs says where to
   * look.
   *
   * Same-source pairs are excluded: one portal carrying two listings at one
   * price is ordinary — a development, or an agency's stock — and it would bury
   * the cross-portal pairs, which are the interesting ones.
   */
  const review = await db.execute(sql`
    with priced as (
      select l.id, l.property_id, l.commune_insee, l.price_eur, l.area_m2,
             l.land_m2, l.property_type, s.key as source, l.title, l.url
        from portal_listings l
        join portal_sources s on s.id = l.source_id
       where l.status = 'active' and l.price_eur is not null
    )
    select a.commune_insee,
           a.price_eur,
           a.source          as source_a,
           a.area_m2         as area_a,
           a.land_m2         as land_a,
           a.url             as url_a,
           b.source          as source_b,
           b.area_m2         as area_b,
           b.land_m2         as land_b,
           b.url             as url_b,
           coalesce(a.property_type, '—') as type_a,
           a.title
      from priced a
      join priced b
        on b.commune_insee = a.commune_insee
       and b.price_eur = a.price_eur
       and b.source <> a.source
       and b.property_id is distinct from a.property_id
       and b.id > a.id
     order by a.price_eur desc
     limit 25
  `);

  // ── 7. Listings from outside the communes we watch ──────────────────────
  const strays = await db.execute(sql`
    select s.key as source, count(*)::int as n
      from portal_listings l
      join portal_sources s on s.id = l.source_id
     where l.status = 'active' and l.commune_insee is null
     group by s.key
     order by n desc
  `);

  section("FLOOR AREA THAT IS PROBABLY THE GARDEN", gardens.rows as Row[], (r) =>
    `  ${String(r.source).padEnd(14)} ${r.n} listing(s)`,
  );

  section("PRICE PER m² UNLIKE THE COMMUNE AROUND IT", outliers.rows as Row[], (r) =>
    `  ${String(r.source).padEnd(14)} ${String(r.ppm).padStart(9)} €/m²  ` +
      `(commune median ${r.commune_median})  ${r.price_eur} € / ${r.area_m2} m²\n` +
      `                 ${String(r.title ?? "").slice(0, 90)}\n                 ${r.url}`,
  );

  section("PORTALS DISAGREEING ABOUT ONE PROPERTY'S SIZE", disagreements.rows as Row[], (r) =>
    `  ${r.commune_insee}  ${r.listings} listings  ${r.min_area}–${r.max_area} m² ` +
      `(${r.spread_pct}% apart)  ${String(r.title ?? "").slice(0, 70)}\n                 /listings/${r.id}`,
  );

  section("SOURCES NOBODY HAS SEEN IN A WEEK", stale.rows as Row[], (r) =>
    `  ${String(r.source).padEnd(14)} ${r.active} listing(s) still marked active, last seen ${r.last_seen}`,
  );

  section("PRICE CHANGES TOO LARGE TO BE REPRICING", jumps.rows as Row[], (r) =>
    `  ${String(r.source).padEnd(14)} ${r.day}  ${r.price_from} € → ${r.price_to} €\n                 ${r.url}`,
  );

  section(
    "ONE PRICE, ONE COMMUNE, TWO PROPERTIES — WORTH TEN SECONDS EACH",
    review.rows as Row[],
    (r) =>
      `  ${r.commune_insee}  ${Number(r.price_eur).toLocaleString("fr-FR")} €  ${r.type_a}\n` +
      `     ${String(r.source_a).padEnd(14)} ${String(r.area_a ?? "—").padStart(8)} m²  ` +
      `land ${String(r.land_a ?? "—").padStart(7)}   ${r.url_a}\n` +
      `     ${String(r.source_b).padEnd(14)} ${String(r.area_b ?? "—").padStart(8)} m²  ` +
      `land ${String(r.land_b ?? "—").padStart(7)}   ${r.url_b}`,
  );

  section("ACTIVE LISTINGS WITH NO COMMUNE RESOLVED", strays.rows as Row[], (r) =>
    `  ${String(r.source).padEnd(14)} ${r.n} listing(s)`,
  );

  console.log(
    "\nNothing here is proof of a fault. Each line is a question — the answer is\n" +
      "on the portal's own page, and `npm run cluster -- <id>` opens the third one.\n",
  );
  process.exit(0);
}

type Row = Record<string, unknown>;

function section(title: string, rows: Row[], render: (r: Row) => string): void {
  console.log(`\n── ${title} ──`);
  if (rows.length === 0) {
    console.log("  nothing");
    return;
  }
  for (const r of rows) console.log(render(r));
}

void main();
