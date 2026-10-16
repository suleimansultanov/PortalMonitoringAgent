import { NextResponse } from "next/server";
import { keyedRoute } from "@/lib/api/guard";
import { status } from "@/lib/api/v1";
import { dbErrorMessage } from "@/lib/db/errors";

/**
 * GET /api/v1/status — is what you are about to read current?
 *
 * The field that matters is `lastSuccessfulCollectionAt`. An instance should
 * pull when it advances rather than on a schedule of its own: agreeing on times
 * between two systems fails the first night a pass runs long, and passes here
 * run long by design — the refresh budget varies with what has fallen due.
 *
 * "Successful" means the pass finished, not that the row says done. A pass
 * whose fetching stopped part-way is still stored with status 'done' and the
 * reason only in `error`, so the query behind this excludes those explicitly.
 * Reporting a half-collected night as complete is how an instance ends up
 * matching buyers against a market that is missing a portal.
 */

export const runtime = "nodejs";

// Key, rate limit and journal: keyedRoute (lib/api/guard.ts).
export const GET = keyedRoute(async (_req, scope) => {
  try {
    const s = await status(scope);
    return NextResponse.json({
      client: scope.clientSlug,
      communes: scope.communeInsee,
      ...s,
    });
  } catch (err) {
    console.error("[api/v1/status]", dbErrorMessage(err));
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
});
