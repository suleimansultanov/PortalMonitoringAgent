import { sql } from "drizzle-orm";
import { db } from "./client";

/**
 * Wipe collected market data so a run starts from nothing.
 *
 *   npm run db:reset-data
 *
 * WHY THIS EXISTS
 *
 * Debugging a parser is a loop: fix, re-collect, look at the numbers. But a
 * collector only refetches what changed, so rows written by the broken version
 * survive the fix — and the quality report, which counts the whole table, keeps
 * showing the old damage. We lost a round trip to exactly that today: rooms had
 * gone from 100% missing to 10%, and the headline number still said 53%.
 *
 * WHAT IT DOES NOT TOUCH
 *
 * Sources, clients and buyers survive. Those are configuration and CRM data;
 * re-seeding them every time would be busywork, and blowing away buyer records
 * to debug a parser would be an alarming thing for this command to do quietly.
 *
 * Match rows DO go, because they point at properties that are about to stop
 * existing. That means a dismissal made against test data is lost — acceptable
 * while the buyers are invented, and the reason this refuses to run without
 * --yes once there are real ones.
 */

const TABLES = [
  "buyer_matches",
  "portal_listing_events",
  "portal_snapshots",
  "portal_listings",
  "properties",
  "portal_agencies",
  "portal_runs",
];

async function main(): Promise<void> {
  const confirmed = process.argv.includes("--yes");

  const [{ rows: realBuyers }] = [
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from buyers where is_test_data = false`,
    ),
  ];
  const realCount = Number(realBuyers[0]?.n ?? 0);

  /**
   * Once real buyers exist, their agents' decisions are in buyer_matches, and
   * dropping those is a real loss rather than a tidy-up. Make it deliberate.
   */
  if (realCount > 0 && !confirmed) {
    console.error(
      `\nRefusing: there are ${realCount} real buyers, so buyer_matches holds\n` +
        `decisions people actually made — which this would delete.\n\n` +
        `If you meant it:  npm run db:reset-data -- --yes\n`,
    );
    process.exit(1);
  }

  const before = await counts();

  for (const t of TABLES) {
    await db.execute(sql.raw(`truncate table "${t}" restart identity cascade`));
  }

  console.log(`\nCleared:`);
  for (const [table, n] of Object.entries(before)) {
    if (n > 0) console.log(`  ${String(n).padStart(7)}  ${table}`);
  }
  console.log(`\nKept: sources, clients, buyers.\n`);
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${t}"`));
    out[t] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const e = err as Error & { cause?: { message?: string } };
    console.error("\n[reset-data] failed:", e.cause?.message ?? e.message, "\n");
    process.exit(1);
  });
