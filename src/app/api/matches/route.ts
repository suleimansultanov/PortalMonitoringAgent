import { NextRequest, NextResponse } from "next/server";
import { dbErrorMessage } from "@/lib/db/errors";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyerMatches } from "@/lib/db/schema";
import { listMatches } from "@/lib/api/queries";

/**
 * GET  /api/matches   — proposed matches, best first
 * PATCH /api/matches  — an agent acting on one
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
  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad query", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    const rows = await listMatches(parsed.data);
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

  const { id, status, dismissedReason } = parsed.data;
  try {
    const [updated] = await db
      .update(buyerMatches)
      .set({
        status,
        dismissedReason: status === "dismissed" ? (dismissedReason ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(buyerMatches.id, id))
      .returning({ id: buyerMatches.id, status: buyerMatches.status });

    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    console.error("[api/matches PATCH]", dbErrorMessage(err));
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}
