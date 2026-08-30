import Link from "next/link";
import { communeStats, listMatches } from "@/lib/api/queries";
import { MatchList, type Match } from "@/components/MatchList";
import { Warnings } from "@/components/ui";

/**
 * Matches — new stock against the client's buyers.
 *
 * Test buyers are OFF by default and switching them on is a deliberate click
 * that says so on screen. Right now they are the only buyers there are, so the
 * default view is empty and the page explains why rather than looking broken.
 */

export const dynamic = "force-dynamic";

export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ test?: string }>;
}) {
  const sp = await searchParams;
  const includeTestData = sp.test === "1";

  const [rows, communes] = await Promise.all([
    listMatches({ includeTestData, limit: 100 }) as unknown as Promise<Match[]>,
    communeStats(),
  ]);
  const covered = communes.filter((c) => c.active > 0).length;

  const warnings: string[] = [];
  if (includeTestData) {
    warnings.push(
      "Showing INVENTED buyers, seeded so this screen could be built before the " +
        "real ones arrive from GoHighLevel. Nothing here is a real person and no " +
        "address here can receive mail.",
    );
  }
  /**
   * Derived, not written down. This line used to read "only one commune has
   * been crawled so far" — true on the day it was typed, quietly false for
   * every day after, and pointed at the client. A sentence about the state of
   * the data has to be computed from the data or it becomes a lie on a
   * schedule.
   */
  if (covered < communes.length) {
    warnings.push(
      `${covered} of ${communes.length} communes have stock collected. A buyer with ` +
        `no matches may simply be looking in one of the others.`,
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Matches</h1>
        <Link
          href={includeTestData ? "/matches" : "/matches?test=1"}
          className="text-sm text-[var(--color-muted)] underline underline-offset-4 hover:text-[var(--color-ink)]"
        >
          {includeTestData ? "Hide test buyers" : "Show test buyers"}
        </Link>
      </div>

      <Warnings items={warnings} />

      {!includeTestData && rows.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-12 text-center">
          <div className="text-sm font-medium">No real buyers yet</div>
          <div className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-muted)]">
            Buyer criteria have not been imported from GoHighLevel. Until Med-Estates
            confirms how those are stored — structured fields or free text in notes —
            this screen has been built and tested against invented buyers.
            <br />
            <Link
              href="/matches?test=1"
              className="mt-2 inline-block underline underline-offset-4"
            >
              Show them
            </Link>
          </div>
        </div>
      ) : (
        <MatchList initial={rows} />
      )}
    </div>
  );
}
