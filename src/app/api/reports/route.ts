import { NextResponse } from "next/server";
import { dbErrorMessage } from "@/lib/db/errors";
import { agencyStats, communeStats, overview } from "@/lib/api/queries";

/**
 * GET /api/reports
 *
 * The market view: per-commune medians, who is carrying the stock, and the
 * headline counts.
 *
 * Everything here is a MEDIAN. One 30M villa in Ramatuelle pulls an average
 * clean away from anything an agent would recognise as the local price, and a
 * report whose numbers do not match what they see on the ground is a report
 * they stop opening.
 */

export async function GET() {
  try {
    const [communes, agencies, head] = await Promise.all([
      communeStats(),
      agencyStats(),
      overview(),
    ]);

    /**
     * Warnings travel WITH the data, not in a wiki.
     *
     * Both of these change how a number should be read, and both are invisible
     * from the number itself. Days-on-market is measured from our own first
     * sighting for every source except Superimmo. And a market summary built
     * from one crawled commune out of twelve looks like a complete picture
     * unless something says otherwise.
     */
    const warnings: string[] = [
      "Days on market are measured from our first sighting, not the portal's " +
        "publication date, except on Superimmo. Anything already listed before " +
        "we started watching will look newer than it is.",
    ];

    const covered = communes.filter((c) => c.active > 0).length;
    if (covered < 12) {
      warnings.push(
        `Only ${covered} of 12 communes have any stock collected so far. ` +
          `Comparisons between communes are not meaningful yet.`,
      );
    }
    if (head.buyersTest > 0) {
      warnings.push(
        `${head.buyersTest} of the buyers are TEST DATA seeded for development ` +
          `and are excluded from match counts by default.`,
      );
    }
    const idle = head.sources.filter((s) => !s.enabled).map((s) => s.key);
    if (idle.length > 0) {
      warnings.push(`Sources not enabled: ${idle.join(", ")}. Their stock is missing entirely.`);
    }

    return NextResponse.json({ overview: head, communes, agencies, warnings });
  } catch (err) {
    console.error("[api/reports]", dbErrorMessage(err));
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
