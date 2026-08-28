import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clients, marketReports } from "@/lib/db/schema";

/** Reads for the Reports screens. Frozen snapshots, never recomputed. */

export type ReportCommune = {
  insee: string;
  label: string;
  active: number;
  newInPeriod: number;
  medianPriceEur: number | null;
  medianPricePerM2: number | null;
  medianDaysOnMarket: number | null;
};

export type ReportMovement = {
  propertyId: string;
  title: string | null;
  commune: string | null;
  agency: string | null;
  priceFrom: number | null;
  priceTo: number | null;
  pctChange: number | null;
  occurredAt: string;
};

export type ReportAgency = {
  id: string;
  name: string;
  active: number;
  medianPriceEur: number | null;
};

export type ReportRow = {
  id: string;
  kind: string;
  label: string;
  periodStart: Date;
  periodEnd: Date;
  activeCount: number;
  newCount: number;
  delistedCount: number;
  priceCutCount: number;
  medianPriceEur: number | null;
  medianPricePerM2: number | null;
  medianDaysOnMarket: number | null;
  communes: ReportCommune[];
  agencies: ReportAgency[];
  movements: ReportMovement[];
  coverage: Record<string, unknown>;
  warnings: string[];
  generatedAt: Date;
};

async function clientId(slug = "med-estates"): Promise<string | null> {
  const [c] = await db.select().from(clients).where(eq(clients.slug, slug)).limit(1);
  return c?.id ?? null;
}

export async function listReports(): Promise<ReportRow[]> {
  const id = await clientId();
  if (!id) return [];
  const rows = await db
    .select()
    .from(marketReports)
    .where(eq(marketReports.clientId, id))
    .orderBy(desc(marketReports.periodStart));
  return rows.map(shape);
}

export async function getReport(reportId: string): Promise<ReportRow | null> {
  const [row] = await db
    .select()
    .from(marketReports)
    .where(eq(marketReports.id, reportId))
    .limit(1);
  return row ? shape(row) : null;
}

/**
 * Month-on-month deltas, computed against the PREVIOUS report rather than
 * against live data.
 *
 * Comparing a stored month to today would silently mix two different coverages
 * — and the direction of that error is always flattering, because coverage only
 * grows. Two frozen reports at least know what each of them could see.
 */
export function compare(current: ReportRow, previous: ReportRow | null) {
  if (!previous) return null;

  const currentSources = (current.coverage.sourcesEnabled as string[]) ?? [];
  const previousSources = (previous.coverage.sourcesEnabled as string[]) ?? [];
  const sourcesChanged =
    currentSources.length !== previousSources.length ||
    currentSources.some((s) => !previousSources.includes(s));

  const pct = (now: number | null, before: number | null) =>
    now === null || before === null || before === 0
      ? null
      : Math.round(((now - before) / before) * 100);

  return {
    previousLabel: previous.label,
    activeDelta: current.activeCount - previous.activeCount,
    medianPricePct: pct(current.medianPriceEur, previous.medianPriceEur),
    medianPpm2Pct: pct(current.medianPricePerM2, previous.medianPricePerM2),
    /**
     * The flag that makes the comparison honest. If a portal was switched on
     * between the two reports, the stock "grew" for a reason that has nothing
     * to do with the Var.
     */
    sourcesChanged,
    note: sourcesChanged
      ? `Coverage changed between ${previous.label} and ${current.label} — ` +
        `sources went from [${previousSources.join(", ") || "none"}] to ` +
        `[${currentSources.join(", ") || "none"}]. Any change below is partly ours, not the market's.`
      : null,
  };
}

function shape(r: typeof marketReports.$inferSelect): ReportRow {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    activeCount: r.activeCount,
    newCount: r.newCount,
    delistedCount: r.delistedCount,
    priceCutCount: r.priceCutCount,
    medianPriceEur: r.medianPriceEur,
    medianPricePerM2: r.medianPricePerM2,
    medianDaysOnMarket: r.medianDaysOnMarket,
    communes: (r.communes ?? []) as unknown as ReportCommune[],
    agencies: (r.agencies ?? []) as unknown as ReportAgency[],
    movements: (r.movements ?? []) as unknown as ReportMovement[],
    coverage: (r.coverage ?? {}) as Record<string, unknown>,
    warnings: r.warnings ?? [],
    generatedAt: r.generatedAt,
  };
}
