import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { apiUsage, sourceCommuneState } from "@/lib/db/schema";
import type { LedgerStore } from "./streamV1";

/**
 * The meter's ledger in the database — for the nightly runner, whose disk is
 * gone by morning while the month's count must not be, and for the Mac's
 * tools, so that every process that can spend shares one cap. One row per
 * entry; the period's total is a sum. No response cache: pages are stored by
 * ingest as the listing's document, which is what a re-read is for.
 */
export function dbLedgerStore(sourceKey: string): LedgerStore {
  return {
    async totals(since) {
      const [t] = await db
        .select({
          items: sql<number>`coalesce(sum(${apiUsage.items}), 0)::int`,
          /** Reservations with no settle row: in flight, or never came back. */
          uncertain: sql<number>`coalesce(sum(${apiUsage.items}) filter (
            where ${apiUsage.kind} = 'reserve' and not exists (
              select 1 from ${apiUsage} s where s.kind = 'settle' and s.request_id = ${apiUsage.requestId}
            )), 0)::int`,
          // Rows from before `kind` existed are settled paid pages.
          paidRequests: sql<number>`count(*) filter (where ${apiUsage.kind} in ('reserve', 'legacy') or (${apiUsage.kind} is null and ${apiUsage.paid}))::int`,
          freeRequests: sql<number>`count(*) filter (where ${apiUsage.kind} = 'count' or (${apiUsage.kind} is null and not ${apiUsage.paid}))::int`,
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
        paid: e.kind === "reserve" || e.kind === "legacy",
        kind: e.kind,
        requestId: e.requestId ?? null,
        query: e.query,
        items: e.items,
        uncertain: e.kind === "reserve",
        note: e.note ?? null,
      });
    },
  };
}

/** The adapter's own per-commune watermark. See `source_commune_state` in drizzle/0008. */
export type CommuneState = Record<string, unknown>;

export async function getCommuneState(sourceKey: string, communeInsee: string): Promise<CommuneState> {
  const [row] = await db
    .select({ state: sourceCommuneState.state })
    .from(sourceCommuneState)
    .where(and(eq(sourceCommuneState.sourceKey, sourceKey), eq(sourceCommuneState.communeInsee, communeInsee)))
    .limit(1);
  return row?.state ?? {};
}

export async function setCommuneState(sourceKey: string, communeInsee: string, state: CommuneState): Promise<void> {
  await db
    .insert(sourceCommuneState)
    .values({ sourceKey, communeInsee, state })
    .onConflictDoUpdate({
      target: [sourceCommuneState.sourceKey, sourceCommuneState.communeInsee],
      set: { state, updatedAt: new Date() },
    });
}
