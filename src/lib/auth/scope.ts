/**
 * What a signed-in person may read: one client's subscription, and nothing
 * else.
 *
 * Pure — no database, no next-auth — so the decision can be tested on its
 * own. The reading is in `./tenant.ts` (Node only); the screens and the
 * internal API receive the result and never look at the session themselves.
 *
 * THE RULE. Market data is shared (CLAUDE.md, "Tenancy"); a client's
 * subscription to it is not. A client's buyers, matches and reports are its
 * own, and the market it is shown is its communes, read by the sources it
 * subscribes to — the same reach its API key has (lib/api/keys.ts). Until
 * 2026-10-15 the session's `clientId` was never read: the Matches screen
 * listed every client's buyers, `PATCH /api/matches` changed any match by id,
 * and a report opened by uuid whoever owned it. Latent with one client; the
 * first user of a second would have seen Med-Estates' buyers.
 */

/** The part of a scope that market queries need. A session and an API key both have it. */
export type MarketScope = {
  clientId: string;
  /** INSEE codes the client watches. Empty means it watches nothing. */
  communeInsee: string[];
  /** `client_sources` rows that are enabled. Empty means it is shown nothing. */
  sourceIds: string[];
};

export type ClientScope = MarketScope & {
  userId: string;
  clientSlug: string;
  clientName: string;
};

/** One row: the user and the client it belongs to, if any. */
export type ScopeRow = {
  userId: string;
  userActive: boolean;
  clientId: string | null;
  clientSlug: string | null;
  clientName: string | null;
  clientActive: boolean | null;
  communeInsee: string[] | null;
};

export type ScopeRefusal = "unknown-user" | "inactive-user" | "no-client" | "inactive-client";

/**
 * A scope, or the reason there is none.
 *
 * NEVER "everything". A user without a client is refused, admin or not: the
 * fallback that reads every client is the one that leaks, and it would be
 * reached by exactly the account nobody finished setting up. On 2026-10-15
 * the only account in production was an admin with no client, which is why
 * the refusal says what to run rather than just "forbidden".
 */
export function decideScope(
  row: ScopeRow | undefined,
  sourceIds: string[],
): { scope: ClientScope } | { refused: ScopeRefusal } {
  // The JWT outlived the row: a deleted account must not keep reading.
  if (!row) return { refused: "unknown-user" };
  // Read per request, so a deactivated account stops at its next page rather
  // than when its twelve-hour cookie runs out.
  if (!row.userActive) return { refused: "inactive-user" };
  if (!row.clientId || !row.clientSlug) return { refused: "no-client" };
  // The same rule as an API key whose client is inactive (keys.ts).
  if (!row.clientActive) return { refused: "inactive-client" };

  return {
    scope: {
      userId: row.userId,
      clientId: row.clientId,
      clientSlug: row.clientSlug,
      clientName: row.clientName ?? row.clientSlug,
      communeInsee: row.communeInsee ?? [],
      sourceIds,
    },
  };
}

/**
 * Narrow requested communes to the scope. Intersection, never validation —
 * the same rule as `scopeCommunes` for API keys: asking for a commune outside
 * the subscription returns nothing rather than an error that confirms it
 * exists. No request means the whole scope.
 */
export function communesWithin(allowed: string[], requested?: string[]): string[] {
  if (!requested || requested.length === 0) return allowed;
  const ok = new Set(allowed);
  return requested.filter((c) => ok.has(c));
}
