import { NextRequest, NextResponse } from "next/server";
import { authorise } from "@/lib/api/guard";
import { reportById } from "@/lib/api/v1";
import { dbErrorMessage } from "@/lib/db/errors";

/**
 * GET /api/v1/reports/{id} — one frozen period, in full.
 *
 * Including `coverage`: how many communes were being crawled and which portals
 * were enabled when the figures were written. A client comparing two periods
 * needs it — switch a portal on in between and the market appears to grow,
 * which is a fact about the collector rather than about the Var.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<unknown> }) {
  const auth = await authorise(req);
  if ("response" in auth) return auth.response;

  /**
   * Typed loosely and narrowed here, because Next's generated route types
   * declare `params` as `Promise<unknown>` and reject a handler that promises
   * to know its own shape.
   */
  const { id } = (await context.params) as { id?: string };
  if (!id) return NextResponse.json({ error: "no id" }, { status: 400 });

  try {
    const report = await reportById(auth.scope, id);
    if (!report) {
      // Not "forbidden": whether a report exists that belongs to somebody else
      // is not this client's business either.
      return NextResponse.json({ error: "no such report" }, { status: 404 });
    }
    return NextResponse.json({ report });
  } catch (err) {
    console.error("[api/v1/reports/id]", dbErrorMessage(err));
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
