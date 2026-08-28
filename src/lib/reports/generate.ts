import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clients, marketReports, portalSources } from "@/lib/db/schema";
import { COMMUNE_LABELS } from "@/lib/api/queries";

/**
 * Freeze the market for a period into one report row.
 *
 *   npm run report                      the month just ended
 *   npm run report -- --month=2026-07   a specific month
 *   npm run report -- --current         month to date, for a look before the 1st
 *
 * WHAT A REPORT IS, AND IS NOT
 *
 * It is what we could see, at the coverage we had, on the day it was written.
 * That is a narrower claim than "the market in June", and the difference is
 * recorded rather than glossed over: `coverage` stores how many communes had
 * been crawled and which sources were enabled, and `warnings` says out loud when
 * a comparison would be misleading.
 *
 * Without that, the first month-on-month chart is a trap. Switch a portal on
 * between two runs and the second month shows a market that "grew 40%", which is
 * a fact about us rather than about the Var.
 *
 * WHERE THE NUMBERS COME FROM
 *
 * Counts of what happened DURING the period come from `portal_listing_events`,
 * which is append-only precisely so this is possible after the fact. State — how
 * many are active, the median price — is read from `properties` as it stands
 * now, which is exact for the month just ended and approximate for older ones.
 * The report says which is which.
 */

export type GenerateArgs = {
  clientSlug?: string;
  /** "2026-07". Defaults to the month that has just ended. */
  month?: string;
  /** Month-to-date instead of a completed month. */
  current?: boolean;
};

function monthBounds(month: string | undefined, current: boolean): {
  start: Date;
  end: Date;
  label: string;
} {
  const now = new Date();
  let year: number;
  let m: number;

  if (month) {
    const [y, mm] = month.split("-").map(Number);
    year = y;
    m = mm - 1;
  } else if (current) {
    year = now.getUTCFullYear();
    m = now.getUTCMonth();
  } else {
    // The month just ended — what you want on the 1st.
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    year = prev.getUTCFullYear();
    m = prev.getUTCMonth();
  }

  const start = new Date(Date.UTC(year, m, 1));
  const end = current
    ? now
    : new Date(Date.UTC(year, m + 1, 1));

  const label =
    new Date(Date.UTC(year, m, 1)).toLocaleString("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }) + (current ? " (to date)" : "");

  return { start, end, label };
}

export async function generateReport(args: GenerateArgs = {}): Promise<void> {
  const slug = args.clientSlug ?? "med-estates";
  const [client] = await db.select().from(clients).where(eq(clients.slug, slug)).limit(1);
  if (!client) throw new Error(`Client ${slug} not found — run \`npm run db:seed\` first.`);

  const { start, end, label } = monthBounds(args.month, args.current ?? false);
  console.log(`\nGenerating ${label} for ${client.name}…`);

  // ── What happened during the period ──────────────────────────────────────
  const [{ rows: eventRows }] = [
    await db.execute<{ type: string; n: number }>(sql`
      select e.type, count(*)::int as n
      from portal_listing_events e
      where e.occurred_at >= ${start} and e.occurred_at < ${end}
      group by e.type
    `),
  ];
  const eventCount = (t: string) => Number(eventRows.find((r) => r.type === t)?.n ?? 0);

  const [{ rows: cutRows }] = [
    await db.execute<{ n: number }>(sql`
      select count(*)::int as n
      from portal_listing_events e
      where e.type = 'price_changed'
        and e.price_to < e.price_from
        and e.occurred_at >= ${start} and e.occurred_at < ${end}
    `),
  ];

  // ── State, per commune ───────────────────────────────────────────────────
  const [{ rows: communeRows }] = [
    await db.execute<{
      commune_insee: string;
      active: number;
      median_price: string | null;
      median_ppm2: string | null;
      median_dom: string | null;
      new_in_period: number;
    }>(sql`
      select
        p.commune_insee,
        count(*) filter (where p.status = 'active')::int as active,
        percentile_cont(0.5) within group (order by p.price_eur)
          filter (where p.price_eur is not null) as median_price,
        percentile_cont(0.5) within group (
          order by p.price_eur / nullif(p.area_m2::numeric, 0)
        ) filter (where p.price_eur is not null and p.area_m2 is not null) as median_ppm2,
        percentile_cont(0.5) within group (
          order by extract(epoch from (coalesce(p.delisted_at, now()) - p.first_listed_at)) / 86400
        ) filter (where p.first_listed_at is not null) as median_dom,
        count(*) filter (
          where p.first_listed_at >= ${start} and p.first_listed_at < ${end}
        )::int as new_in_period
      from properties p
      where p.commune_insee is not null
      group by p.commune_insee
      order by active desc
    `),
  ];

  const communes = communeRows.map((r) => ({
    insee: r.commune_insee,
    label: COMMUNE_LABELS[r.commune_insee] ?? r.commune_insee,
    active: Number(r.active),
    newInPeriod: Number(r.new_in_period),
    medianPriceEur: r.median_price === null ? null : Math.round(Number(r.median_price)),
    medianPricePerM2: r.median_ppm2 === null ? null : Math.round(Number(r.median_ppm2)),
    medianDaysOnMarket: r.median_dom === null ? null : Math.round(Number(r.median_dom)),
  }));

  // ── Agencies ─────────────────────────────────────────────────────────────
  const [{ rows: agencyRows }] = [
    await db.execute<{
      id: string;
      name: string;
      active: number;
      median_price: string | null;
    }>(sql`
      select a.id, a.name, count(*)::int as active,
             percentile_cont(0.5) within group (order by p.price_eur) as median_price
      from properties p
      join portal_agencies a on a.id = p.agency_id
      where p.status = 'active'
      group by a.id, a.name
      order by active desc
      limit 25
    `),
  ];

  const agencies = agencyRows.map((r) => ({
    id: r.id,
    name: r.name,
    active: Number(r.active),
    medianPriceEur: r.median_price === null ? null : Math.round(Number(r.median_price)),
  }));

  /**
   * Movements — the individual price cuts worth reading.
   *
   * A count of "19 price cuts" is a statistic. WHICH villa, by how much, and by
   * whom is the thing an agent can act on, and it is the part a portal cannot
   * show them because a portal only shows today's number.
   */
  const [{ rows: movementRows }] = [
    await db.execute<{
      property_id: string;
      title: string | null;
      commune_insee: string | null;
      price_from: number | null;
      price_to: number | null;
      occurred_at: Date;
      agency: string | null;
    }>(sql`
      select e.property_id, p.title, p.commune_insee,
             e.price_from, e.price_to, e.occurred_at, a.name as agency
      from portal_listing_events e
      join properties p on p.id = e.property_id
      left join portal_agencies a on a.id = p.agency_id
      where e.type = 'price_changed'
        and e.price_to < e.price_from
        and e.occurred_at >= ${start} and e.occurred_at < ${end}
      order by (e.price_from - e.price_to) desc
      limit 20
    `),
  ];

  const movements = movementRows.map((r) => ({
    propertyId: r.property_id,
    title: r.title,
    commune: r.commune_insee ? (COMMUNE_LABELS[r.commune_insee] ?? r.commune_insee) : null,
    agency: r.agency,
    priceFrom: r.price_from,
    priceTo: r.price_to,
    pctChange:
      r.price_from && r.price_to
        ? Math.round(((r.price_to - r.price_from) / r.price_from) * 100)
        : null,
    occurredAt: r.occurred_at,
  }));

  // ── Coverage, recorded so the report can be read honestly later ──────────
  const sources = await db.select().from(portalSources);
  const communesWithStock = communes.filter((c) => c.active > 0).length;
  const totalCommunes = client.communeInsee.length;

  const coverage = {
    communesWatched: totalCommunes,
    communesWithStock,
    sourcesEnabled: sources.filter((s) => s.enabled).map((s) => s.key),
    sourcesIdle: sources.filter((s) => !s.enabled).map((s) => s.key),
    generatedFrom: args.current ? "month to date" : "completed month",
  };

  const warnings: string[] = [];
  if (communesWithStock < totalCommunes) {
    warnings.push(
      `${communesWithStock} of ${totalCommunes} communes had any stock collected. ` +
        `Comparisons between communes reflect our coverage as much as the market.`,
    );
  }
  if (coverage.sourcesIdle.length > 0) {
    warnings.push(
      `Sources not collecting: ${coverage.sourcesIdle.join(", ")}. Every count here ` +
        `is an undercount, and switching one on later will look like market growth.`,
    );
  }
  warnings.push(
    `Days on market count from our first sighting except on Superimmo, so they are ` +
      `a floor rather than a measurement.`,
  );
  if (args.current) {
    warnings.push(`This month is not finished — the figures will change.`);
  }

  const allPrices = communes.map((c) => c.medianPriceEur).filter((x): x is number => x !== null);
  const median = (xs: number[]) =>
    xs.length === 0 ? null : xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const values = {
    clientId: client.id,
    kind: args.current ? "adhoc" : "monthly",
    periodStart: start,
    periodEnd: end,
    label,
    activeCount: communes.reduce((n, c) => n + c.active, 0),
    newCount: eventCount("listed"),
    delistedCount: eventCount("delisted"),
    priceCutCount: Number(cutRows[0]?.n ?? 0),
    medianPriceEur: median(allPrices),
    medianPricePerM2: median(
      communes.map((c) => c.medianPricePerM2).filter((x): x is number => x !== null),
    ),
    medianDaysOnMarket: median(
      communes.map((c) => c.medianDaysOnMarket).filter((x): x is number => x !== null),
    ),
    communes,
    agencies,
    movements,
    coverage,
    warnings,
    generatedAt: new Date(),
  };

  await db
    .insert(marketReports)
    .values(values)
    // Regenerating a month replaces it rather than stacking a second copy.
    .onConflictDoUpdate({
      target: [marketReports.clientId, marketReports.kind, marketReports.periodStart],
      set: values,
    });

  console.log(`  ${values.activeCount} active · ${values.newCount} new · ${values.priceCutCount} price cuts`);
  console.log(`  ${communesWithStock}/${totalCommunes} communes covered`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  console.log(`\nSaved. Visible at /reports\n`);
}

if (process.argv[1]?.endsWith("generate.ts")) {
  const get = (n: string) =>
    process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
  generateReport({ month: get("month"), current: process.argv.includes("--current") })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[report] failed:", (err as Error).message);
      process.exit(1);
    });
}
