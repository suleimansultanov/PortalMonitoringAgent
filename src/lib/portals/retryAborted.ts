import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { pickRetries } from "./retryRule";

/**
 * Prints the sources the morning retry should collect again, as one comma list
 * on stdout (empty when there are none); the reasons, kept and refused, go to
 * stderr. Reads only. The rule and why it is shaped so: `retryRule.ts`.
 *
 *   npx tsx src/lib/portals/retryAborted.ts
 *   npx tsx src/lib/portals/retryAborted.ts --at=2026-11-10T06:30:00Z   rehearse a past morning
 *
 * `.github/workflows/retry.yml` runs it at 06:30 UTC and dispatches collect.yml
 * with `sources=<the list>`.
 */

const runRow = z.object({
  source_key: z.string(),
  enabled: z.boolean(),
  config: z.unknown(),
  status: z.string().nullable(),
  mode: z.string().nullable(),
  started_at: z.coerce.date().nullable(),
});

async function main(): Promise<void> {
  const atArg = process.argv.find((a) => a.startsWith("--at="))?.slice("--at=".length);
  const now = atArg ? new Date(atArg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--at=${atArg} is not a date`);

  // The latest two runs per source started by `now`: all the rule reads.
  const result = await db.execute(sql`
    select s.key as source_key, s.enabled, s.config, r.status, r.mode, r.started_at
    from portal_sources s
    left join lateral (
      select status, mode, started_at from portal_runs
      where source_id = s.id and started_at <= ${now.toISOString()}::timestamptz
      order by started_at desc limit 2
    ) r on true
  `);
  const rows = z.array(runRow).parse(result.rows);

  const sources = new Map(rows.map((r) => [r.source_key, { key: r.source_key, enabled: r.enabled, config: r.config }]));
  const runs = rows.flatMap((r) =>
    r.status && r.mode && r.started_at ? [{ sourceKey: r.source_key, status: r.status, mode: r.mode, startedAt: r.started_at }] : [],
  );

  const verdicts = pickRetries([...sources.values()], runs, now);
  // Judged with today's `enabled` flags and configs: a rehearsal of a past morning is not a replay of it.
  const picked = verdicts.filter((v) => v.retry).length;
  console.error(
    `[retry] ${now.toISOString()}: ` +
      (verdicts.length === 0 ? "no source failed in the night just gone" : `${verdicts.length} failed, ${picked} to retry`),
  );
  for (const v of verdicts) console.error(`[retry]   ${v.retry ? "RETRY" : "leave"}  ${v.key} — ${v.why}`);
  process.stdout.write(verdicts.filter((v) => v.retry).map((v) => v.key).join(",") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
