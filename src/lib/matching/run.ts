import "server-only";
import { eq, and, sql, inArray, notInArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyers, buyerMatches, clients, properties } from "@/lib/db/schema";
import { GULF_OF_SAINT_TROPEZ } from "@/lib/portals/communes";
import {
  scoreBuyerMatch,
  type BuyerBrief,
  type PropertyFacts,
} from "./buyers";

/**
 * Run every active buyer against every active property.
 *
 *   npm run match
 *   npm run match -- --dry     score and report, write nothing
 *
 * A full cross product, deliberately. Ten buyers against a few thousand
 * properties is tens of thousands of comparisons of plain arithmetic — well
 * under a second, and it means a buyer whose brief was edited yesterday is
 * re-scored against the whole market rather than only against today's arrivals.
 * If this ever needs to scale, the fix is to narrow by commune first; it is not
 * to make the scoring cleverer.
 *
 * WHAT IS PRESERVED ACROSS RUNS
 *
 * A match an agent has already acted on — sent, or dismissed — keeps its status
 * and its dismissal reason. Re-running must not resurrect something somebody
 * already said no to; that is the fastest way to teach people to ignore a
 * screen. Only the score, the reasons and `updated_at` are refreshed.
 */

const COMMUNE_NAMES: Record<string, string> = Object.fromEntries(
  GULF_OF_SAINT_TROPEZ.filter((c) => !c.localityOf).map((c) => [c.insee, c.label]),
);

function toBrief(row: typeof buyers.$inferSelect): BuyerBrief {
  return {
    id: row.id,
    name: row.name,
    isTestData: row.isTestData,
    budgetMinEur: row.budgetMinEur,
    budgetMaxEur: row.budgetMaxEur,
    communeInsee: row.communeInsee,
    bedroomsMin: row.bedroomsMin,
    roomsMin: row.roomsMin,
    areaMinM2: row.areaMinM2,
    landMinM2: row.landMinM2,
    propertyTypes: row.propertyTypes,
    mustHave: row.mustHave,
    niceToHave: row.niceToHave,
  };
}

function toFacts(row: typeof properties.$inferSelect): PropertyFacts {
  return {
    id: row.id,
    priceEur: row.priceEur,
    // numeric columns come back as strings from the driver — Number(null) is 0,
    // which would silently turn "we don't know the area" into "zero square
    // metres" and fail every area check for a reason nobody could see.
    areaM2: row.areaM2 === null ? null : Number(row.areaM2),
    landM2: row.landM2 === null ? null : Number(row.landM2),
    rooms: row.rooms,
    bedrooms: row.bedrooms,
    propertyType: row.propertyType,
    communeInsee: row.communeInsee,
    text: `${row.title ?? ""} ${row.description ?? ""}`.toLowerCase(),
  };
}

export async function runMatching(opts: { dry?: boolean } = {}): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.slug, "med-estates")).limit(1);
  if (!client) throw new Error("Client med-estates not found — run `npm run db:seed` first.");

  const buyerRows = await db
    .select()
    .from(buyers)
    .where(and(eq(buyers.clientId, client.id), eq(buyers.active, true)));

  const propertyRows = await db
    .select()
    .from(properties)
    .where(eq(properties.status, "active"));

  if (buyerRows.length === 0) {
    console.log("\nNo active buyers. `npm run seed:buyers` adds the test ones.\n");
    return;
  }
  if (propertyRows.length === 0) {
    console.log("\nNo active properties. Run a collection first.\n");
    return;
  }

  const testCount = buyerRows.filter((b) => b.isTestData).length;
  console.log(
    `\nmatching ${buyerRows.length} buyers against ${propertyRows.length} properties` +
      (testCount > 0 ? `  (${testCount} of the buyers are TEST DATA)` : ""),
  );
  if (opts.dry) console.log("dry run — nothing will be written\n");

  const facts = propertyRows.map(toFacts);
  let written = 0;
  let withdrawn = 0;
  let skipped = 0;
  const perBuyer: { name: string; test: boolean; hits: number; best: number }[] = [];

  for (const row of buyerRows) {
    const brief = toBrief(row);
    let hits = 0;
    let best = 0;
    const stillMatching: string[] = [];

    for (const property of facts) {
      const result = scoreBuyerMatch(brief, property, COMMUNE_NAMES);
      if (!result.matched) continue;
      hits++;
      best = Math.max(best, result.score);
      stillMatching.push(property.id);
      if (opts.dry) continue;

      /**
       * `onConflictDoUpdate` with a WHERE guard rather than a plain upsert.
       *
       * Without the guard, re-running would reset a dismissed match back to
       * 'new' and put it in front of the agent again. Doing that once teaches
       * people the screen does not listen; doing it twice teaches them to stop
       * looking.
       */
      await db
        .insert(buyerMatches)
        .values({
          buyerId: brief.id,
          propertyId: property.id,
          score: result.score,
          reasons: result.reasons as unknown as Record<string, unknown>[],
          status: "new",
        })
        .onConflictDoUpdate({
          target: [buyerMatches.buyerId, buyerMatches.propertyId],
          set: {
            score: result.score,
            reasons: result.reasons as unknown as Record<string, unknown>[],
            updatedAt: new Date(),
          },
          // Status and dismissedReason are deliberately absent from `set`: an
          // agent's decision outlives a re-score.
          setWhere: sql`${buyerMatches.status} <> 'dismissed'`,
        });
      written++;
    }

    /**
     * Withdraw matches that no longer qualify.
     *
     * Without this, a match is permanent once written: the price rises out of
     * range, the buyer's brief is edited, the threshold is retuned — and the
     * old row sits there being wrong. This run alone would have left eighteen
     * stale rows behind from a previous pass at a lower threshold.
     *
     * Only untouched rows are removed. A match an agent already sent or
     * dismissed is a record of something a person did, and deleting it would
     * both lose that history and let the same property come back tomorrow as if
     * new. Those two statuses are the memory that stops the screen nagging.
     */
    if (!opts.dry) {
      const stale = await db
        .delete(buyerMatches)
        .where(
          and(
            eq(buyerMatches.buyerId, brief.id),
            inArray(buyerMatches.status, ["new", "seen"]),
            stillMatching.length > 0
              ? notInArray(buyerMatches.propertyId, stillMatching)
              : sql`true`,
          ),
        )
        .returning({ id: buyerMatches.id });
      withdrawn += stale.length;
    }

    if (hits === 0) skipped++;
    perBuyer.push({ name: row.name, test: row.isTestData, hits, best });
  }

  console.log(`\n── matches per buyer ──\n`);
  for (const b of perBuyer.sort((x, y) => y.hits - x.hits)) {
    const tag = b.test ? " [TESTDATA]" : "";
    const summary = b.hits === 0 ? "nothing on the market fits" : `${b.hits} matches, best ${b.best}`;
    console.log(`  ${b.name}${tag}`.padEnd(52) + summary);
  }

  console.log(
    `\n  ${written} match rows written, ${withdrawn} withdrawn, ${skipped} buyers with nothing.\n`,
  );

  if (skipped > 0) {
    console.log(
      `A buyer with nothing is not necessarily a bug — the collection so far is\n` +
        `one commune. Check again once every commune has been crawled.\n`,
    );
  }
}

if (process.argv[1]?.endsWith("run.ts")) {
  runMatching({ dry: process.argv.includes("--dry") })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[match] failed:", (err as Error).message);
      process.exit(1);
    });
}
