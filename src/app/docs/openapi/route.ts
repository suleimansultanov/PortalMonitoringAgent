import { NextRequest, NextResponse } from "next/server";
import { openApiDocument } from "@/lib/api/openapi";

/**
 * GET /docs/openapi — the specification itself.
 *
 * Readable without a login, like /docs, and on purpose (2026-09-04): its
 * readers are developers building a client instance, who have no account here.
 * It describes endpoints that answer 401 without a key and carries no market
 * data. Until 2026-10-15 this comment said the opposite; the exemption is
 * listed in `PUBLIC_PATHS` (lib/auth/config.ts), and only these two paths are
 * open — not everything under /docs.
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
