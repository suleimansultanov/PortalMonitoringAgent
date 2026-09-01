import { NextRequest, NextResponse } from "next/server";
import { openApiDocument } from "@/lib/api/openapi";

/**
 * GET /docs/openapi — the specification itself.
 *
 * Under /docs rather than under /api/v1, and the difference matters: `/api/v1`
 * is exempted from the session middleware because client instances authenticate
 * with a key, so a spec served from there would be readable by anyone on the
 * internet. Here it sits behind the same login as the rest of our interface,
 * which is where an internal service's documentation belongs.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  /**
   * `servers` is filled in from the request rather than hard-coded, so that
   * "Try it out" points at whatever host you are reading this on — localhost in
   * development, the deployment in production — instead of at a URL somebody
   * has to remember to update.
   */
  const origin = req.nextUrl.origin;
  return NextResponse.json({
    ...openApiDocument,
    servers: [{ url: origin, description: origin.includes("localhost") ? "this machine" : "this deployment" }],
  });
}
