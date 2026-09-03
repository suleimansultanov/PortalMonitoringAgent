import "server-only";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalListings, portalRuns, portalSources } from "@/lib/db/schema";
import { getNumberSetting, SETTING_KEYS } from "@/lib/settings/store";
import { getAdapter } from "../registry";
import type { DiscoveredListing, PoliteFetch } from "../types";
import { diffListings, shouldAbort } from "./diff";
import { createFetcher, BlockedError, USER_AGENT } from "./fetcher";
import { createBrowserSession, type BrowserSession } from "./browser";

/**
 * A refusal, as opposed to a rate limit.
 *
 * Matching on the message rather than the error class because the ingest step
 * flattens exceptions into a status and a string before this sees them. Kept as
 * a named function so the distinction has somewhere to be explained.
 */
function isRefusal(error: string | null | undefined): boolean {
  if (!error) return false;
  if (/rate limited/i.test(error)) return false;
  return /blocked/i.test(error);
}
import { delistListings, ingestListing } from "./ingest";

/**
 * One collection pass over one source.
 *
 * Written as a single sequential function rather than a fan-out of one job per
 * listing. Fan-out isolates failures better, but it makes run accounting
 * awkward — knowing when a pass has finished means counting children — and this
 * pipeline's whole safety story depends on knowing whether discovery completed.
 * With real volumes measured, splitting it is a small change; guessing now is
 * not.
 */

const DEFAULT_ABORT_THRESHOLD = 0.5;
/** How old a stored page may be before we refetch it even if nothing looks new. */
const REFRESH_AFTER_DAYS = 7;
/**
 * How long one pass may spend re-fetching pages that are merely old.
 *
 * Expressed in minutes rather than listings because the sources differ by a
 * factor of ten in crawl delay: 500 listings is eight minutes on Green-Acres
 * and eighty-three on Superimmo. A time budget means one number is right for
 * all of them, and it is the number an operator actually has — how long the
 * night may be — rather than one they would have to derive.
 *
 * Override per source with `refreshBudgetMinutes` in its config row.
 */
const DEFAULT_REFRESH_BUDGET_MINUTES = 45;
/** Listings per chunk. Keeps any single step short enough to survive a timeout. */
const CHUNK = 25;

export type RunOptions = {
  sourceKey: string;
  communeInsee: string[];
  mode?: "scheduled" | "manual" | "backfill";
  /** Cap for a first pass or a smoke test. */
  limit?: number;
  /**
   * Run even when the source is switched off.
   *
   * The `enabled` flag exists to stop the SCHEDULER touching a source — while
   * its commune slugs are half-configured, while a portal is being renegotiated.
   * It was never meant to overrule a person who typed the source name into a
   * command, which is the only way a smoke test ever happens.
   */
  force?: boolean;
};

export type RunSummary = {
  runId: string;
  status: "done" | "aborted" | "error" | "disabled";
  discovered: number;
  added: number;
  refreshed: number;
  delisted: number;
  failed: number;
  /**
   * Listings actually stored, as opposed to `added`, which is how many
   * discovery decided to go and get.
   *
   * They are equal on a clean pass and nowhere near equal on a curtailed one,
   * and until 2026-08-30 only `added` was reported: a LuxuryEstate pass that
   * stored about a hundred listings and then stopped printed "new 1845".
   */
  ingested: number;
  /**
   * Listings still past the refresh window after this pass took its budgeted
   * share. Reported so a backlog that is growing night over night is visible as
   * a number rather than as listings quietly getting older.
   */
  refreshBacklog?: number;
  /** Why the fetch phase ended before it reached the end of its list. */
  fetchStoppedEarly?: string;
  abortedReason?: string;
  error?: string;
  /**
   * A handful of the actual failures, kept so a run that reports "failed 20"
   * can be diagnosed without re-running it. A count alone tells you something
   * broke; it does not tell you whether the portal refused us, the URL was
   * malformed, or the parser choked — and those need completely different fixes.
   */
  failureSamples?: { externalId: string; url: string; error: string }[];
};

export async function runSource(opts: RunOptions): Promise<RunSummary> {
  const [source] = await db
    .select()
    .from(portalSources)
    .where(eq(portalSources.key, opts.sourceKey))
    .limit(1);

  if (!source) throw new Error(`No portal_sources row with key "${opts.sourceKey}"`);
  if (!source.enabled && !opts.force) {
    return {
      runId: "",
      status: "disabled",
      discovered: 0,
      ingested: 0,
      added: 0,
      refreshed: 0,
      delisted: 0,
      failed: 0,
    };
  }

  const adapter = getAdapter(source.key);

  /**
   * CLOSE OUT RUNS NOBODY IS GOING TO CLOSE.
   *
   * A pass writes `status: 'running'` before it starts and its outcome when it
   * finishes. A process that dies in between — killed, out of memory, a laptop
   * lid closed, a runner cancelled — never reaches the second write, and the
   * row stays `running` for ever. `db/client.ts` names this exact failure:
   * "that is how jobs end up wedged in 'running' with no error anywhere".
   *
   * The dead process cannot fix it, so the next one does. Two such rows were
   * found on 2026-09-01, three and four days old, left by interrupted local
   * runs in August and carried into Supabase by the sync. Harmless to the data
   * and quietly corrosive to every question about what is happening right now.
   *
   * Twelve hours rather than "any running row for this source". The scheduler
   * runs one pass per source at a time, but nothing in the database enforces
   * that, and somebody running `npm run collect` by hand while the nightly is
   * out should not have their live run marked failed underneath them. No
   * legitimate pass has come close: the longest measured is under three hours.
   */
  const abandoned = await db
    .update(portalRuns)
    .set({
      status: "error",
      error: "abandoned — no process ever closed this run",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(portalRuns.sourceId, source.id),
        eq(portalRuns.status, "running"),
        lt(portalRuns.startedAt, new Date(Date.now() - 12 * 60 * 60 * 1000)),
      ),
    )
    .returning({ id: portalRuns.id, startedAt: portalRuns.startedAt });

  for (const a of abandoned) {
    console.warn(
      `[run:${source.key}] closed an abandoned run from ` +
        `${Math.round((Date.now() - a.startedAt.getTime()) / 3_600_000)}h ago (${a.id}) — ` +
        `its process died before recording an outcome`,
    );
  }

  const [run] = await db
    .insert(portalRuns)
    .values({
      sourceId: source.id,
      mode: opts.mode ?? "scheduled",
      communeInsee: opts.communeInsee,
      status: "running",
    })
    .returning({ id: portalRuns.id });

  const runId = run.id;

  /**
   * Which client this source is collected with.
   *
   * Per source, from its own config, never a global switch — see the note at
   * the top of `browser.ts` for when a browser is legitimate here and when it
   * is not. The default stays HTTP: most portals serve it, and Playwright is
   * several hundred megabytes of dependency to load into a run that is only
   * going to read XML.
   *
   * One browser for the whole pass, closed in `finally` — including when the
   * pass throws. A Chromium left running after a failed nightly is the sort of
   * thing that is noticed a week later, as a machine out of memory.
   */
  /**
   * Two browser modes, because the portals that need one do not all need it to
   * the same depth.
   *
   * `browser`            — every request, discovery and listing pages alike.
   * `browser-discovery`  — the browser opens index pages; the ordinary polite
   *                        fetcher does the listing pages.
   *
   * The second is the one to prefer where it works, and on most of these
   * portals it does: the protection sits on search and index pages while
   * listing pages are served to anyone, because scrapers hammer search and
   * listing pages are what a portal wants indexed and shared. Discovery is
   * dozens of pages per run and ingestion is thousands, so routing the whole
   * pass through Chromium multiplies time, memory and page weight for the
   * ninety-nine percent of requests that never needed it.
   *
   * `browser` stays the default meaning for sources already using it. Narrowing
   * a portal that is collecting perfectly well is a change to make deliberately,
   * with a run to look at, not as a side effect of a config rename.
   */
  const cfg = (source.config as Record<string, unknown> | null) ?? {};

  /**
   * Some portals ask us to collect only inside a window of their choosing.
   *
   * A note, not a gate. It used to refuse the run; the operator asked for it to
   * stop doing that, and the call is his — it is his relationship with the
   * portal and his judgement about when to spend it.
   *
   * The condition still lives in config and still says so in the log, because
   * the thing that actually goes wrong here is nobody remembering it existed.
   * LuxuryEstate asked for 01:00-05:00 CET in the same message that granted the
   * browser user-agent, and they said they would be watching their logs — so a
   * daytime pass is a decision worth making on purpose rather than by not
   * knowing.
   */
  const window = cfg.collectWindow as { from: number; to: number; tz: string } | undefined;
  if (window) {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "numeric",
        hour12: false,
        timeZone: window.tz,
      }).format(new Date()),
    );
    const inside =
      window.from <= window.to
        ? hour >= window.from && hour < window.to
        : hour >= window.from || hour < window.to;
    if (!inside) {
      console.warn(
        `[run:${source.key}] outside the hours they asked for ` +
          `(${window.from}:00-${window.to}:00 ${window.tz}, it is ${hour}:00 there) — ` +
          `collecting anyway`,
      );
    }
  }

  /**
   * The slower of what the database says and what the adapter declares.
   *
   * Two records of the same promise, and the run takes whichever is kinder to
   * the portal. This exists because on 2026-08-30 they disagreed and nothing
   * noticed: LuxuryEstate's row still held 1000 ms from before their
   * permission existed, while the adapter, the seed file and the written
   * agreement all said 5000. The collector used the row.
   *
   * A crawl delay that drifts is not a performance detail on this project. On
   * two sources it is the term the access rests on, and the only way we would
   * have learnt we were breaking it is by being blocked — which is exactly how
   * we did learn.
   */
  const declared = adapter.defaultCrawlDelayMs;
  const crawlDelayMs = Math.max(source.crawlDelayMs, declared);
  if (crawlDelayMs !== source.crawlDelayMs) {
    console.warn(
      `[run:${source.key}] the stored crawl delay is ${source.crawlDelayMs}ms but this ` +
        `adapter asks for ${declared}ms — using ${declared}ms. ` +
        `Run npm run db:seed to correct the row.`,
    );
  }

  const extraHeaders = (cfg.extraHeaders as Record<string, string> | undefined) ?? {};
  /** A portal-specified user-agent overrides ours — only ever by agreement. */
  const agent = (cfg.userAgent as string | undefined)?.trim() || USER_AGENT;

  const fetchMode = (source.config as Record<string, unknown> | null)?.fetchMode;
  const useBrowser = fetchMode === "browser" || fetchMode === "browser-discovery";
  const browserForListingsToo = fetchMode === "browser";

  /**
   * Whether this source may open a fresh browser session part-way through a
   * pass, and on what terms.
   *
   * ABSENT ON EVERY SOURCE BUT ONE, and it must stay that way. Starting a new
   * session after a portal has refused us discards the state it recognised us
   * by and returns as a new visitor, which is circumvention wherever it has
   * not been agreed. It is configured for LuxuryEstate alone, on their own
   * written terms, with their thirty-second gap — the letter is quoted in full
   * in that source's `permissionNote`, including what we could and could not
   * verify about it.
   */
  const restartPolicy = cfg.sessionRestart as
    | { maxSessions?: number; waitMs?: number }
    | undefined;

  const browserOptions = {
    delayMs: crawlDelayMs,
    userAgent: agent,
    extraHeaders,
    /** See `readySelector` in browser.ts — six SMC pages a night, silently. */
    readySelector: (cfg.readySelector as string | undefined)?.trim() || undefined,
  };

  let browserSession: BrowserSession | null = null;
  let sessionCount = 1;

  if (useBrowser) {
    browserSession = await createBrowserSession(browserOptions);
    console.log(`[run:${source.key}] browser enabled (fetchMode: ${String(fetchMode)})`);
  }

  /**
   * Handed to the adapter once and stable for the whole pass, so that replacing
   * the session underneath does not leave a stale `fetch` bound to a browser
   * that has been closed.
   */
  const browserFetch: PoliteFetch = (url) => {
    if (!browserSession) throw new Error("the browser session is not open");
    return browserSession.fetch(url);
  };

  const restartBrowserSession = async (waitMs: number): Promise<void> => {
    const closing = browserSession;
    browserSession = null;
    await closing?.close().catch((err) => {
      console.warn(`[run:${source.key}] closing the browser failed: ${(err as Error).message}`);
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    browserSession = await createBrowserSession(browserOptions);
    sessionCount += 1;
  };

  const plainFetcher = createFetcher({
    delayMs: crawlDelayMs,
    userAgent: agent,
    extraHeaders,
  });
  /** Discovery: the browser when there is one. */
  const fetcher = useBrowser ? browserFetch : plainFetcher;

  /**
   * A SITEMAP IS A FILE, NOT A PAGE — fetch it with the plain client even on a
   * browser source.
   *
   * Measured 2026-09-01, first run on a hosted runner:
   *
   *   [sitemap] could not read …/smcSitemapAnnouncement-fr-83_1.xml.gz:
   *             page.goto: Download is starting
   *
   * Chromium does not render `.xml.gz`; it downloads it, and `page.goto`
   * rejects. So SMC's sitemap has never once been read since it became a
   * browser source — every pass silently fell through to
   * "sitemap yielded nothing — falling back to index pages" and crawled the
   * search pages instead.
   *
   * That fallback worked, which is why nobody noticed, and it is the expensive
   * way round in every sense. `sitemap.ts` says why: search pages are what
   * scrapers hammer, so those are the ones portals protect, while the sitemap
   * is the enumeration they publish deliberately. We were knocking on the
   * guarded door while holding an invitation to the open one — and paying forty
   * paginated requests for what one gzipped file answers.
   *
   * The plain client already handles this properly: `fetcher.ts` imports
   * `gunzipSync` for exactly these URLs.
   */
  const SITEMAP_LIKE = /\.(?:xml|gz|xml\.gz)(?:$|[?#])/i;
  const discoveryFetch: PoliteFetch = (url) => {
    if (useBrowser && SITEMAP_LIKE.test(url)) return plainFetcher(url);
    return fetcher(url);
  };
  /** Ingestion: the browser only when this source needs it there too. */
  const listingFetcher = browserForListingsToo ? fetcher : plainFetcher;

  try {
    // ── 1. Discover ───────────────────────────────────────────────────────
    const discovered = new Map<string, DiscoveredListing>();
    let complete = true;
    let discoveryError: string | null = null;
    /**
     * Communes the adapter told us it could not enumerate to the end, and why.
     * First reason wins: the tenth timeout in a row says nothing the first one
     * did not, and the log is more useful naming the cause than counting it.
     */
    const partialCommunes = new Map<string, string>();

    try {
      for await (const item of adapter.discover({
        fetch: discoveryFetch,
        communeInsee: opts.communeInsee,
        config: source.config,
        incomplete: (insee, reason) => {
          if (!partialCommunes.has(insee)) partialCommunes.set(insee, reason);
        },
      })) {
        discovered.set(item.externalId, item);

        /**
         * Discovery used to print nothing at all until it finished.
         *
         * On a fast portal that is invisible; on Superimmo, where a polite
         * ten-second gap between index pages means fifteen minutes of walking
         * before a single listing is fetched, it is a quarter of an hour of a
         * terminal that looks hung. Somebody watching it has no way to tell a
         * working crawl from a wedged one, and the natural response to that is
         * to kill a healthy run.
         *
         * A line per hundred, so a long crawl stays legible and a short one
         * stays quiet.
         */
        if (discovered.size % 100 === 0) {
          console.log(`[run:${source.key}] discovering… ${discovered.size} listings so far`);
        }

        if (opts.limit && discovered.size >= opts.limit) {
          // A capped pass is by definition an incomplete view of the market.
          // Saying so here is what stops it delisting everything it did not reach.
          complete = false;
          break;
        }
      }
    } catch (err) {
      /**
       * Discovery threw partway. Whatever we collected is a fragment, and a
       * fragment must never be treated as the truth about what is on the
       * market — that is precisely how a blocked crawl becomes four hundred
       * false delistings.
       */
      complete = false;
      discoveryError = (err as Error).message;
      if (err instanceof BlockedError) {
        console.warn(`[run:${source.key}] blocked during discovery: ${err.message}`);
      }
    }

    /**
     * "done" only when it was. This line sits after the catch, so on a crawl
     * that threw partway it would otherwise announce a completed discovery over
     * a fragment — the precise misreading the rest of this file exists to
     * prevent, printed in our own log.
     */
    console.log(
      complete
        ? `[run:${source.key}] discovery done — ${discovered.size} listings across ` +
            `${opts.communeInsee.length} communes; working out what is new`
        : `[run:${source.key}] discovery STOPPED EARLY — ${discovered.size} listings ` +
            `collected before it broke off; nothing will be delisted from this pass`,
    );

    await db
      .update(portalRuns)
      .set({ seenCount: discovered.size })
      .where(eq(portalRuns.id, runId));

    // ── 2. What we already knew ───────────────────────────────────────────
    /**
     * SCOPED TO THE COMMUNES THIS PASS ACTUALLY LOOKED AT. This filter is the
     * whole correctness of a partial run.
     *
     * `discovered` only ever contains the communes named in `opts.communeInsee`.
     * Compare it against every active listing for the source and the difference
     * is not "what disappeared from the market" — it is "every other commune",
     * and step 6 delists all of them.
     *
     * That is not hypothetical: it is what `--stale=2` does on its second
     * night. Night one collects two communes; night two asks for the next two,
     * discovers a perfectly healthy set, and silently delists everything from
     * night one. The abort guard does not catch it, because from its point of
     * view the numbers are fine — a full commune's worth of listings was found.
     * The guard watches for a crawl returning too little; this returns the
     * right amount about the wrong place.
     *
     * A listing whose commune never resolved (NULL) is in neither set, so a
     * scoped pass leaves it alone rather than delisting it. Deliberate: this
     * pipeline would rather show a stale listing than invent a disappearance.
     */
    const inThisPass = inArray(portalListings.communeInsee, opts.communeInsee);

    const known = await db
      .select({
        externalId: portalListings.externalId,
        communeInsee: portalListings.communeInsee,
      })
      .from(portalListings)
      .where(
        and(
          eq(portalListings.sourceId, source.id),
          eq(portalListings.status, "active"),
          inThisPass,
        ),
      );

    const staleCutoff = new Date(Date.now() - REFRESH_AFTER_DAYS * 86_400_000);
    const staleWhere = and(
      eq(portalListings.sourceId, source.id),
      eq(portalListings.status, "active"),
      lt(portalListings.updatedAt, staleCutoff),
      inThisPass,
    );

    /**
     * OLDEST FIRST, AND ONLY AS MANY AS THE NIGHT CAN AFFORD.
     *
     * This query used to take everything past the cutoff, unordered and
     * unbounded, which is fine by the hour and ruinous by the calendar: a
     * corpus collected in one burst goes stale in one burst. Every LuxuryEstate
     * listing was fetched on 31 August, so on 7 September all 1645 would come
     * due on the same night — 1645 pages at their agreed five seconds is two
     * hours and seventeen minutes of re-fetching pages that have almost
     * certainly not changed, and Superimmo's 2800 at ten seconds is seven and
     * three quarter hours, which is not a night at all.
     *
     * Note that a matching content hash does NOT save any of that time. The
     * `unchanged` branch in ingest.ts is only reachable after the page has been
     * downloaded; it saves parsing and storage, never the request.
     *
     * Ordering by `updatedAt` makes this a rolling refresh: each pass takes the
     * most neglected listings it has time for and leaves the rest for tomorrow,
     * which also breaks up the burst permanently — after the first bounded
     * pass the ages fan out and stay fanned out.
     *
     * THE COST, STATED PLAINLY: a listing may now go longer than
     * REFRESH_AFTER_DAYS between refreshes — on Superimmo, where the budget
     * buys 270 of 2800, about ten days. That is the deliberate trade. An
     * unbounded queue does not refresh those listings sooner; it produces a
     * pass that overruns its window and gets killed part-way, which refreshes
     * them later AND leaves an open row in portal_runs.
     *
     * New listings are never capped. `added` is the whole point of the pass and
     * is fetched in full; only pages we already hold are rationed.
     */
    const budgetMinutes =
      Number(cfg.refreshBudgetMinutes) > 0
        ? Number(cfg.refreshBudgetMinutes)
        : DEFAULT_REFRESH_BUDGET_MINUTES;
    const refreshLimit = Math.max(1, Math.floor((budgetMinutes * 60_000) / crawlDelayMs));

    const [dueRow] = await db
      .select({ due: sql<number>`count(*)::int` })
      .from(portalListings)
      .where(staleWhere);
    const refreshDue = dueRow?.due ?? 0;

    const staleRows = await db
      .select({ externalId: portalListings.externalId })
      .from(portalListings)
      .where(staleWhere)
      .orderBy(asc(portalListings.updatedAt))
      .limit(refreshLimit);

    if (refreshDue > staleRows.length) {
      /**
       * Said out loud every time it happens. A refresh backlog is invisible by
       * nature — nothing is broken, no page is missing, the counts all look
       * healthy — and the only way it becomes visible is a line like this one
       * appearing night after night with a number that does not come down.
       */
      console.log(
        `[run:${source.key}] ${refreshDue} listings are past the ${REFRESH_AFTER_DAYS}-day ` +
          `refresh window; taking the ${staleRows.length} oldest that fit a ` +
          `${budgetMinutes}-minute budget at ${crawlDelayMs / 1000}s apart. ` +
          `${refreshDue - staleRows.length} roll over to the next pass.`,
      );
    }

    // ── 3. The guard ──────────────────────────────────────────────────────
    const threshold = await getNumberSetting(
      SETTING_KEYS.ABORT_THRESHOLD,
      DEFAULT_ABORT_THRESHOLD,
    );
    const verdict = shouldAbort({
      discovered: discovered.size,
      baseline: known.length,
      threshold,
    });

    if (verdict.abort) {
      const reason = discoveryError
        ? `${verdict.reason} Discovery also errored: ${discoveryError}`
        : verdict.reason;
      await db
        .update(portalRuns)
        .set({ status: "aborted", abortedReason: reason, completedAt: new Date() })
        .where(eq(portalRuns.id, runId));
      console.warn(`[run:${source.key}] aborted — ${reason}`);
      return {
        runId,
        status: "aborted",
        ingested: 0,
        discovered: discovered.size,
        added: 0,
        refreshed: 0,
        delisted: 0,
        failed: 0,
        abortedReason: reason,
      };
    }

    // ── 4. Diff ───────────────────────────────────────────────────────────
    /**
     * The baseline stays whole for the guard above — shrinking it would make a
     * genuinely blocked crawl look proportionally healthier, which is the one
     * thing the guard exists to catch. Only the delisting decision is narrowed.
     */
    const shielded =
      partialCommunes.size === 0
        ? []
        : known
            .filter((k) => k.communeInsee !== null && partialCommunes.has(k.communeInsee))
            .map((k) => k.externalId);

    const diff = diffListings({
      known: known.map((k) => k.externalId),
      discovered: discovered.keys(),
      stale: staleRows.map((s) => s.externalId),
      complete,
      incomplete: shielded,
    });

    for (const [insee, reason] of partialCommunes) {
      console.warn(`[run:${source.key}] ${insee}: incomplete — ${reason}`);
    }

    if (diff.suppressedRemovals.length > 0) {
      console.warn(
        `[run:${source.key}] discovery incomplete — ${diff.suppressedRemovals.length} ` +
          `listings left active rather than delisted`,
      );
    }

    // ── 5. Ingest ─────────────────────────────────────────────────────────
    const toFetch = [...diff.added, ...diff.refresh];
    if (toFetch.length > 0) {
      /**
       * An estimate, from the one number we actually know: our own crawl delay.
       * It ignores parse time and any throttling the portal adds, so it reads
       * low — deliberately, since the alternative is padding a guess and then
       * being wrong in the direction that makes people give up on a run.
       */
      const minutes = Math.round((toFetch.length * crawlDelayMs) / 60_000);
      console.log(
        `[run:${source.key}] fetching ${toFetch.length} listings ` +
          `(${diff.added.length} new, ${diff.refresh.length} due a refresh) — ` +
          `at least ${minutes} min at ${crawlDelayMs / 1000}s apart`,
      );
    }
    let ingested = 0;
    let failed = 0;
    /** Counted separately from `failed`: throttling is not a parser problem. */
    let rateLimited = 0;
    /**
     * Refusals since the last page that came back fine.
     *
     * Reset by any success, which is the whole point — see the refusal branch
     * below for why one 403 is not the portal refusing us.
     */
    let refusalStreak = 0;
    /**
     * Listings actually put through `ingestListing`, which is NOT the loop
     * index. Both stop conditions below jump the index to the end of the list
     * to break out of a nested loop, so reporting progress from it announced a
     * pass that had stopped at a hundred as "1845/1845 fetched".
     */
    let attempted = 0;
    /** Set by whichever stop condition fires, so the summary cannot claim a clean run. */
    let fetchStoppedEarly: string | null = null;
    const failureSamples: { externalId: string; url: string; error: string }[] = [];

    /**
     * A cursor rather than a chunked slice, because a session restart has to
     * resume at the exact listing it stopped on. With `slice` the remainder of
     * the current chunk was simply lost, which is a silent hole of up to
     * twenty-four listings every time — and a hole that only appears on the
     * runs that already went wrong.
     */
    let cursor = 0;
    /** Set when a refusal streak is to be answered with a fresh session. */
    let restartWanted = false;
    /** Listings served since the current session opened, for the guard below. */
    let servedThisSession = 0;

    while (cursor < toFetch.length) {
      const chunkEnd = Math.min(cursor + CHUNK, toFetch.length);
      restartWanted = false;

      for (; cursor < chunkEnd; cursor++) {
        const externalId = toFetch[cursor];
        const target = discovered.get(externalId);
        if (!target) continue;
        attempted += 1;

        const outcome = await ingestListing(
          {
            fetch: listingFetcher,
            adapter,
            sourceId: source.id,
            sourceKey: source.key,
            runId,
          },
          target,
        );

        if (outcome.status === "ingested" || outcome.status === "unchanged") {
          ingested += 1;
          servedThisSession += 1;
          refusalStreak = 0;
        } else {
          failed += 1;
          if (failureSamples.length < 5) {
            failureSamples.push({
              externalId,
              url: target.url,
              error: `${outcome.status}: ${outcome.error ?? "no detail"}`,
            });
          }
        }

        /**
         * Sustained refusal ends the pass. A single one does not.
         *
         * A 403 or a CAPTCHA is the portal refusing us, and carrying on through
         * a wall of them means hammering somewhere we are plainly not welcome.
         * A 429 is a different message — "too fast" — and the fetcher has
         * already slowed everything behind it down.
         *
         * But ONE refusal is neither. On 2026-08-30 LuxuryEstate served 139
         * listings without complaint and then answered 403 on a single URL; the
         * pass stopped there, and the other 1706 — two and a half hours of
         * crawling already paid for in discovery — were abandoned for it. The
         * portal was not refusing us. One listing was unreachable, which is
         * what `failed` is for.
         *
         * Three in a row is the line. At a five-second delay that is fifteen
         * seconds of being told no with nothing getting through, which is a
         * portal that has changed its mind; and because the streak resets on
         * every success, a run that is genuinely being blocked from the start
         * still stops after three requests rather than after a thousand.
         */
        if (outcome.status === "fetch_failed" && isRefusal(outcome.error)) {
          refusalStreak += 1;
          if (refusalStreak >= REFUSAL_STREAK_LIMIT) {
            /**
             * A fresh session, but only where the portal has said we may.
             *
             * Two guards on top of their own thirty seconds. `maxSessions`
             * caps how many times a pass may do this at all; and a session
             * that is refused before it has served anything means the door is
             * shut rather than the session exhausted — starting a third, a
             * fourth and a fifth against that would be knocking until someone
             * opens, which is not what they agreed to and not what we would
             * want done to us.
             */
            const mayRestart =
              useBrowser &&
              restartPolicy !== undefined &&
              sessionCount < (restartPolicy.maxSessions ?? 1) &&
              servedThisSession > 0;

            if (mayRestart) {
              const waitMs = restartPolicy?.waitMs ?? 30_000;
              console.warn(
                `[run:${source.key}] refused ${refusalStreak} times in a row after ` +
                  `${servedThisSession} served in session ${sessionCount} — waiting ` +
                  `${waitMs / 1000}s and opening a new one (their condition), then ` +
                  `resuming at listing ${cursor + 1} of ${toFetch.length}`,
              );
              restartWanted = true;
              cursor += 1;
              break;
            }

            fetchStoppedEarly =
              servedThisSession === 0
                ? `refused ${refusalStreak} times in a row on a session that had served ` +
                  `nothing — the door is shut, not the session spent`
                : `refused ${refusalStreak} times in a row after ${ingested} served` +
                  (restartPolicy ? ` across ${sessionCount} sessions` : "");
            console.warn(
              `[run:${source.key}] ${fetchStoppedEarly} — stopping the pass. ` +
                `Do not simply retry.`,
            );
            cursor = toFetch.length;
            break;
          }
          console.warn(
            `[run:${source.key}] refused on ${target.url} — carrying on ` +
              `(${refusalStreak}/${REFUSAL_STREAK_LIMIT} in a row)`,
          );
        }

        if (outcome.status === "fetch_failed" && /rate limited/i.test(outcome.error ?? "")) {
          rateLimited += 1;
          /**
           * If nearly everything is being throttled, the portal is telling us
           * its answer about volume and there is no point grinding through
           * hundreds of one-minute waits to hear it again.
           */
          if (rateLimited >= 10 && rateLimited > ingested) {
            fetchStoppedEarly =
              `rate limited on ${rateLimited} listings with only ${ingested} through`;
            console.warn(
              `[run:${source.key}] rate limited on ${rateLimited} listings and only ` +
                `${ingested} through — stopping. This portal will not serve a crawl ` +
                `at this size; it needs a raised limit or an overnight schedule.`,
            );
            cursor = toFetch.length;
            break;
          }
        }
      }

      /**
       * Once per chunk rather than once per listing: on a slow source this is
       * the only sign of life for hours, and the night Superimmo ran for four
       * of them it printed nothing between the first line and the summary.
       */
      console.log(
        `[run:${source.key}] ${attempted}/${toFetch.length} ` +
          `fetched (${failed} failed${rateLimited > 0 ? `, ${rateLimited} throttled` : ""})`,
      );

      await db
        .update(portalRuns)
        .set({ fetchedCount: ingested, failedCount: failed })
        .where(eq(portalRuns.id, runId));

      if (restartWanted) {
        await restartBrowserSession(restartPolicy?.waitMs ?? 30_000);
        refusalStreak = 0;
        servedThisSession = 0;
        console.log(
          `[run:${source.key}] session ${sessionCount} open, resuming at ` +
            `${cursor + 1}/${toFetch.length}`,
        );
      }
    }

    if (sessionCount > 1) {
      console.log(
        `[run:${source.key}] used ${sessionCount} browser sessions, ` +
          `${restartPolicy?.waitMs ? restartPolicy.waitMs / 1000 : 30}s apart, as agreed`,
      );
    }

    if (fetchStoppedEarly) {
      console.warn(
        `[run:${source.key}] FETCHING STOPPED EARLY — ${fetchStoppedEarly}. ` +
          `${attempted} of ${toFetch.length} listings were attempted; the rest are ` +
          `untouched and will be picked up by the next pass.`,
      );
    }

    // ── 6. Delist ─────────────────────────────────────────────────────────
    const delisted = await delistListings(source.id, diff.removed, runId);

    // ── 7. Close ──────────────────────────────────────────────────────────
    await db
      .update(portalRuns)
      .set({
        status: "done",
        newCount: diff.added.length,
        goneCount: delisted,
        fetchedCount: ingested,
        parsedCount: ingested,
        failedCount: failed,
        error: [discoveryError, fetchStoppedEarly && `fetch stopped early: ${fetchStoppedEarly}`]
          .filter(Boolean)
          .join(" · ") || null,
        completedAt: new Date(),
      })
      .where(eq(portalRuns.id, runId));

    await db
      .update(portalSources)
      .set({ lastRunAt: new Date() })
      .where(eq(portalSources.id, source.id));

    return {
      runId,
      status: "done",
      discovered: discovered.size,
      added: diff.added.length,
      refreshed: diff.refresh.length,
      refreshBacklog: Math.max(0, refreshDue - staleRows.length),
      delisted,
      failed,
      ingested,
      fetchStoppedEarly: fetchStoppedEarly ?? undefined,
      failureSamples: failureSamples.length > 0 ? failureSamples : undefined,
    };
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(portalRuns)
      .set({ status: "error", error: message.slice(0, 2000), completedAt: new Date() })
      .where(eq(portalRuns.id, runId));
    throw err;
  } finally {
    if (browserSession) {
      await browserSession.close().catch((err) => {
        // Never let a failing teardown mask the run's own outcome.
        console.warn(`[run:${source.key}] browser did not close cleanly:`, (err as Error)?.message);
      });
    }
  }
}

/**
 * Communes to collect for a source: the union across every client subscribed
 * to it.
 *
 * The union rather than per-client passes is the whole point of a shared
 * collector — two clients watching the same coast produce one crawl. Filtering
 * back down to what each client may see happens on the read side.
 */
export async function communesForSource(sourceId: string): Promise<string[]> {
  const rows = await db.execute<{ commune_insee: string }>(sql`
    SELECT DISTINCT unnest(c.commune_insee) AS commune_insee
    FROM clients c
    JOIN client_sources cs ON cs.client_id = c.id
    WHERE cs.source_id = ${sourceId}
      AND cs.enabled = true
      AND c.active = true
  `);
  return rows.rows.map((r) => r.commune_insee);
}

/**
 * The N communes this source has gone longest without collecting.
 *
 * WHY THIS EXISTS
 *
 * Superimmo serves roughly one listing every two minutes, so a first crawl of
 * twelve communes is 66 hours. That is not a single run — it is two communes a
 * night for a week. Without this, somebody has to remember which communes are
 * already done and hand-edit `--communes=` every evening, which is exactly the
 * sort of bookkeeping that gets skipped once and then silently leaves a commune
 * uncollected for a month.
 *
 * With it the nightly command never changes: `--stale=2` takes whichever two
 * are furthest behind, so the backfill works through the list on its own and,
 * once caught up, naturally becomes a round-robin refresh.
 *
 * Never-collected communes sort first — `NULLS FIRST` on the last run — because
 * having nothing at all for a commune is worse than having something slightly
 * stale.
 */
export async function stalestCommunes(sourceId: string, count: number): Promise<string[]> {
  const subscribed = await communesForSource(sourceId);
  if (subscribed.length === 0) return [];

  const rows = await db.execute<{ commune_insee: string; last_run: Date | null }>(sql`
    SELECT c.commune_insee,
           MAX(r.started_at) AS last_run
    FROM unnest(${subscribed}::text[]) AS c(commune_insee)
    LEFT JOIN portal_runs r
      ON r.source_id = ${sourceId}
      AND c.commune_insee = ANY(r.commune_insee)
      -- Only genuinely completed passes count. A run that stopped partway says
      -- nothing about whether the commune was actually collected, and treating
      -- it as done would skip the commune for another full cycle.
      --
      -- Status alone was not enough. A pass whose FETCH phase stops early --
      -- a portal that starts refusing after two hundred listings, which is
      -- LuxuryEstate's behaviour -- still closes as 'done', because it did
      -- finish the work it was able to do. On 2026-08-30 such a run stored 216
      -- of 1726 listings and would have marked all twelve communes freshly
      -- collected, rotating the --stale option away from the 1510 it never
      -- reached.
      --
      -- The error column is where both kinds of incompleteness are recorded,
      -- so it is the honest condition: a pass counts only if nothing curtailed
      -- it. NOTE: no backticks in here, the whole query is a template literal.
      AND r.status = 'done'
      AND r.error IS NULL
    GROUP BY c.commune_insee
    ORDER BY last_run ASC NULLS FIRST, c.commune_insee
    LIMIT ${count}
  `);

  return rows.rows.map((r) => r.commune_insee);
}

/** Sources with at least one active subscriber, for the daily cron to walk. */
/**
 * Every commune any active client watches.
 *
 * The set the collector is responsible for — used by clustering and by the
 * `--source=all` paths, which until 2026-08-31 walked the `COLLECTION_INSEE`
 * constant instead.
 *
 * With one client seeded from that same constant the two were identical, so
 * nothing was visibly wrong. They part company the moment a client's commune
 * list is edited in the database — which is the supported way to change it —
 * and the symptom would be a commune collected but never clustered: listings
 * arriving, no property rows forming, and no error anywhere.
 *
 * The constant remains the *description* of the Gulf of Saint-Tropez — labels,
 * districts, the text fragments that tell Port Grimaud from Grimaud. It is no
 * longer the answer to "what are we collecting", because that is a question
 * about clients.
 */
export async function collectionCommunes(): Promise<string[]> {
  const rows = await db.execute<{ commune_insee: string }>(sql`
    SELECT DISTINCT unnest(commune_insee) AS commune_insee
    FROM clients
    WHERE active = true
  `);
  return rows.rows.map((r) => r.commune_insee).sort();
}

export async function activeSources(): Promise<{ id: string; key: string }[]> {
  const rows = await db
    .select({ id: portalSources.id, key: portalSources.key })
    .from(portalSources)
    .where(eq(portalSources.enabled, true));
  return rows;
}

/**
 * How many refusals in a row mean the portal has closed the door.
 *
 * Three, and the number is a judgement rather than a measurement: it has to be
 * small enough that a run which is being blocked outright stops almost at once,
 * and large enough that one unreachable listing among hundreds served does not
 * throw the pass away. Both of those failures have happened here — the second
 * one on LuxuryEstate, 139 listings in.
 */
const REFUSAL_STREAK_LIMIT = 3;
