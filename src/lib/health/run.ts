import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { dataHealthChecks } from "@/lib/db/schema";
import type { FeedProperty } from "./contract";
import { loadHealthInput, scopeFor } from "./load";
import { runPortalChecks, tally, type CheckResult, type Tally } from "./portalChecks";
import type { Status } from "./rules";

/**
 * Data health: what the client's app would conclude about tonight's feed, and
 * what we conclude.
 *
 *   npm run health                     report, reads only
 *   npm run health -- --all            greens too
 *   npm run health -- --write          and store the run, which the checks that
 *                                      compare with their own past need
 *   npm run health -- --as-of=<ISO>    judge the windows as of that moment, to
 *                                      compare with a screenshot from then
 *   npm run health -- --json=<path>    every row, for a diff
 *   npm run health -- --feed=<path>    judge a feed saved earlier ({ "rows": [...] })
 *                                      instead of reading it again: the feed is
 *                                      most of what a run downloads
 *
 * The two tallies at the top answer different questions. "Vault rules" should
 * match the client's Settings → Data health, portal block, and is how the copy is
 * checked. "Our reading" is what is worth fixing. See rules.ts and portalChecks.ts.
 */

const CLIENT = "med-estates";
/** A nightly a day for two months; the same retention as the client's. */
const KEEP_DAYS = 60;

export async function runHealth(opts: { client?: string; now?: Date; write?: boolean; feed?: FeedProperty[] } = {}): Promise<CheckResult[]> {
  const now = opts.now ?? new Date();
  const scope = await scopeFor(opts.client ?? CLIENT);
  const results = runPortalChecks(await loadHealthInput(scope, now, opts.feed));

  if (opts.write) {
    for (let i = 0; i < results.length; i += 200) {
      await db.insert(dataHealthChecks).values(
        results.slice(i, i + 200).map((r) => ({
          clientId: scope.clientId,
          ranAt: now,
          checkKey: r.key,
          source: r.source,
          vaultStatus: r.vault,
          ourStatus: r.ours,
          value: r.value === null || !Number.isFinite(r.value) ? null : r.value,
          expected: r.expected,
          message: r.message.slice(0, 1000),
          note: r.note,
          detail: r.detail,
        })),
      );
    }
    await db
      .delete(dataHealthChecks)
      .where(and(eq(dataHealthChecks.clientId, scope.clientId), lt(dataHealthChecks.ranAt, new Date(now.getTime() - KEEP_DAYS * 86_400_000))));
  }
  return results;
}

const counts = (t: Tally) => `${t.red} red, ${t.amber} amber, ${t.green} green${t.unknown ? `, ${t.unknown} too little data` : ""} (${t.checks} checks)`;

/** The line in the nightly summary, and what to print under it. Stores the run. */
export async function healthLine(): Promise<{ line: string; worst: string[] }> {
  const results = await runHealth({ write: true });
  const vault = tally(results, "vault");
  const ours = tally(results, "ours");
  return {
    line: `data health: ${ours.red} red, ${ours.amber} amber by our reading; ${vault.red} red, ${vault.amber} amber by the client's rules — \`npm run health\` lists them`,
    worst: results.filter((r) => r.ours === "red").map(describe),
  };
}

const describe = (r: CheckResult) => `${r.label}${r.source ? ` [${r.source}]` : ""}: ${r.message}`;

function printRows(title: string, rows: CheckResult[], side: "vault" | "ours"): void {
  console.log(`\n${title}: ${rows.length}`);
  for (const r of rows) {
    const status = (r[side] ?? "").toUpperCase().padEnd(6);
    console.log(`  ${status} ${r.label}${r.source ? ` [${r.source}]` : ""}`);
    console.log(`         ${r.message}`);
    console.log(`         Expected: ${r.expected}`);
    if (side === "vault" && r.ours !== r.vault) {
      console.log(`         Ours: ${r.ours ?? "not judged, see the rows below"}${r.note ? ` — ${r.note}` : ""}`);
    }
    if (side === "ours" && typeof r.detail.sample === "string") console.log(`         e.g. ${r.detail.sample}`);
  }
}

const RANK: Record<Status, number> = { red: 0, amber: 1, unknown: 2, green: 3 };
const bySeverity = (side: "vault" | "ours") => (a: CheckResult, b: CheckResult) =>
  RANK[a[side] ?? "green"] - RANK[b[side] ?? "green"] || a.label.localeCompare(b.label) || a.source.localeCompare(b.source);

async function main(): Promise<void> {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const all = process.argv.includes("--all");
  const write = process.argv.includes("--write");
  const asOf = arg("as-of");
  const now = asOf ? new Date(asOf) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--as-of=${asOf} is not a date`);

  const feedFile = arg("feed");
  const feed = feedFile ? z.object({ rows: z.array(z.custom<FeedProperty>()) }).parse(JSON.parse(await fs.readFile(feedFile, "utf8"))).rows : undefined;

  const results = await runHealth({ now, write, feed });

  console.log(`\nDATA HEALTH, ${CLIENT}, as of ${now.toISOString()}${write ? " (stored)" : " (read only)"}`);
  console.log(`  By the client's rules (vault eaed31c): ${counts(tally(results, "vault"))}`);
  console.log(`  By our reading:                        ${counts(tally(results, "ours"))}`);

  const shown: Status[] = all ? ["red", "amber", "unknown", "green"] : ["red", "amber"];
  printRows("AS THE CLIENT'S SCREEN SHOWS IT", results.filter((r) => r.vault !== null && shown.includes(r.vault)).sort(bySeverity("vault")), "vault");
  printRows("OUR READING: WHAT IS WORTH FIXING", results.filter((r) => r.ours !== null && shown.includes(r.ours)).sort(bySeverity("ours")), "ours");

  console.log(
    "\nNot reproduced: vault's \"kept the last good value\" rows and its ×5 price hold, which need the last read it stored;" +
      "\nits Apimo, CRM, enquiry, matching and document checks, which are its own data.\n",
  );

  const json = arg("json");
  if (json) {
    await fs.writeFile(json, JSON.stringify(results, null, 2), "utf8");
    console.log(`Every row written to ${json}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
