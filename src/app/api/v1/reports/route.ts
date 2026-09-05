import { NextRequest, NextResponse } from "next/server";
import { authorise } from "@/lib/api/guard";
import { reportList } from "@/lib/api/v1";
import { dbErrorMessage } from "@/lib/db/errors";

/**
 * GET /api/v1/reports — the periods that have been frozen, newest first.
 *
 * Summaries only: the headline figures and the warnings, which is what a list
 * of periods needs to render. The per-commune and per-agency tables come with
 * the single report, because they are large and nobody reads twelve of them at
 * once.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await authorise(req);
  if ("response" in auth) return auth.response;

  try {
    const reports = await reportList(auth.scope);
    return NextResponse.json({
      reports,
      caveat:
        "A report is what we could see during that period, at the coverage we " +
        "had. `warnings` says when a comparison between two periods would be " +
        "misleading — read it before drawing a trend.",
    });
  } catch (err) {
    console.error("[api/v1/reports]", dbErrorMessage(err));
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
