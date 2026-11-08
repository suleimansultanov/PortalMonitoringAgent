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

/**
 * The refresh queue for one pass: who is re-read, in what order, within what budget.
 *
 * A RECORD DISCOVERY ALREADY HOLDS IS RE-READ FOR NOTHING. Bien'ici hands over
 * every listing whole, and the queue treated those like pages to download: the
 * index's "not changed since" skipped them and the request budget rationed them.
 * So a listing in every night's index went up to REFRESH_HARD_CEILING_DAYS with
 * its `last_seen_at` untouched — 755 Bien'ici rows "not seen for 14 days" on
 * 2026-11-08, every one of the 40 in Saint-Tropez in that night's index — and
 * the client's "not re-checked for 14 days" counted them. Re-reading a record
 * in hand costs no request: it is always taken, outside the budget, first.
 * Rows that need a request keep the portal's answer and the budget, oldest first.
 */
export function planRefresh(input: {
  /** Past the refresh window, oldest first. */
  candidates: { externalId: string; sourceUpdatedAt: Date | null; lastSeenAt: Date | null }[];
  /** What tonight's discovery found, with the record when it holds one. */
  discovered: { get(id: string): { sourceUpdatedAt?: Date | null; document?: string } | undefined };
  hardCeiling: Date;
  /** How many pages the night can afford to download. */
  limit: number;
}): { take: string[]; due: number; skippedUnchanged: number; inHand: number } {
  const inHand: string[] = [];
  const needRequest: string[] = [];
  let skippedUnchanged = 0;
  for (const row of input.candidates) {
    const seen = input.discovered.get(row.externalId);
    if (seen?.document !== undefined) {
      inHand.push(row.externalId);
      continue;
    }
    const keep = needsRefresh(
      { externalId: row.externalId, fetchedAt: row.lastSeenAt, storedSourceUpdatedAt: row.sourceUpdatedAt },
      seen?.sourceUpdatedAt,
      input.hardCeiling,
    );
    if (keep) needRequest.push(row.externalId);
    else skippedUnchanged++;
  }
  return {
    take: [...inHand, ...needRequest.slice(0, Math.max(0, input.limit))],
    due: inHand.length + needRequest.length,
    skippedUnchanged,
    inHand: inHand.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records discovery already holds whose content is not what we stored.
 *
 * WHY THIS EXISTS. An API source (Stream.Estate) hands over every property
 * whole, every night. The pass then stored only the NEW ones: a listing we
 * already knew was re-read only once its row had sat untouched for
 * REFRESH_AFTER_DAYS — and the resolver touches most rows nightly, so for
 * many that day never came. Three nights in October 2026: 11, 1 552 and
 * 2 543 records stored, exactly the new ones each time, not one refresh. A
 * price cut on SeLoger was in our hands every night and never written down;
 * so were the photographs Stream.Estate attaches late (their own fault, in
 * writing 2026-10-09, with "no change event will tell you").
 *
 * Comparing a hash costs no request. It is only sound where the record is
 * stable — where it changes when the property does and not on its own:
 * measured on Stream.Estate, 83 of 88 records byte-identical two days apart
 * and the other five really changed. Bien'ici's records are NOT stable (231
 * listings re-offered nightly had ten different snapshots in ten nights), so
 * this is switched on per source (`refreshOnChange`), never by default.
 *
 * A record with no stored hash is taken as changed: we hold a listing row and
 * no page behind it, and the only way to have one is to store this.
 */
export function changedInHand(input: {
  /** Known and seen again tonight. */
  present: string[];
  /** Hash of the record discovery holds, or undefined when it holds none. */
  offered: (externalId: string) => string | undefined;
  /** Hash of the last snapshot we stored. */
  stored: (externalId: string) => string | undefined;
  /** Already queued by the stale-refresh rule; not listed twice. */
  alreadyRefreshing: Iterable<string>;
}): string[] {
  const queued = new Set(input.alreadyRefreshing);
  const out: string[] = [];
  for (const id of input.present) {
    if (queued.has(id)) continue;
    const offered = input.offered(id);
    if (offered === undefined) continue;
    if (input.stored(id) !== offered) out.push(id);
  }
  return out;
}

/**
 * What to fetch, from what discovery found.
 *
 * A NEW listing the index syndicates from another portal is left out. Vizzit's
 * index carries idealista's, SeLoger's and Rightmove's adverts with the portal
 * printed where the agency goes, and the GitHub runner was answered 410 for
 * every one of them: 1 062 of 1 194 fetches on 2026-10-15, about a thousand a
 * night since 10-06, each "new" again the next night because a page that
 * fails is never stored. They are those portals' adverts, not this one's. A
 * KNOWN one — served to us once — keeps its refresh: the portal evidently does
 * serve it to this address, and we hold a page to keep current.
 */
export function planFetch(input: {
  added: string[];
  refresh: string[];
  syndicatedFrom: (id: string) => string | undefined;
}): { toFetch: string[]; syndicated: Record<string, number> } {
  const syndicated: Record<string, number> = {};
  const toFetch: string[] = [];
  for (const id of input.added) {
    const from = input.syndicatedFrom(id);
    if (from) syndicated[from] = (syndicated[from] ?? 0) + 1;
    else toFetch.push(id);
  }
  toFetch.push(...input.refresh);
  return { toFetch, syndicated };
}

/**
 * HELD LISTINGS THE INDEX STOPPED SHOWING, TO BE ASKED ABOUT BY THEIR OWN URL.
 *
 * Some portals' indexes show a window, not the market: Vizzit's Sainte-Maxime
 * index stated 1 470 listings on 2026-11-08 and served 479 before its pages ran
 * empty. The adapter rightly marks such a commune incomplete, so nothing in it
 * is delisted for being unseen — and nothing else ever asks about those rows
 * either: the refresh queue only takes listings discovery saw tonight. A row
 * outside the window was never re-read, never delisted, and kept its last price
 * on the client's cards indefinitely: 1 585 Vizzit rows unseen for 14 days, 485
 * for 30, and of 20 sampled 10 answered 410. Etreproprio had 130, Bien'ici 755.
 *
 * So the runner fetches a few of them each night by the URL we hold, oldest
 * first. Only those the diff SHIELDED (known, unseen, in an incomplete commune
 * or an incomplete pass): a complete pass already delists the unseen, and a
 * listing seen tonight is the refresh queue's. Only past the refresh window,
 * so a row the index merely skipped tonight is left for tomorrow's index.
 */
export function unseenToVerify(input: {
  candidates: { externalId: string; url: string; lastSeenAt: Date }[];
  discovered: { has(id: string): boolean };
  shielded: Iterable<string>;
  staleBefore: Date;
  limit: number;
}): { externalId: string; url: string }[] {
  if (input.limit <= 0) return [];
  const shielded = new Set(input.shielded);
  return input.candidates
    .filter((c) => shielded.has(c.externalId) && !input.discovered.has(c.externalId) && c.lastSeenAt < input.staleBefore)
    .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime())
    .slice(0, input.limit)
    .map(({ externalId, url }) => ({ externalId, url }));
}

/**
 * Whether a night's "gone" answers can be believed.
 *
 * A 404 or 410 on the page we hold is the portal saying the advert is gone, and
 * it is delisted by name. Unless nearly everything answers that way: then the
 * likelier story is the one the abort guard exists for — the portal answering
 * this address differently tonight (Vizzit answers the GitHub runner 410 for
 * other portals' adverts) — and none of it is delisted.
 */
export const VERIFY_GONE_DISTRUST = { minChecked: 20, maxGoneShare: 0.9 };

export function trustGone(checked: number, gone: number): boolean {
  if (checked < VERIFY_GONE_DISTRUST.minChecked) return true;
  return gone / checked <= VERIFY_GONE_DISTRUST.maxGoneShare;
}
