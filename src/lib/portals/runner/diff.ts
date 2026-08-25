/**
 * Set arithmetic for a collection pass. Pure — no database, no network, no
 * clock. Everything here is a decision about what to do next, and every one of
 * those decisions is worth being able to test in isolation.
 */

export type DiffInput = {
  /** External ids currently marked active for this source. */
  known: Iterable<string>;
  /** External ids discovery just found live. */
  discovered: Iterable<string>;
  /**
   * Ids whose stored page is older than the refresh window. Re-fetched even
   * though nothing about them looks new, so price edits that leave the index
   * unchanged are eventually noticed.
   */
  stale?: Iterable<string>;
  /**
   * FALSE when discovery did not finish — a page errored, a ceiling was hit,
   * a portal started refusing halfway through.
   *
   * This is the single most consequential flag in the pipeline. An interrupted
   * crawl produces a short list that looks exactly like a market emptying out.
   * Treating it as authoritative delists everything discovery never reached,
   * which is silent, plausible, and takes weeks to spot in a report.
   *
   * When false: additions still count (anything we saw is certainly there),
   * removals are suppressed entirely.
   */
  complete: boolean;
};

export type DiffResult = {
  /** Not seen before — fetch and parse. */
  added: string[];
  /** Known and seen again — no fetch unless stale. */
  present: string[];
  /** Known, not seen, and discovery finished. Delist these. */
  removed: string[];
  /** Present but due a refresh. */
  refresh: string[];
  /** Known and unseen, but discovery was interrupted, so left alone. */
  suppressedRemovals: string[];
};

export function diffListings(input: DiffInput): DiffResult {
  const known = new Set(input.known);
  const discovered = new Set(input.discovered);
  const stale = new Set(input.stale ?? []);

  const added: string[] = [];
  const present: string[] = [];
  const refresh: string[] = [];

  for (const id of discovered) {
    if (known.has(id)) {
      present.push(id);
      if (stale.has(id)) refresh.push(id);
    } else {
      added.push(id);
    }
  }

  const missing: string[] = [];
  for (const id of known) if (!discovered.has(id)) missing.push(id);

  return {
    added,
    present,
    refresh,
    removed: input.complete ? missing : [],
    suppressedRemovals: input.complete ? [] : missing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export type GuardInput = {
  /** How many listings discovery found. */
  discovered: number;
  /** How many were active before this run. */
  baseline: number;
  /** Fraction of baseline below which we refuse to proceed. */
  threshold: number;
  /**
   * Baselines below this are too small to reason about. Going from 6 listings
   * to 2 in a quiet commune is ordinary; the same ratio from 600 to 200 is a
   * portal blocking us.
   */
  minBaseline?: number;
};

export type GuardVerdict =
  | { abort: false; reason: null }
  | { abort: true; reason: string };

/**
 * Refuse to delist when a source returns implausibly little.
 *
 * Deliberately one-directional: a count going UP is never suspicious. A
 * backfill, a widened commune list or a busy week all legitimately multiply the
 * number, and an upper bound would fire on every one of them.
 */
export function shouldAbort({
  discovered,
  baseline,
  threshold,
  minBaseline = 20,
}: GuardInput): GuardVerdict {
  // First run for this source: nothing to compare against, and every listing
  // is an addition. There is nothing here the guard could protect.
  if (baseline === 0) return { abort: false, reason: null };

  if (baseline < minBaseline) return { abort: false, reason: null };

  const ratio = discovered / baseline;
  if (ratio >= threshold) return { abort: false, reason: null };

  return {
    abort: true,
    reason:
      `discovery returned ${discovered} listings against a baseline of ${baseline} ` +
      `(${(ratio * 100).toFixed(0)}%, floor ${(threshold * 100).toFixed(0)}%). ` +
      `Treating this as a blocked crawl, not an empty market — no delistings written.`,
  };
}
