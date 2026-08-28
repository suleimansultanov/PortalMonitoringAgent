import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listProperties } from "@/lib/api/queries";

/**
 * GET /api/properties
 *
 * Deduplicated properties with the portals carrying each one.
 *
 * Every parameter is parsed rather than read: a query string is user input even
 * when the only user is our own screen, and `Number(searchParams.get('limit'))`
 * is NaN for anything unexpected, which then flows into a LIMIT clause.
 */

const Query = z.object({
  commune: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined)),
  source: z.string().optional(),
  newWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: NextRequest) {
  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad query", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const q = parsed.data;
  try {
    const { rows, total } = await listProperties({
      communeInsee: q.commune,
      source: q.source,
      newWithinDays: q.newWithinDays,
      minPriceEur: q.minPrice,
      maxPriceEur: q.maxPrice,
      limit: q.limit,
      offset: q.offset,
    });

    return NextResponse.json({
      rows,
      total,
      limit: q.limit,
      offset: q.offset,
      /**
       * Said on every response, not buried in documentation.
       *
       * Only Superimmo publishes a real publication date. For every other source
       * `daysOnMarket` counts from OUR first sighting, so anything already
       * listed when we started watching looks younger than it is. An agent who
       * quotes that number to a client and has to walk it back will not trust
       * the next one.
       */
      caveat:
        "daysOnMarket is measured from our first sighting, not the portal's " +
        "publication date, except on Superimmo. Properties listed before we " +
        "started watching will appear newer than they are.",
    });
  } catch (err) {
    console.error("[api/properties]", err);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
