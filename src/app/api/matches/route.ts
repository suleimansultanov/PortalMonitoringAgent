import { NextRequest, NextResponse } from "next/server";
import { dbErrorMessage } from "@/lib/db/errors";
import { z } from "zod";
import { listMatches, setMatchStatus } from "@/lib/api/queries";
import { clientForRequest } from "@/lib/auth/tenant";

/**
 * GET  /api/matches   — proposed matches, best first
 * PATCH /api/matches  — an agent acting on one
 *
 * Both read and write the signed-in account's client's matches and nothing
 * else (lib/auth/tenant.ts). Until 2026-10-15 GET listed every client's buyers
 * and PATCH changed any match by id.
 *
 * `includeTestData` defaults to FALSE. The invented buyers must not pad a count
 * anyone might act on; asking for them is a deliberate act, and the rows that
 * come back carry `buyer.isTestData` so the screen can label them.
 */

const Query = z.object({
  buyerId: z.string().uuid().optional(),
  includeTestData: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  includeDismissed: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(300).default(100),
});

export async function GET(req: NextRequest) {
  const client = await clientForRequest();
  if ("response" in client) return client.response;

  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad query", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    const rows = await listMatches(client.scope, parsed.data);
    return NextResponse.json({
      rows,
      total: rows.length,
      testDataIncluded: parsed.data.includeTestData,
    });
  } catch (err) {
    console.error("[api/matches]", dbErrorMessage(err));
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}

const Patch = z.object({
  id: z.string().uuid(),
  status: z.enum(["new", "seen", "sent", "dismissed"]),
  /**
   * Why it was dismissed. Optional, and the most valuable field in the schema:
   * it is the only feedback the scoring will ever get about being wrong. The
   * weights and the threshold are currently arguments between humans; a few
   * hundred of these turn them into something with evidence behind it.
   */
  dismissedReason: z.string().max(500).optional(),
});

export async function PATCH(req: NextRequest) {
  const client = await clientForRequest();
  if ("response" in client) return client.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = Patch.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad body", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    // Another client's match answers "not found": its existence is not ours to confirm.
    const updated = await setMatchStatus(client.scope, parsed.data);
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    console.error("[api/matches PATCH]", dbErrorMessage(err));
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}
