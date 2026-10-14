import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { apiUsage, portalListings, portalRuns, portalSources } from "@/lib/db/schema";
import type { LedgerStore } from "./streamV1";

/**
 * The meter's ledger in the database — for the nightly runner, whose disk is
 * gone by morning while the month's count must not be. One row per request;
 * the period's total is a sum. No response cache: pages are stored by ingest
 * as the listing's document, which is what a re-read is for.
 */
export function dbLedgerStore(sourceKey: string): LedgerStore {
  return {
    async totals(since) {
      const [t] = await db
        .select({
          items: sql<number>`coalesce(sum(${apiUsage.items}), 0)::int`,
          uncertain: sql<number>`coalesce(sum(${apiUsage.items}) filter (where ${apiUsage.uncertain}), 0)::int`,
          paidRequests: sql<number>`count(*) filter (where ${apiUsage.paid})::int`,
          freeRequests: sql<number>`count(*) filter (where not ${apiUsage.paid})::int`,
        })
        .from(apiUsage)
        .where(and(eq(apiUsage.sourceKey, sourceKey), gte(apiUsage.at, since)));
      return {
        items: Number(t?.items ?? 0),
        uncertain: Number(t?.uncertain ?? 0),
        paidRequests: Number(t?.paidRequests ?? 0),
        freeRequests: Number(t?.freeRequests ?? 0),
      };
    },
    async append(e) {
      await db.insert(apiUsage).values({
        sourceKey,
        at: e.at,
        paid: e.paid,
        query: e.query,
        items: e.items,
        uncertain: e.uncertain,
        note: e.note ?? null,
      });
    },
  };
}

/**
 * Whether this source already holds live listings in a commune. A commune
 * with none takes the stock; one with some asks for changes. Per commune,
 * not per source: a first pass that stopped at the cap after four communes
 * must not leave the other eight reading "changes" to a stock they never had.
 */
export async function hasStock(sourceKey: string, communeInsee: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(portalListings)
    .innerJoin(portalSources, eq(portalSources.id, portalListings.sourceId))
    .where(and(eq(portalSources.key, sourceKey), eq(portalListings.communeInsee, communeInsee), eq(portalListings.status, "active")))
    .limit(1);
  return !!row;
}

/**
 * When this source last finished a pass that can be built on: the newest
 * `done` or `partial` run with no error. A changes-only pass asks for what
 * moved since then; a source with no such pass takes the stock.
 */
export async function lastCompletedPassAt(sourceKey: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: portalRuns.completedAt })
    .from(portalRuns)
    .innerJoin(portalSources, eq(portalSources.id, portalRuns.sourceId))
    .where(
      and(
        eq(portalSources.key, sourceKey),
        or(eq(portalRuns.status, "done"), eq(portalRuns.status, "partial")),
        isNull(portalRuns.error),
      ),
    )
    .orderBy(desc(portalRuns.completedAt))
    .limit(1);
  return row?.at ?? null;
}
