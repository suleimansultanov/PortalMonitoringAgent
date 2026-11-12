import { collectWindowOf, insideCollectWindow } from "./runner/collectWindow";

/**
 * Which sources the morning retry (`.github/workflows/retry.yml`) starts again.
 * Pure, so it can be tested without a database; `retryAborted.ts` feeds it.
 *
 * Why it exists: on 2026-11-10 Vizzit's discovery returned 0 listings against
 * 5 280 at 03:10 UTC, the guard aborted the run (as it should), and the client
 * saw Vizzit red all day until someone dispatched `sources=vizzit` by hand at
 * 16:32. The one-off is the common case: of the sources switched on that day,
 * every failure in `portal_runs` (six, 28 August to 10 November) was followed by
 * a good run. Waiting a night for it costs the client a day of a portal.
 *
 * Retried: an enabled source whose latest run is a scheduled one, ended
 * `aborted` or `error`, started in the last RETRY_LOOKBACK_HOURS, and came after
 * a run that finished (`done` or `partial`). Not retried, and why:
 *
 *   - two failures in a row: either the retry already failed or the portal is
 *     refusing us (JamesEdition, 403 from 16 September). Going back every
 *     morning doubles the load on a site that has said no — a person's call;
 *   - a `manual` or `backfill` run: someone was there and knows;
 *   - a portal outside the hours it asked for (LuxuryEstate, 01:00-05:00 Paris),
 *     judged when the retry starts: twenty minutes after the night it is
 *     usually inside them, at the 06:30 UTC fallback never;
 *   - NEVER_RETRY, below.
 *
 * Once a night, by construction: a retry that fails is the latest run and has a
 * failure before it, and by the next morning it is outside the lookback.
 */

/**
 * The nightly starts 00:00-03:30 UTC (GitHub's lateness on a 21:00 cron). The
 * retry runs twenty minutes after it ends, or at the 06:30 cron that GitHub
 * started at 14:36 on 2026-11-11: twenty hours reaches back past that night
 * and not to the one before it, nor to yesterday's retry.
 */
export const RETRY_LOOKBACK_HOURS = 20;

export const NEVER_RETRY: Readonly<Record<string, string>> = {
  "stream-estate-v1": "billed per item on the client's card — a second read is a person's decision",
  superimmo: "collects in superimmo.yml, and collect.yml excludes it — a retry there collects nothing",
};

export type RetrySource = { key: string; enabled: boolean; config: unknown };
export type RetryRun = { sourceKey: string; status: string; mode: string; startedAt: Date };
export type RetryVerdict = { key: string; retry: boolean; why: string };

const FAILED = new Set(["aborted", "error"]);
const FINISHED = new Set(["done", "partial"]);

/**
 * One verdict per source whose latest run failed inside the lookback; sources
 * with nothing to retry are not mentioned. `runs` may hold any number of runs
 * per source, in any order — only the latest two are read.
 */
export function pickRetries(sources: RetrySource[], runs: RetryRun[], now: Date): RetryVerdict[] {
  const bySource = new Map<string, RetryRun[]>();
  for (const r of runs) bySource.set(r.sourceKey, [...(bySource.get(r.sourceKey) ?? []), r]);

  const verdicts: RetryVerdict[] = [];
  for (const s of [...sources].sort((a, b) => a.key.localeCompare(b.key))) {
    const [latest, before] = (bySource.get(s.key) ?? [])
      .filter((r) => r.startedAt <= now)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    if (!latest || !FAILED.has(latest.status)) continue;
    if (now.getTime() - latest.startedAt.getTime() > RETRY_LOOKBACK_HOURS * 3_600_000) continue;

    const said = `${latest.status} at ${latest.startedAt.toISOString().slice(0, 16)}Z`;
    const no = (why: string) => verdicts.push({ key: s.key, retry: false, why: `${said}; not retried: ${why}` });
    // `--sources=` overrides the enabled flag (nightly.ts), so this check is the only one.
    if (!s.enabled) { no("switched off"); continue; }
    if (NEVER_RETRY[s.key]) { no(NEVER_RETRY[s.key]); continue; }
    if (latest.mode !== "scheduled") { no(`a ${latest.mode} run — whoever started it knows`); continue; }
    if (!before || !FINISHED.has(before.status)) {
      no(before ? `the run before it ended ${before.status} too` : "no earlier run to call it a one-off");
      continue;
    }
    const window = collectWindowOf(s.config);
    if (window && !insideCollectWindow(window, now)) {
      no(`outside the hours it asked for (${window.from}:00-${window.to}:00 ${window.tz})`);
      continue;
    }
    verdicts.push({ key: s.key, retry: true, why: `${said} after a run that ended ${before.status}: retried once` });
  }
  return verdicts;
}
