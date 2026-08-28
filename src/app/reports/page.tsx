import Link from "next/link";
import { listReports } from "@/lib/reports/queries";
import { agencyStats, communeStats, overview } from "@/lib/api/queries";
import { PageTitle, Card, Empty, Warnings, money } from "@/components/ui";

/**
 * Reports — frozen monthly snapshots, plus a live view of right now.
 *
 * The distinction is the point of this screen. A stored report is what we could
 * see, at the coverage we had, on the day it was written; "Right now" is
 * recomputed on every load and will not match a report generated an hour ago.
 * Showing them in one undifferentiated list was the previous version's mistake —
 * it invited comparing a frozen number to a live one without noticing.
 */

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const reports = await listReports();
  const [communes, agencies, head] = await Promise.all([
    communeStats(),
    agencyStats(),
    overview(),
  ]);

  const covered = communes.filter((c) => c.active > 0).length;
  const idle = head.sources.filter((s) => !s.enabled);

  const liveWarnings: string[] = [
    "Days on market are measured from OUR first sighting, not the portal's " +
      "publication date, except on Superimmo — so these are a floor, not an estimate.",
  ];
  if (covered < 12) {
    liveWarnings.push(
      `Only ${covered} of 12 communes have any stock collected. Comparing communes ` +
        `to each other is not meaningful yet.`,
    );
  }
  if (idle.length > 0) {
    liveWarnings.push(
      `Sources not enabled: ${idle.map((s) => s.key).join(", ")}. Every count below ` +
        `is an undercount.`,
    );
  }

  return (
    <div>
      <PageTitle
        eyebrow="Market"
        title="Reports"
        subtitle="Frozen monthly snapshots, and the market as it stands right now"
        aside={
          reports.length > 0 ? (
            <span className="text-xs text-[var(--color-muted)]">
              {reports.length} archived
            </span>
          ) : null
        }
      />

      {/* ── Archive ──────────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-faint)]">
          Archive
        </h2>

        {reports.length === 0 ? (
          <Empty
            title="No reports generated yet"
            detail={
              <>
                A report freezes the market for a period so it can be read again
                later. Generate one with{" "}
                <code className="rounded bg-[var(--color-raised)] px-1.5 py-0.5 text-[12px]">
                  npm run report -- --current
                </code>
                .
              </>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {reports.map((r) => (
              <Link
                key={r.id}
                href={`/reports/${r.id}`}
                className="group rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 transition-colors hover:border-[var(--color-accent)]/50"
              >
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-accent-soft)]">
                  {r.kind === "monthly" ? "Monthly report" : "Snapshot"}
                </div>
                <div className="display mt-1.5 text-[20px]">{r.label}</div>

                <div className="tnum mt-3 space-y-1 text-[12px] text-[var(--color-muted)]">
                  <div className="flex justify-between">
                    <span>Active</span>
                    <span className="text-[var(--color-ink)]">{r.activeCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>New</span>
                    <span className="text-[var(--color-ink)]">{r.newCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Price cuts</span>
                    <span className={r.priceCutCount > 0 ? "text-[var(--color-down)]" : ""}>
                      {r.priceCutCount || "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Median</span>
                    <span className="text-[var(--color-ink)]">{money(r.medianPriceEur)}</span>
                  </div>
                </div>

                {/*
                  Coverage on the card, not buried inside. Two reports at
                  different coverages are not comparable, and that has to be
                  visible before someone compares them.
                */}
                <div className="mt-3 border-t border-[var(--color-line-soft)] pt-2 text-[10px] text-[var(--color-faint)]">
                  {String(r.coverage.communesWithStock ?? "?")}/
                  {String(r.coverage.communesWatched ?? "?")} communes ·{" "}
                  {((r.coverage.sourcesEnabled as string[]) ?? []).length || "no"} sources
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ── Live ─────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-faint)]">
          Right now — recomputed on every load
        </h2>

        <Warnings items={liveWarnings} />

        <div className="space-y-6">
          <Card title="By commune">
            {communes.length === 0 ? (
              <Empty title="Nothing collected yet" detail="Run a collection first." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-[var(--color-line-soft)] text-left text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                    <tr>
                      <th className="px-5 py-3 font-medium">Commune</th>
                      <th className="px-3 py-3 text-right font-medium">Active</th>
                      <th className="px-3 py-3 text-right font-medium">New (30d)</th>
                      <th className="px-3 py-3 text-right font-medium">Median price</th>
                      <th className="px-3 py-3 text-right font-medium">Median €/m²</th>
                      <th className="px-3 py-3 text-right font-medium">Median days</th>
                      <th className="px-5 py-3 text-right font-medium">Cuts (30d)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {communes.map((c) => (
                      <tr
                        key={c.insee}
                        className="border-b border-[var(--color-line-soft)] last:border-0"
                      >
                        <td className="px-5 py-3">{c.label}</td>
                        <td className="tnum px-3 py-3 text-right">{c.active}</td>
                        <td className="tnum px-3 py-3 text-right">{c.newIn30d}</td>
                        <td className="tnum px-3 py-3 text-right">{money(c.medianPriceEur)}</td>
                        <td className="tnum px-3 py-3 text-right">
                          {c.medianPricePerM2 === null
                            ? "—"
                            : `${new Intl.NumberFormat("fr-FR").format(c.medianPricePerM2)} €`}
                        </td>
                        <td className="tnum px-3 py-3 text-right">{c.medianDaysOnMarket ?? "—"}</td>
                        <td className="tnum px-5 py-3 text-right">
                          {c.priceCuts30d > 0 ? (
                            <span className="text-[var(--color-down)]">{c.priceCuts30d}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Agencies carrying the stock"
            aside={
              <span className="text-[11px] text-[var(--color-muted)]">
                grouped by agency identity, not by spelling
              </span>
            }
          >
            {agencies.length === 0 ? (
              <Empty title="No agencies resolved yet" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-[var(--color-line-soft)] text-left text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                    <tr>
                      <th className="px-5 py-3 font-medium">Agency</th>
                      <th className="px-3 py-3 text-right font-medium">Active</th>
                      <th className="px-3 py-3 text-right font-medium">Median price</th>
                      <th className="px-5 py-3 font-medium">Communes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agencies.map((a) => (
                      <tr
                        key={a.id}
                        className="border-b border-[var(--color-line-soft)] last:border-0"
                      >
                        <td className="px-5 py-3">{a.name}</td>
                        <td className="tnum px-3 py-3 text-right">{a.active}</td>
                        <td className="tnum px-3 py-3 text-right">{money(a.medianPriceEur)}</td>
                        <td className="px-5 py-3 text-[var(--color-muted)]">
                          {a.communes.join(", ") || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Sources">
            <div className="divide-y divide-[var(--color-line-soft)]">
              {head.sources.map((s) => (
                <div key={s.key} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div>
                    <span>{s.name}</span>
                    <span className="ml-2 text-[11px] text-[var(--color-faint)]">{s.key}</span>
                  </div>
                  <div className="flex items-center gap-4 text-[11px] text-[var(--color-muted)]">
                    <span className="tnum">
                      {s.lastRunAt
                        ? `last run ${s.lastRunAt.toISOString().slice(0, 16).replace("T", " ")}`
                        : "never run"}
                    </span>
                    <span
                      className={
                        "rounded border px-1.5 py-0.5 " +
                        (s.enabled
                          ? "border-[var(--color-up)] text-[var(--color-up)]"
                          : "border-[var(--color-line)]")
                      }
                    >
                      {s.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
