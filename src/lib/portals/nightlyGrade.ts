import type { RunSummary } from "./runner/run";

/**
 * Grading a night, with NOTHING else in the file.
 *
 * This lived inside `nightlyOne.ts`, which opens the database on import — so
 * the single most consequential function in the nightly pipeline had no tests,
 * and in one week it was found wrong in both directions: a source refused at
 * the door reported `ok`, and a source that discovered 2142 listings reported
 * `error`. A pure module can be tested against a plain object, which is what
 * every fix here now is.
 *
 * `import type` is erased at build time, so this file pulls in none of
 * `run.ts`'s runtime — no drizzle, no pg, no server-only.
 */

export type Grade = "ok" | "warn" | "fail";

/**
 * How bad is this?
 *
 * `fail` means the pass did not finish, so the picture of that portal is
 * incomplete and the diff for the next run will be working from a fragment.
 * That is the only condition worth waking someone for.
 *
 * `warn` means individual listings could not be fetched. Some of that is
 * ordinary — a URL that 404s between discovery and ingestion is a listing that
 * sold this afternoon. On the night of 2026-08-31 LuxuryEstate refused 43 of
 * 1688 and that was a good run. So failures are shown, never escalated on
 * count alone; the ratio is printed next to them so a person can judge.
 */
export function grade(s: RunSummary): { grade: Grade; note: string } {
  if (s.status === "error") return { grade: "fail", note: s.error ?? "the pass threw" };
  if (s.status === "aborted") return { grade: "fail", note: s.abortedReason ?? "aborted" };
  if (s.status === "disabled") {
    return { grade: "warn", note: "source is switched off in portal_sources" };
  }

  /**
   * NOTHING FOUND, AND NOT BECAUSE THE MARKET IS EMPTY.
   *
   * The abort guard compares discovery against yesterday's baseline, so a
   * source with no baseline — never collected, or emptied — can be refused on
   * every commune and still pass it: zero against zero trips nothing. Then
   * `incomplete()` suppresses delisting but never touched the grade, and the
   * pass reached the summary as `ok`. Measured 2026-09-15: JamesEdition,
   * Cloudflare 403 on page one of its first commune, "all clear".
   *
   * A pass that reached nothing while at least one commune reports itself cut
   * short did not finish. That is the definition of `fail` above. A pass that
   * reached nothing with every commune walked to the end is a genuinely empty
   * market and falls through.
   */
  const incomplete = s.communesIncomplete ?? 0;
  if (s.discovered === 0 && incomplete > 0) {
    const visited = s.communesVisited ?? incomplete;
    return {
      grade: "fail",
      note:
        `discovery reached nothing — ${incomplete} of ${visited} communes were cut short ` +
        `before yielding a listing. A blocked door, not an empty market.`,
    };
  }

  /**
   * A complete discovery whose fetching ran out of road. The market picture is
   * right, the delistings are sound, the unread pages are on tomorrow's queue —
   * so this is worth showing and not worth waking anyone for.
   *
   * It reached `fail` until 2026-09-16, which put a Figaro pass that discovered
   * 2142 listings, stored 607 and removed 132 in the same column as a source
   * refused at the door with nothing collected.
   */
  if (s.status === "partial") {
    return { grade: "warn", note: s.fetchStoppedEarly ?? "fetching stopped early" };
  }
  /**
   * Still a failure: reaching here means discovery ITSELF was incomplete, so
   * what the pass believes is on the market is a fragment.
   */
  if (s.fetchStoppedEarly) return { grade: "fail", note: s.fetchStoppedEarly };

  if (s.failed > 0) {
    const attempted = s.added + s.refreshed;
    const pct = attempted > 0 ? Math.round((s.failed / attempted) * 100) : 100;
    return { grade: "warn", note: `${s.failed} of ${attempted} listings failed (${pct}%)` };
  }
  return { grade: "ok", note: "" };
}
