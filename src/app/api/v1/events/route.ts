import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorise, DATE_CAVEAT } from "@/lib/api/guard";
import { scopeCommunes } from "@/lib/api/keys";
import { decodeCursor, events } from "@/lib/api/v1";
import { dbErrorMessage } from "@/lib/db/errors";

/**
 * GET /api/v1/events — the delta.
 *
 * What happened, rather than what changed. A price cut and a re-listing are
 * different things to a client instance, and `updated_at` cannot tell them
 * apart.
 *
 * Walk it: call with no cursor, act on the page, store `nextCursor`, call again
 * with `since=` until `nextCursor` is null. The cursor encodes
 * (occurred_at, id) — the pair, so that two events written in the same
 * millisecond cannot step over one another.
 *
 * PULL WHEN THE COLLECTION MOVES, NOT ON A CLOCK. /api/v1/status carries
 * `lastSuccessfulCollectionAt`; an instance that polls on its own schedule will
 * eventually read while a pass is still running and show an agent a market that
 * is half a night old, without saying so.
 */

export const runtime = "nodejs";

const TYPES = ["listed", "price_changed", "delisted", "relisted", "availability_changed", "updated"] as const;

const Query = z.object({
  since: z.string().optional(),
  commune: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined)),
  type: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .refine((v) => !v || v.every((t) => (TYPES as readonly string[]).includes(t)), {
      message: `type must be one of: ${TYPES.join(", ")}`,
    }),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function GET(req: NextRequest) {
  const auth = await authorise(req);
  if ("response" in auth) return auth.response;

  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad query", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  /**
   * A malformed cursor is refused rather than treated as "from the beginning".
   * Silently restarting the walk would replay the entire history as if it were
   * new, and an instance acting on `listed` events would notify an agency about
   * every property it already knows.
   */
  if (parsed.data.since && !decodeCursor(parsed.data.since)) {
    return NextResponse.json(
      { error: "bad cursor", detail: "Pass the nextCursor from a previous response." },
      { status: 400 },
    );
  }

  try {
    const communes = scopeCommunes(auth.scope, parsed.data.commune);
    const { rows, nextCursor } = await events(auth.scope, {
      communeInsee: communes,
      since: parsed.data.since,
      types: parsed.data.type,
      limit: parsed.data.limit,
    });

    return NextResponse.json({
      events: rows,
      nextCursor,
      /** Null means caught up, not "no more pages ever". Call again later. */
      caughtUp: nextCursor === null,
      caveat: DATE_CAVEAT,
    });
  } catch (err) {
    console.error("[api/v1/events]", dbErrorMessage(err));
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
