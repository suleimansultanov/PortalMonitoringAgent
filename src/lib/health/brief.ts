import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { scopeFor } from "./load";
import { LABELS, type CheckResult } from "./portalChecks";
import type { Status } from "./rules";
import { triage, type PreviousRow, type Triage } from "./triage";

/**
 * THE MORNING DOSSIER: what the last stored Data health run needs looked at,
 * with the evidence beside each item — the half of an investigation that needs
 * no judgement. Reads the database only, and only what the nightly stored
 * (`data_health_checks`, `portal_runs`): seconds and kilobytes, where
 * `npm run health` downloads the whole feed. Writes nothing.
 *
 *   npm run health:brief                    the last stored run against the one before
 *   npm run health:brief -- --as-of=<ISO>   the last run stored by that moment
 *
 * Read first by the daily review on the user's computer (a scheduled task of the
 * Claude app, layer 2 of the triage): when it says nothing new needs a look, the
 * review stops there. The split it prints is triage.ts, the same as the nightly
 * summary's `triage:` line.
 */

const CLIENT = "med-estates";
/** Nights of history beside each item, and of collection runs at the end. */
const NIGHTS = 14;
const RUN_DAYS = 8;

const CheckRow = z.object({
  ran_at: z.coerce.date(),
  check_key: z.string(),
  source: z.string(),
  vault_status: z.string().nullable(),
  our_status: z.string().nullable(),
  value: z.coerce.number().nullable(),
  expected: z.string(),
  message: z.string(),
  note: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});
type CheckRow = z.infer<typeof CheckRow>;

const RunRow = z.object({
  source_key: z.string(),
  started_at: z.coerce.date(),
  completed_at: z.coerce.date().nullable(),
  mode: z.string(),
  status: z.string(),
  seen_count: z.number(),
  new_count: z.number(),
  gone_count: z.number(),
  fetched_count: z.number(),
  failed_count: z.number(),
  aborted_reason: z.string().nullable(),
  error: z.string().nullable(),
});
type RunRow = z.infer<typeof RunRow>;

export type BriefInput = { asOf: Date; runs: Date[]; checks: CheckRow[]; collection: RunRow[] };

const STATUSES = new Set(["green", "amber", "red", "unknown"]);
const status = (s: string | null): Status | null => (s && STATUSES.has(s) ? (s as Status) : null);
const label = (key: string) => LABELS[key] ?? key;
const stamp = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
const flag = (s: string | null) => (s === "red" || s === "amber" ? s.toUpperCase() : (s ?? "—"));
const num = (v: number | null) => (v === null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(3));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const id = (key: string, source: string) => `${key}\u0000${source}`;

function asResult(r: CheckRow): CheckResult {
  return {
    key: r.check_key,
    label: label(r.check_key),
    source: r.source,
    vault: status(r.vault_status),
    ours: status(r.our_status),
    value: r.value,
    expected: r.expected,
    message: r.message,
    note: r.note,
    detail: r.detail ?? {},
  };
}

/** The triage of the newest stored run against the one before it. Pure. */
export function briefTriage(input: BriefInput): Triage | null {
  const [current, before] = input.runs;
  if (!current) return null;
  const at = (d: Date | undefined) => input.checks.filter((c) => d && c.ran_at.getTime() === d.getTime());
  const previous: PreviousRow[] = at(before).map((c) => ({ checkKey: c.check_key, source: c.source, vaultStatus: c.vault_status, ourStatus: c.our_status }));
  return triage(at(current).map(asResult), previous);
}

/** The dossier, as Markdown. Pure: the loader below feeds it. */
export function renderBrief(input: BriefInput): string {
  const t = briefTriage(input);
  const out: string[] = [];
  if (!t) return `# Data health dossier\n\nNo stored run by ${stamp(input.asOf)} UTC: the nightly has not stored one yet.\n`;

  const [current, before] = input.runs;
  const fresh = t.needsLook.filter((i) => i.isNew);
  out.push(`# Data health dossier — run of ${stamp(current)} UTC`);
  out.push("");
  out.push(before ? `Compared with the run of ${stamp(before)} UTC.` : "No run before it: nothing can be called new.");
  out.push(
    `Needs a look: ${t.needsLook.length} (${fresh.length} new). Explained by a known cause: ${t.explained.length}. Cleared since the run before: ${t.cleared.length}.`,
  );
  out.push("");
  out.push(
    fresh.length
      ? "VERDICT: something new needs a look — investigate the NEW items below."
      : t.needsLook.length
        ? "VERDICT: nothing new. What needs a look was already flagged the run before; see its history for a change."
        : "VERDICT: nothing needs a look.",
  );

  // Each item with its last nights, newest first: when it turned, and what moved.
  const history = (key: string, source: string) =>
    input.checks
      .filter((c) => c.check_key === key && c.source === source)
      .sort((a, b) => b.ran_at.getTime() - a.ran_at.getTime())
      .map((c) => `  - ${stamp(c.ran_at)}  ours ${flag(c.our_status)}, client ${flag(c.vault_status)}, value ${num(c.value)} — ${cut(c.message, 160)}`);
  const currentRow = new Map(input.checks.filter((c) => c.ran_at.getTime() === current.getTime()).map((c) => [id(c.check_key, c.source), c]));

  if (t.needsLook.length) {
    out.push("", "## Needs a look (our reading flags it)");
    for (const i of t.needsLook) {
      const row = currentRow.get(id(i.key, i.source));
      out.push("", `### ${i.isNew ? "NEW " : ""}${i.status.toUpperCase()} ${i.label}${i.source ? ` [${i.source}]` : ""} (\`${i.key}\`)`);
      out.push(`${i.message}`);
      if (row) out.push(`Expected: ${row.expected}`);
      if (row?.note) out.push(`Note: ${row.note}`);
      if (row?.detail && Object.keys(row.detail).length) out.push(`Detail: \`${cut(JSON.stringify(row.detail), 600)}\``);
      out.push("History:", ...history(i.key, i.source));
    }
  }

  if (t.explained.length) {
    out.push("", "## Explained (only the client's rule flags it; the note says why)");
    for (const i of t.explained) out.push(`- ${i.status.toUpperCase()} ${i.label}${i.source ? ` [${i.source}]` : ""}: ${cut(i.message, 140)}${i.note ? ` — ${cut(i.note, 160)}` : ""}`);
  }

  if (t.cleared.length) {
    out.push("", "## Cleared since the run before");
    out.push(t.cleared.map((i) => `${i.label}${i.source ? ` [${i.source}]` : ""}`).join("; "));
  }

  out.push("", `## Collection runs, last ${RUN_DAYS} days (portal_runs, newest first)`);
  const bySource = new Map<string, RunRow[]>();
  for (const r of input.collection) bySource.set(r.source_key, [...(bySource.get(r.source_key) ?? []), r]);
  for (const [source, rows] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
    out.push("", `${source}:`);
    for (const r of rows.sort((a, b) => b.started_at.getTime() - a.started_at.getTime())) {
      const why = r.aborted_reason ?? r.error;
      out.push(
        `  - ${stamp(r.started_at)} ${r.mode} ${r.status}: seen ${r.seen_count}, new ${r.new_count}, gone ${r.gone_count}, fetched ${r.fetched_count}, failed ${r.failed_count}${why ? ` — ${cut(why, 200)}` : ""}`,
      );
    }
  }
  return `${out.join("\n")}\n`;
}

export async function loadBrief(asOf: Date): Promise<BriefInput> {
  const scope = await scopeFor(CLIENT);
  const runsRes = await db.execute(sql`
    select distinct ran_at from data_health_checks
    where client_id = ${scope.clientId} and ran_at <= ${asOf.toISOString()}::timestamptz
    order by ran_at desc limit ${NIGHTS}`);
  const runs = z.array(z.object({ ran_at: z.coerce.date() })).parse(runsRes.rows).map((r) => r.ran_at);
  if (!runs.length) return { asOf, runs, checks: [], collection: [] };

  const checksRes = await db.execute(sql`
    select ran_at, check_key, source, vault_status, our_status, value, expected, message, note,
      case when ran_at = ${runs[0].toISOString()}::timestamptz then detail end as detail
    from data_health_checks
    where client_id = ${scope.clientId} and ran_at >= ${runs[runs.length - 1].toISOString()}::timestamptz
      and ran_at <= ${runs[0].toISOString()}::timestamptz`);
  const collectionRes = await db.execute(sql`
    select s.key as source_key, r.started_at, r.completed_at, r.mode, r.status, r.seen_count, r.new_count,
      r.gone_count, r.fetched_count, r.failed_count, r.aborted_reason, r.error
    from portal_runs r join portal_sources s on s.id = r.source_id
    where r.started_at > ${asOf.toISOString()}::timestamptz - make_interval(days => ${RUN_DAYS})
      and r.started_at <= ${asOf.toISOString()}::timestamptz
    order by s.key, r.started_at desc`);
  return {
    asOf,
    runs,
    checks: z.array(CheckRow).parse(checksRes.rows),
    collection: z.array(RunRow).parse(collectionRes.rows),
  };
}

async function main(): Promise<void> {
  const asOfArg = process.argv.find((a) => a.startsWith("--as-of="))?.slice("--as-of=".length);
  const asOf = asOfArg ? new Date(asOfArg) : new Date();
  if (Number.isNaN(asOf.getTime())) throw new Error(`--as-of=${asOfArg} is not a date`);
  process.stdout.write(renderBrief(await loadBrief(asOf)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
