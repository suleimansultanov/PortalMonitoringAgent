import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalSources } from "@/lib/db/schema";

/**
 * Switch a source on or off for the nightly pass, and see where they all stand.
 *
 *   npm run source                     — list every source, on or off
 *   npm run source -- --enable=bienici
 *   npm run source -- --disable=figaro
 *
 * Written 2026-09-28 because the only way to do this was an UPDATE typed into
 * the Supabase console, and `seed` deliberately never touches `enabled` (so a
 * re-seed cannot switch a source back on behind whoever turned it off). The
 * scheduler reads this flag; `npm run collect -- --source=X` ignores it, which
 * is how a source is tried by hand before it is switched on.
 */

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];

async function main(): Promise<void> {
  for (const [flag, enabled] of [["enable", true], ["disable", false]] as const) {
    const key = arg(flag);
    if (!key) continue;
    const rows = await db
      .update(portalSources)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(portalSources.key, key))
      .returning({ key: portalSources.key });
    if (rows.length === 0) throw new Error(`no source "${key}" — run \`npm run db:seed\` first?`);
    console.log(`${key}: ${enabled ? "ON" : "OFF"}`);
  }

  const all = await db
    .select({ key: portalSources.key, enabled: portalSources.enabled, lastRunAt: portalSources.lastRunAt })
    .from(portalSources)
    .orderBy(portalSources.key);
  console.log();
  for (const s of all) {
    console.log(
      `  ${s.key.padEnd(14)} ${s.enabled ? "on " : "OFF"}   last run ${s.lastRunAt ? s.lastRunAt.toISOString().slice(0, 16) : "never"}`,
    );
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[source] failed:", (err as Error).message);
    process.exit(1);
  });
