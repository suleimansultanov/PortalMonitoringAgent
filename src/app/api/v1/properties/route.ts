import { NextResponse } from "next/server";
import { z } from "zod";
import { DATE_CAVEAT, keyedRoute } from "@/lib/api/guard";
import { scopeCommunes } from "@/lib/api/keys";
import { snapshot } from "@/lib/api/v1";
import { dbErrorMessage } from "@/lib/db/errors";

/**
 * GET /api/v1/properties — the snapshot.
 *
 * What a client instance loads when it starts from empty, and reconciles
 * against periodically. Everything after the first day should come from
 * /api/v1/events instead; walking the whole market daily to find twenty changes
 * is work for both sides and gets slower as the corpus grows.
 */

export const runtime = "nodejs";

const Query = z.object({
  commune: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined)),
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// Key, rate limit and journal: keyedRoute (lib/api/guard.ts).
export const GET = keyedRoute(async (req, scope) => {
  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad query", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    // The intersection, not the request. See scopeCommunes.
    const communes = scopeCommunes(scope, parsed.data.commune);
    const { rows, nextCursor } = await snapshot(scope, {
      communeInsee: communes,
      after: parsed.data.after,
      limit: parsed.data.limit,
    });

    return NextResponse.json({
      properties: rows,
      nextCursor,
      communes,
      caveat: DATE_CAVEAT,
    });
  } catch (err) {
    console.error("[api/v1/properties]", dbErrorMessage(err));
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
});
