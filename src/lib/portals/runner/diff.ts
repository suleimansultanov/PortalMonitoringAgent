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

  /**
   * Known ids sitting in a commune discovery could not finish.
   *
   * `complete: false` is the blunt instrument — it shields the entire source.
   * This is the scalpel. A 502 on page four of Grimaud says nothing about
   * Ramatuelle, and the two are worth separating: if every hiccup shielded the
   * whole portal, a site that stumbles most nights would never delist anything
   * again, and the suppression would have stopped protecting the data and
   * started hiding it.
   *
   * Ids listed here move from `removed` to `suppressedRemovals`, exactly as if
   * the whole pass had been incomplete — for them alone.
   */
  incomplete?: Iterable<string>;
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

  /**
   * Two reasons to spare an unseen listing, and they compose: the pass as a
   * whole did not finish, or the commune this listing lives in did not.
   */
  const shielded = new Set(input.incomplete ?? []);
  const removed: string[] = [];
  const suppressedRemovals: string[] = [];
  for (const id of known) {
    if (discovered.has(id)) continue;
    if (input.complete && !shielded.has(id)) removed.push(id);
    else suppressedRemovals.push(id);
  }

  return { added, present, refresh, removed, suppressedRemovals };
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

/** One listing already held, considered for a re-read. */
export type RefreshCandidate = {
  externalId: string;
  /** When WE last fetched the page. */
  fetchedAt: Date | null;
  /** The portal's own "last edited", as it stood when we last read the listing. */
  storedSourceUpdatedAt: Date | null;
};

/**
 * Is this page worth spending a request on?
 *
 * Refreshing is the larger half of a settled night, and almost all of it is
 * re-downloading pages that did not change: nothing in the pipeline can tell
 * before the request, because the content hash in ingest.ts is only reached
 * after the page has arrived. On a source whose INDEX states a per-listing
 * "last edited" — Figaro publishes one in its Nuxt payload — discovery has
 * already been handed the answer, in a page it was going to read anyway.
 *
 * `stated` is that answer for this listing, or null/undefined where the portal
 * said nothing or discovery never saw the listing this pass.
 *
 * Every branch here defaults to fetching. Read the argument for each, because
 * the cheap version of this function — "skip when the dates match" — is wrong
 * in three separate ways:
 *
 *   - **Past the ceiling, always fetch.** The date is the portal's claim about
 *     itself; a site that forgets to touch it when a price changes would freeze
 *     that listing's price in our data forever. A month is an acceptable
 *     exposure, "until they fix their CMS" is not.
 *   - **No date on either side means fetch.** Absence is not freshness. This is
 *     also what keeps every other source behaving exactly as before.
 *   - **A listing discovery did not see is never skipped.** It may simply be
 *     one the pass never reached — a delta stop, a truncated commune — and its
 *     absence from this pass says nothing at all about whether it changed.
 */
export function needsRefresh(
  row: RefreshCandidate,
  stated: Date | null | undefined,
  hardCeiling: Date,
): boolean {
  if (!row.fetchedAt || row.fetchedAt < hardCeiling) return true;
  if (!stated || !row.storedSourceUpdatedAt) return true;
  return stated.getTime() > row.storedSourceUpdatedAt.getTime();
}
