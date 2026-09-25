import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalSources } from "@/lib/db/schema";
import { communesForSource, runSource, type RunSummary } from "./runner/run";
import { grade, type Grade } from "./nightlyGrade";

/**
 * Re-exported so `nightly.ts` keeps its one import. The grading itself now
 * lives in `nightlyGrade.ts`, a pure module — see the note there for why it
 * moved out of a file that opens the database.
 */
export { grade, type Grade };

/**
 * ONE SOURCE, ONE PROCESS. The unit `nightly.ts` spawns.
 *
 *   npm run nightly:one -- --source=figaro
 *
 * WHY A SEPARATE PROCESS PER SOURCE, RATHER THAN A LOOP
 *
 * `npm run collect -- --source=all` walks the sources in one process, which
 * has two properties that are fine when a person is watching and not fine at
 * three in the morning. An unhandled throw on the third source takes the
 * remaining four with it — they are not collected, and nothing says so beyond
 * a stack trace where the summary should have been. And Chromium leaks are
 * cumulative: seven browser passes in one process hold whatever each of them
 * failed to release.
 *
 * A process per source gives isolation for free. The orchestrator sees an exit
 * code and a summary line even when the child dies badly, and the operating
 * system reclaims the browser whatever state it was left in.
 *
 * WHY IT PRINTS A MARKER LINE
 *
 * The parent captures stdout and stderr verbatim into a per-source log file —
 * that is the record a human reads when something went wrong. But it also needs
 * the numbers, and parsing them back out of prose is how a log format becomes
 * an API by accident. So the last line is JSON behind a marker: the log stays
 * written for people, and the summary is read by machine without the two ever
 * having to agree on wording.
 */

export const SUMMARY_MARKER = "__NIGHTLY_SUMMARY__";

export type SourceOutcome = Partial<RunSummary> & {
  sourceKey: string;
  grade: Grade;
  /** One line, in plain words, for the summary table. Empty when clean. */
  note: string;
  communes: number;
  startedAt: string;
  durationMs: number;
};


function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

async function main(): Promise<void> {
  const sourceKey = arg("source");
  if (!sourceKey) {
    console.error("nightlyOne needs --source=<key>");
    process.exit(2);
  }

  const startedAt = new Date();
  const started = Date.now();

  const emit = (outcome: SourceOutcome): void => {
    console.log(`${SUMMARY_MARKER}${JSON.stringify(outcome)}`);
  };

  const [source] = await db
    .select({ id: portalSources.id, enabled: portalSources.enabled })
    .from(portalSources)
    .where(eq(portalSources.key, sourceKey))
    .limit(1);

  if (!source) {
    emit({
      sourceKey,
      grade: "fail",
      note: `no portal_sources row with key "${sourceKey}"`,
      communes: 0,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - started,
    });
    process.exit(1);
  }

  /**
   * An explicit list narrows the pass; without one it collects what the
   * clients subscribe to, which is what a night is.
   *
   * It exists to make one measurement comparable across hosts. The refusals we
   * are chasing are per-address, so telling two machines apart means running
   * the SAME commune from each — and until now the nightly path could only run
   * all of them, which on a hosted runner is hours. `collect` has taken
   * --communes since the beginning; this is the same flag, reachable from the
   * path the scheduler actually uses.
   */
  const requested = arg("communes")?.split(",").map((c) => c.trim()).filter(Boolean);
  const communes = requested?.length ? requested : await communesForSource(source.id);
  if (communes.length === 0) {
    /**
     * Not an error, and not a success either. A source with no subscriber is
     * one nobody is paying attention to yet — but a night that silently
     * collects nothing from four portals because their client rows were never
     * attached looks identical to a night that worked.
     */
    emit({
      sourceKey,
      grade: "warn",
      note: "no client subscribes to it — nothing to collect",
      communes: 0,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - started,
    });
    process.exit(0);
  }

  console.log(
    `[nightly:${sourceKey}] starting — ${communes.length} communes, ` +
      `${startedAt.toISOString()}`,
  );

  try {
    const summary = await runSource({
      sourceKey,
      communeInsee: communes,
      mode: "scheduled",
      // `--force` exists so the nightly path can be rehearsed end to end before
      // the sources are switched on. The schedule itself never passes it: the
      // `enabled` flag is how a portal gets taken out of rotation mid-
      // negotiation, and a scheduler that overrides it is not a scheduler.
      force: process.argv.includes("--force"),
      /**
       * The weekly pass that notices disappearances. A delta night never can:
       * it stops before reaching the part of the list where a vanished listing
       * would have been, and says so by declaring itself incomplete.
       */
      fullSweep: process.argv.includes("--full"),
    });

    const g = grade(summary);
    emit({
      ...summary,
      sourceKey,
      grade: g.grade,
      note: g.note,
      communes: communes.length,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - started,
    });
    process.exit(g.grade === "fail" ? 1 : 0);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Printed as well as emitted: the stack belongs in the log file, the
    // sentence belongs in the summary table.
    console.error(`[nightly:${sourceKey}] threw:`, err);
    emit({
      sourceKey,
      grade: "fail",
      note: message.slice(0, 300),
      communes: communes.length,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - started,
    });
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("nightlyOne.ts")) {
  void main();
}
