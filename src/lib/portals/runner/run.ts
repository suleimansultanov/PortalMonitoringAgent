import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalListings, portalRuns, portalSources } from "@/lib/db/schema";
import { getNumberSetting, SETTING_KEYS } from "@/lib/settings/store";
import { getAdapter } from "../registry";
import type { DiscoveredListing } from "../types";
import { diffListings, shouldAbort } from "./diff";
import { createFetcher, BlockedError } from "./fetcher";

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
      added: 0,
      refreshed: 0,
      delisted: 0,
      failed: 0,
    };
  }

  const adapter = getAdapter(source.key);
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
  const fetcher = createFetcher({ delayMs: source.crawlDelayMs });

  try {
    // ── 1. Discover ───────────────────────────────────────────────────────
    const discovered = new Map<string, DiscoveredListing>();
    let complete = true;
    let discoveryError: string | null = null;

    try {
      for await (const item of adapter.discover({
        fetch: fetcher,
        communeInsee: opts.communeInsee,
        config: source.config,
      })) {
        discovered.set(item.externalId, item);
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

    await db
      .update(portalRuns)
      .set({ seenCount: discovered.size })
      .where(eq(portalRuns.id, runId));

    // ── 2. What we already knew ───────────────────────────────────────────
    const known = await db
      .select({ externalId: portalListings.externalId })
      .from(portalListings)
      .where(
        and(eq(portalListings.sourceId, source.id), eq(portalListings.status, "active")),
      );

    const staleCutoff = new Date(Date.now() - REFRESH_AFTER_DAYS * 86_400_000);
    const staleRows = await db
      .select({ externalId: portalListings.externalId })
      .from(portalListings)
      .where(
        and(
          eq(portalListings.sourceId, source.id),
          eq(portalListings.status, "active"),
          lt(portalListings.updatedAt, staleCutoff),
        ),
      );

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
        discovered: discovered.size,
        added: 0,
        refreshed: 0,
        delisted: 0,
        failed: 0,
        abortedReason: reason,
      };
    }

    // ── 4. Diff ───────────────────────────────────────────────────────────
    const diff = diffListings({
      known: known.map((k) => k.externalId),
      discovered: discovered.keys(),
      stale: staleRows.map((s) => s.externalId),
      complete,
    });

    if (diff.suppressedRemovals.length > 0) {
      console.warn(
        `[run:${source.key}] discovery incomplete — ${diff.suppressedRemovals.length} ` +
          `listings left active rather than delisted`,
      );
    }

    // ── 5. Ingest ─────────────────────────────────────────────────────────
    const toFetch = [...diff.added, ...diff.refresh];
    let ingested = 0;
    let failed = 0;
    /** Counted separately from `failed`: throttling is not a parser problem. */
    let rateLimited = 0;
    const failureSamples: { externalId: string; url: string; error: string }[] = [];

    for (let i = 0; i < toFetch.length; i += CHUNK) {
      const chunk = toFetch.slice(i, i + CHUNK);
      for (const externalId of chunk) {
        const target = discovered.get(externalId);
        if (!target) continue;

        const outcome = await ingestListing(
          {
            fetch: fetcher,
            adapter,
            sourceId: source.id,
            sourceKey: source.key,
            runId,
          },
          target,
        );

        if (outcome.status === "ingested" || outcome.status === "unchanged") {
          ingested += 1;
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
         * "Blocked" ends the pass. "Rate limited" does not.
         *
         * A 403 or a CAPTCHA is the portal refusing us, and carrying on means
         * hammering somewhere we are not welcome. A 429 is the portal saying we
         * are asking too fast — the fetcher has already slowed the pacing down
         * for everything that follows, and the right move is to lose this one
         * listing and keep going.
         *
         * Conflating them cost a real run: 60 listings discovered, ONE ingested,
         * because a single stubborn URL aborted everything queued behind it.
         */
        if (outcome.status === "fetch_failed" && isRefusal(outcome.error)) {
          console.warn(`[run:${source.key}] refused during ingest, stopping pass`);
          i = toFetch.length;
          break;
        }

        if (outcome.status === "fetch_failed" && /rate limited/i.test(outcome.error ?? "")) {
          rateLimited += 1;
          /**
           * If nearly everything is being throttled, the portal is telling us
           * its answer about volume and there is no point grinding through
           * hundreds of one-minute waits to hear it again.
           */
          if (rateLimited >= 10 && rateLimited > ingested) {
            console.warn(
              `[run:${source.key}] rate limited on ${rateLimited} listings and only ` +
                `${ingested} through — stopping. This portal will not serve a crawl ` +
                `at this size; it needs a raised limit or an overnight schedule.`,
            );
            i = toFetch.length;
            break;
          }
        }
      }

      await db
        .update(portalRuns)
        .set({ fetchedCount: ingested, failedCount: failed })
        .where(eq(portalRuns.id, runId));
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
        error: discoveryError,
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
      delisted,
      failed,
      failureSamples: failureSamples.length > 0 ? failureSamples : undefined,
    };
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(portalRuns)
      .set({ status: "error", error: message.slice(0, 2000), completedAt: new Date() })
      .where(eq(portalRuns.id, runId));
    throw err;
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

/** Sources with at least one active subscriber, for the daily cron to walk. */
export async function activeSources(): Promise<{ id: string; key: string }[]> {
  const rows = await db
    .select({ id: portalSources.id, key: portalSources.key })
    .from(portalSources)
    .where(eq(portalSources.enabled, true));
  return rows;
}
