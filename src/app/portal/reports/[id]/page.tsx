import Link from "next/link";
import { notFound } from "next/navigation";
import { compare, getReport, listReports } from "@/lib/reports/queries";
import { Card, Stat, Warnings, Empty, money } from "@/components/ui";

/**
 * One frozen report.
 *
 * Every number here was written on `generatedAt` and has not moved since. That
 * is the point: a figure quoted to a client in July should still say the same
 * thing in October, even though the market has.
 *
 * The month-on-month comparison is deliberately guarded. Coverage only ever
 * grows, so comparing two periods across a coverage change always flatters —
 * "the market grew 40%" that turns out to mean "we switched a portal on". When
 * the sources differ between two reports, the screen says so above the numbers
 * rather than leaving someone to notice.
 */

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await getReport(id);
  if (!report) notFound();

  const all = await listReports();
  const index = all.findIndex((r) => r.id === report.id);
  const previous = index >= 0 && index < all.length - 1 ? all[index + 1] : null;
  const delta = compare(report, previous);

  const sources = (report.coverage.sourcesEnabled as string[]) ?? [];

  return (
    <div>
      <Link
        href="/portal/reports"
        className="mb-5 inline-block text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
      >
        ← Reports
      </Link>

      <div className="mb-6">
        <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-faint)]">
          {report.kind === "monthly" ? "Monthly report" : "Snapshot"}
        </div>
        <h1 className="display mt-1 text-[32px] leading-tight">{report.label}</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          {String(report.coverage.communesWithStock ?? "?")} of{" "}
          {String(report.coverage.communesWatched ?? "?")} communes ·{" "}
          {sources.length > 0 ? sources.join(", ") : "no sources enabled"} · frozen{" "}
          {report.generatedAt.toISOString().slice(0, 10)}
        </p>
      </div>

      <Warnings items={report.warnings} />

      {delta?.note && (
        <div className="mb-6 rounded-xl border border-[var(--color-warn)]/25 bg-[var(--color-warn)]/[0.06] px-5 py-3.5 text-[13px] leading-relaxed text-[var(--color-ink)]/75">
          {delta.note}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Active"
          value={report.activeCount}
          hint={
            delta
              ? `${delta.activeDelta >= 0 ? "+" : ""}${delta.activeDelta} vs ${delta.previousLabel}`
              : "no earlier report to compare"
          }
        />
        <Stat label="New in period" value={report.newCount} />
        <Stat
          label="Price cuts"
          value={report.priceCutCount}
          tone={report.priceCutCount > 0 ? "accent" : "muted"}
        />
        <Stat
          label="Median price"
          value={money(report.medianPriceEur)}
          hint={
            delta?.medianPricePct !== null && delta?.medianPricePct !== undefined
              ? `${delta.medianPricePct >= 0 ? "+" : ""}${delta.medianPricePct}% vs ${delta.previousLabel}`
              : undefined
          }
        />
      </div>

      <div className="space-y-6">
        <Card title="By commune">
          {report.communes.length === 0 ? (
            <Empty title="Nothing collected in this period" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-[var(--color-line-soft)] text-left text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">Commune</th>
                    <th className="px-3 py-3 text-right font-medium">Active</th>
                    <th className="px-3 py-3 text-right font-medium">New</th>
                    <th className="px-3 py-3 text-right font-medium">Median price</th>
                    <th className="px-3 py-3 text-right font-medium">Median €/m²</th>
                    <th className="px-5 py-3 text-right font-medium">Median days</th>
                  </tr>
                </thead>
                <tbody>
                  {report.communes.map((c) => (
                    <tr
                      key={c.insee}
                      className="border-b border-[var(--color-line-soft)] last:border-0"
                    >
                      <td className="px-5 py-3">{c.label}</td>
                      <td className="tnum px-3 py-3 text-right">{c.active}</td>
                      <td className="tnum px-3 py-3 text-right">{c.newInPeriod}</td>
                      <td className="tnum px-3 py-3 text-right">{money(c.medianPriceEur)}</td>
                      <td className="tnum px-3 py-3 text-right">
                        {c.medianPricePerM2 === null
                          ? "—"
                          : `${new Intl.NumberFormat("fr-FR").format(c.medianPricePerM2)} €`}
                      </td>
                      <td className="tnum px-5 py-3 text-right">{c.medianDaysOnMarket ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/*
          The individual cuts, not just the count.
          "19 price cuts" is a statistic. WHICH villa, by how much, and by whom
          is the thing an agent can pick up the phone about — and it is exactly
          what a portal cannot show them, because a portal only knows today.
        */}
        <Card
          title="Price cuts in this period"
          aside={
            <span className="text-[11px] text-[var(--color-muted)]">largest first</span>
          }
        >
          {report.movements.length === 0 ? (
            <Empty
              title="No price cuts recorded"
              detail="Either the market held firm, or this period predates our history for these listings."
            />
          ) : (
            <div className="divide-y divide-[var(--color-line-soft)]">
              {report.movements.map((m) => (
                <Link
                  key={`${m.propertyId}-${m.occurredAt}`}
                  href={`/portal/listings/${m.propertyId}`}
                  className="flex items-center justify-between gap-4 px-5 py-3 text-[13px] hover:bg-[var(--color-raised)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{m.title ?? "Untitled"}</div>
                    <div className="text-[11px] text-[var(--color-muted)]">
                      {[m.commune, m.agency].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className="tnum shrink-0 text-right">
                    <div className="text-[var(--color-down)]">
                      {money(m.priceFrom)} → {money(m.priceTo)}
                    </div>
                    {m.pctChange !== null && (
                      <div className="text-[11px] text-[var(--color-muted)]">{m.pctChange}%</div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card title="Agencies">
          {report.agencies.length === 0 ? (
            <Empty title="No agencies resolved in this period" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-[var(--color-line-soft)] text-left text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">Agency</th>
                    <th className="px-3 py-3 text-right font-medium">Active</th>
                    <th className="px-5 py-3 text-right font-medium">Median price</th>
                  </tr>
                </thead>
                <tbody>
                  {report.agencies.map((a) => (
                    <tr
                      key={a.id}
                      className="border-b border-[var(--color-line-soft)] last:border-0"
                    >
                      <td className="px-5 py-3">{a.name}</td>
                      <td className="tnum px-3 py-3 text-right">{a.active}</td>
                      <td className="tnum px-5 py-3 text-right">{money(a.medianPriceEur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
