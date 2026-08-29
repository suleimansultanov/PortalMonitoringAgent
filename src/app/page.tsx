import Link from "next/link";
import { overview, communeStats } from "@/lib/api/queries";
import { Card, Stat, Warnings } from "@/components/ui";

/**
 * Overview.
 *
 * Deliberately states what is MISSING as prominently as what is there. A
 * dashboard that shows 28 properties and says nothing else reads as "the market
 * has 28 properties", when it actually means "one of twelve communes has been
 * crawled once". The second sentence is the one that stops someone drawing a
 * conclusion from a tenth of the data.
 */

export const dynamic = "force-dynamic";

export default async function Home() {
  const [head, communes] = await Promise.all([overview(), communeStats()]);
  const covered = communes.filter((c) => c.active > 0).length;
  const enabled = head.sources.filter((s) => s.enabled).length;

  const warnings: string[] = [];
  if (covered < 12) {
    warnings.push(
      `${covered} of 12 communes have any stock collected. The numbers below ` +
        `describe what we have crawled, not the market.`,
    );
  }
  if (head.buyersReal === 0 && head.buyersTest > 0) {
    warnings.push(
      `All ${head.buyersTest} buyers are TEST DATA. Real criteria have not been ` +
        `imported from GoHighLevel yet — matches are excluded from the count below.`,
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>

      <Warnings items={warnings} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Active properties"
          value={head.activeProperties}
          hint="deduplicated across portals"
        />
        <Stat
          label="New this week"
          value={head.newThisWeek ?? "—"}
          hint={
            head.newThisWeek === null
              ? "needs seven days of history — we have less"
              : "first seen in 7 days"
          }
        />
        <Stat
          label="Buyers"
          value={head.buyersReal}
          hint={head.buyersTest > 0 ? `plus ${head.buyersTest} test records` : "from the CRM"}
        />
        <Stat
          label="Open matches"
          value={head.matchesOpen}
          hint="not yet sent or dismissed"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Coverage">
          <div className="space-y-3 px-5 py-4 text-sm">
            <Row label="Communes with stock" value={`${covered} of 12`} />
            <Row label="Sources enabled" value={`${enabled} of ${head.sources.length}`} />
            <p className="pt-2 text-xs text-[var(--color-muted)]">
              A commune showing nothing is far more likely to be uncrawled than quiet.
              Until all twelve are collected, comparisons between them say more about
              our coverage than about the market.
            </p>
          </div>
        </Card>

        <Card title="Where the stock is">
          {communes.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-[var(--color-muted)]">
              Nothing collected yet.
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-line)]">
              {communes.slice(0, 8).map((c) => (
                <Link
                  key={c.insee}
                  href={`/listings?commune=${c.insee}`}
                  className="flex items-center justify-between px-5 py-2.5 text-sm hover:bg-[var(--color-canvas)]"
                >
                  <span>{c.label}</span>
                  <span className="tnum text-[var(--color-muted)]">{c.active}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="tnum font-medium">{value}</span>
    </div>
  );
}
