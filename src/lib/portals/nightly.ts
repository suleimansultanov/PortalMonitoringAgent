import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalSources } from "@/lib/db/schema";
import { collectionCommunes, communesForSource } from "./runner/run";
import { resolveCommuneIdentities } from "./matching/resolve";
import { deletePage, getPage, putPage, storageDescription } from "@/lib/s3/pages";
import { SUMMARY_MARKER, type Grade, type SourceOutcome } from "./nightlyOne";

/**
 * THE NIGHTLY RUN. One command, safe to point a scheduler at.
 *
 *   npm run nightly                     every enabled source
 *   npm run nightly -- --sources=figaro,smc
 *   npm run nightly -- --parallel=2
 *   npm run nightly -- --force          rehearse before switching sources on
 *
 * It is deliberately host-agnostic: cron on a server, launchd on a laptop and a
 * CI job all invoke the same thing and all read the same artefacts. Choosing
 * where it runs is then a scheduling decision rather than a rewrite.
 *
 * WHAT IT LEAVES BEHIND, AND WHY IN THREE PLACES
 *
 *   logs/<date>/summary.txt     twelve lines. Did the night work?
 *   logs/<date>/summary.json    the same, for an alert or a graph
 *   logs/<date>/<source>.log    every line that source printed. What happened?
 *   logs/<date>/nightly.log     this orchestrator's own narration
 *   logs/latest -> <date>
 *
 * Those are three different questions asked at three different magnitudes, and
 * one file cannot answer all three. A pass over Superimmo prints thousands of
 * lines; a summary that lives inside them is a summary nobody reads by the
 * second week, and then "the night was quiet" goes back to being the only
 * signal we have — which is exactly the failure this is built to prevent,
 * because a blocked crawl and a healthy one are both quiet.
 *
 * Every source also gets a `run_id` printed next to it. That is the join back
 * into `portal_runs`, which is where the questions that span more than one
 * night get answered — how often this portal has cut us off this month is not a
 * question a directory of log files can answer, and it is the question that
 * decides whether we write to the portal.
 *
 * EXIT CODE
 *
 * 0 when every source finished its pass, 1 when any did not. That is the only
 * thing a scheduler can act on, so it is kept narrow: individual listings
 * failing to fetch is ordinary and does not fail the night — it is reported as
 * a warning with its ratio, and judged by a person.
 */

const LOGS_ROOT = path.resolve(process.cwd(), "logs");
/** Nights kept on disk. Text, so this costs almost nothing; the ceiling is for tidiness. */
const KEEP_NIGHTS = 30;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

function human(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Local date, not UTC: a night is named for the evening the operator started it. */
function nightStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Send everything this process prints to a file as well as to the terminal.
 *
 * Wrapping console rather than asking the caller to redirect, because a nightly
 * whose logs exist only when someone remembered `>> file` in the crontab is a
 * nightly whose logs do not exist.
 */
function tee(file: string): () => Promise<void> {
  const stream = fs.createWriteStream(file, { flags: "a" });
  const original = { log: console.log, warn: console.warn, error: console.error };
  const wrap =
    (fn: (...a: unknown[]) => void) =>
    (...a: unknown[]) => {
      fn(...a);
      stream.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
    };
  console.log = wrap(original.log);
  console.warn = wrap(original.warn);
  console.error = wrap(original.error);
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    /**
     * Awaited, not fired and forgotten. `process.exit` does not flush a write
     * stream, and the lines most likely to be lost are the last ones — which on
     * a bad night are the only ones worth having.
     */
    return new Promise<void>((done) => stream.end(() => done()));
  };
}

/**
 * Run one source in its own process, streaming everything it says into its own
 * log file and picking the summary line back out.
 *
 * The child is never allowed to fail the orchestrator. A source that dies
 * badly — killed, out of memory, a throw before it could emit — still has to
 * produce a row in the table, or the night reports six sources and quietly
 * forgets the seventh.
 */
function runChild(
  sourceKey: string,
  logFile: string,
  force: boolean,
  timeoutMs: number,
  communes?: string,
  fullSweep?: boolean,
): Promise<SourceOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const out = fs.createWriteStream(logFile, { flags: "a" });
    const script = path.resolve(process.cwd(), "src/lib/portals/nightlyOne.ts");
    const args = ["--import", "tsx", script, `--source=${sourceKey}`];
    if (force) args.push("--force");
    if (communes) args.push(`--communes=${communes}`);
    if (fullSweep) args.push("--full");

    const child = spawn(process.execPath, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    /**
     * A CEILING ON ONE SOURCE, so it cannot eat the whole night.
     *
     * Everything inside a pass has its own bound — page ceilings, the refusal
     * streak, the refresh budget — but a wedged Chromium has none of them. It
     * is not looping, not erroring and not finishing, and without this the
     * night would be spent waiting on it and the six healthy portals behind it
     * would never be collected at all.
     *
     * SIGTERM first so the child's `finally` closes the browser, then SIGKILL
     * for the case where the browser is exactly what is stuck. The kill is
     * written into the log file too — a source that simply stops mid-sentence
     * is the least explicable thing a log can contain.
     */
    /**
     * A heartbeat for the gaps between progress markers.
     *
     * Superimmo waits ten seconds between requests, so fifteen minutes can pass
     * between two index pages with nothing printed. The markers alone are not
     * enough to tell a slow source from a stopped one.
     */
    const heartbeat = setInterval(
      () => console.log(`  [nightly] ${sourceKey}: still running, ${Math.round((Date.now() - started) / 60_000)}m`),
      5 * 60_000,
    );
    heartbeat.unref();

    let killedAt: string | null = null;
    const timer = setTimeout(() => {
      killedAt = `no result after ${Math.round(timeoutMs / 60_000)} minutes — killed`;
      out.write(`\n[nightly] ${killedAt}\n`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
    }, timeoutMs);
    timer.unref();

    let summary: SourceOutcome | null = null;
    let tail = "";

    /**
     * Lines worth echoing to the console as well as to the file.
     *
     * The per-source log exists so that seven sources running at once do not
     * interleave into an unreadable stream. On a hosted runner that produced a
     * step which prints two lines an hour apart, and a working pass became
     * indistinguishable from a wedged one — the exact confusion `run.ts`
     * already fixed once inside discovery, reappearing one level up.
     *
     * So the progress markers come back out, prefixed by source. They are
     * low-volume by design: one line per hundred discovered, one per chunk of
     * twenty-five fetched.
     */
    const PROGRESS = /^\[(?:run|nightly):/;

    const consume = (chunk: Buffer, isErr: boolean): void => {
      const text = chunk.toString();
      out.write(text);
      // The marker line is the child's structured answer. Everything else is
      // prose for the log file and is left exactly as the child wrote it.
      for (const line of text.split("\n")) {
        const at = line.indexOf(SUMMARY_MARKER);
        if (at !== -1) {
          try {
            summary = JSON.parse(line.slice(at + SUMMARY_MARKER.length)) as SourceOutcome;
          } catch {
            /* keep the raw line in the log; the fallback below covers us */
          }
        } else if (PROGRESS.test(line.trim())) {
          // Straight through, keeping the source's own prefix.
          console.log(`  ${line.trim()}`);
        } else if (isErr && line.trim()) {
          // Kept so a child that died without emitting still has something to
          // show in the table rather than only in a file nobody opened.
          tail = line.trim().slice(0, 300);
        }
      }
    };

    child.stdout.on("data", (c: Buffer) => consume(c, false));
    child.stderr.on("data", (c: Buffer) => consume(c, true));

    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      // Same reason as `tee` above: the child's dying words are the ones that
      // matter, and they are still in the stream's buffer at this point.
      out.end(() => {
      // A killed child may still have emitted a summary before it hung; the
      // kill is the more important fact, so it wins.
      if (summary && !killedAt) return resolve(summary);
      resolve({
        ...(summary ?? {}),
        sourceKey,
        grade: "fail",
        note:
          killedAt ??
          `the process exited with code ${code} without reporting` +
            (tail ? ` — last error line: ${tail}` : ""),
        communes: 0,
        startedAt,
        durationMs: Date.now() - started,
      });
      });
    });
  });
}

/** Fixed-width table. Read by a person at 8am, so it has to survive a mail client. */
function renderSummary(
  night: string,
  startedAt: Date,
  finishedAt: Date,
  outcomes: SourceOutcome[],
  resolveLine: string,
  logDir: string,
): string {
  const failed = outcomes.filter((o) => o.grade === "fail");
  const warned = outcomes.filter((o) => o.grade === "warn");
  const verdict =
    failed.length > 0
      ? `${failed.length} SOURCE${failed.length > 1 ? "S" : ""} DID NOT FINISH`
      : warned.length > 0
        ? `${warned.length} with warnings`
        : "all clear";

  const cols: [string, (o: SourceOutcome) => string][] = [
    ["source", (o) => o.sourceKey],
    ["status", (o) => (o.grade === "ok" ? "ok" : o.grade === "warn" ? "warn" : "FAILED")],
    ["found", (o) => String(o.discovered ?? "-")],
    ["new", (o) => String(o.added ?? "-")],
    ["refresh", (o) => String(o.refreshed ?? "-")],
    ["stored", (o) => String(o.ingested ?? "-")],
    ["fail", (o) => String(o.failed ?? "-")],
    ["gone", (o) => String(o.delisted ?? "-")],
    ["backlog", (o) => String(o.refreshBacklog ?? "-")],
    ["time", (o) => human(o.durationMs)],
  ];

  const widths = cols.map(([head, get]) =>
    Math.max(head.length, ...outcomes.map((o) => get(o).length)),
  );
  const row = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");

  const lines: string[] = [];
  lines.push(
    `Night ${night}  ${clock(startedAt)} -> ${clock(finishedAt)}  ` +
      `(${human(finishedAt.getTime() - startedAt.getTime())})     ${verdict}`,
  );
  lines.push("");
  lines.push(row(cols.map(([h]) => h)));
  for (const o of outcomes) {
    lines.push(row(cols.map(([, get]) => get(o))));
    if (o.note) lines.push(`${" ".repeat(widths[0])}  └ ${o.note}`);
  }

  const withSamples = outcomes.filter((o) => o.failureSamples?.length);
  if (withSamples.length > 0) {
    lines.push("");
    lines.push("why listings failed (a sample, the full set is in the per-source log):");
    for (const o of withSamples) {
      for (const f of o.failureSamples ?? []) {
        lines.push(`  ${o.sourceKey}  ${f.error}`);
        lines.push(`      ${f.url}`);
      }
    }
  }

  lines.push("");
  lines.push(resolveLine);
  lines.push("");
  lines.push(`logs:  ${logDir}`);
  for (const o of outcomes) {
    if (o.runId) {
      lines.push(
        `  ${o.sourceKey.padEnd(widths[0])}  ${o.sourceKey}.log   ` +
          `select * from portal_runs where id = '${o.runId}';`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

/** Keep the last KEEP_NIGHTS directories; drop the rest. */
async function rotate(): Promise<void> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(LOGS_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  for (const stale of entries.slice(0, Math.max(0, entries.length - KEEP_NIGHTS))) {
    await fsp.rm(path.join(LOGS_ROOT, stale), { recursive: true, force: true });
  }
}

/**
 * PREFLIGHT. Seconds, no portal touched.
 *
 *   npm run nightly -- --check
 *
 * Everything below is something that fails the same way whether it is wrong on
 * night one or night ninety, and every one of them would otherwise be found the
 * expensive way: an hour into a run, one source at a time, in a log read the
 * next morning. The Chromium check is the sharpest example — five of the seven
 * sources need a real browser, and without the binary each of them walks its
 * whole discovery phase before failing at the first listing.
 *
 * Run it after any change to the environment: a new DATABASE_URL, a machine
 * that has never collected before, a Node upgrade that emptied the browser
 * cache.
 */
async function preflight(): Promise<number> {
  const problems: string[] = [];
  const notes: string[] = [];

  // ── the database ────────────────────────────────────────────────────────
  //
  // The probe runs BEFORE the connection string is read, and the order is the
  // point: `db/client.ts` loads .env.local lazily, on first use. Reading
  // `process.env.DATABASE_URL` first therefore finds nothing and reports
  // "(DATABASE_URL is not set)" next to a connection that works — harmless
  // noise on a good day, and an actively wrong diagnosis on a bad one, naming
  // an unset variable instead of whatever really failed.
  //
  // The host also comes from the server rather than from the string we sent, so
  // what is printed is where we ARE, not where we asked to be.
  let where = "";
  try {
    const probe = await db.execute<{ db: string; host: string | null; port: number | null }>(sql`
      select current_database() as db,
             inet_server_addr()::text as host,
             inet_server_port() as port
    `);
    const dsn = process.env.DATABASE_URL ?? "";
    const named = dsn.replace(/:\/\/[^@]*@/, "://***@");
    const row = probe.rows[0];
    where = named || `${row?.db ?? "?"} at ${row?.host ?? "?"}:${row?.port ?? "?"}`;
    console.log(`  db          ok    ${where}`);
  } catch (err) {
    const dsn = process.env.DATABASE_URL ?? "";
    where = dsn.replace(/:\/\/[^@]*@/, "://***@") || "(no DATABASE_URL — check .env.local)";
    problems.push(`cannot reach the database at ${where}: ${(err as Error).message}`);
    console.error(`  db          FAIL  ${where}`);
    // Nothing below can be checked without it, and guessing would be worse
    // than saying so.
    console.error(`\n${problems.map((p) => `  ✗ ${p}`).join("\n")}\n`);
    return 1;
  }

  // ── the sources ─────────────────────────────────────────────────────────
  const rows = await db
    .select({
      key: portalSources.key,
      enabled: portalSources.enabled,
      crawlDelayMs: portalSources.crawlDelayMs,
      config: portalSources.config,
      id: portalSources.id,
    })
    .from(portalSources)
    .orderBy(portalSources.key);

  if (rows.length === 0) {
    problems.push("portal_sources is empty — run `npm run db:seed`");
  }

  let needsBrowser = false;
  console.log("");
  for (const r of rows) {
    const cfg = (r.config as Record<string, unknown> | null) ?? {};
    const mode = (cfg.fetchMode as string) ?? "http";
    if (mode.startsWith("browser")) needsBrowser = true;
    const communes = await communesForSource(r.id);
    const budget = Number(cfg.refreshBudgetMinutes) > 0 ? Number(cfg.refreshBudgetMinutes) : 45;
    const refreshPerNight = Math.floor((budget * 60_000) / r.crawlDelayMs);

    const state = r.enabled ? "on " : "OFF";
    console.log(
      `  ${r.key.padEnd(13)} ${state}  ${String(r.crawlDelayMs / 1000).padStart(2)}s  ` +
        `${mode.padEnd(17)} ${String(communes.length).padStart(2)} communes  ` +
        `refresh ≤${refreshPerNight}/night`,
    );

    if (r.enabled && communes.length === 0) {
      problems.push(`${r.key} is enabled but no client subscribes to it — it will collect nothing`);
    }
  }

  const enabled = rows.filter((r) => r.enabled);
  if (enabled.length === 0) {
    problems.push(
      "every source is disabled — the scheduler would collect nothing and say it went fine. " +
        "`update portal_sources set enabled = true where key in (...)`",
    );
  }

  // ── the browser ─────────────────────────────────────────────────────────
  console.log("");
  if (!needsBrowser) {
    notes.push("no source needs a browser, so Playwright is not required here");
  } else {
    try {
      const mod = (await import(/* webpackIgnore: true */ "playwright" as string)) as {
        chromium: { executablePath(): string };
      };
      const exe = mod.chromium.executablePath();
      if (exe && fs.existsSync(exe)) {
        console.log(`  chromium    ok    ${exe}`);
      } else {
        problems.push(
          `Playwright is installed but its Chromium is not at ${exe || "(no path)"} — ` +
            "run `npx playwright install chromium`. Five of the sources need it and " +
            "would each fail only after finishing discovery.",
        );
        console.error("  chromium    FAIL  binary missing");
      }
    } catch (err) {
      problems.push(
        `browser sources are configured but Playwright will not load: ${(err as Error).message} ` +
          "— run `npm i -D playwright && npx playwright install chromium`",
      );
      console.error("  chromium    FAIL  not loadable");
    }
  }

  // ── where the pages go ──────────────────────────────────────────────────
  //
  // Checked by actually writing and reading one, not by looking at whether the
  // variables are set. Every interesting way this fails — a wrong endpoint, a
  // token scoped to the wrong bucket, read permission without write — looks
  // exactly like a correct configuration from the outside, and shows up as a
  // failure on the first listing of a crawl that has already spent an hour in
  // discovery.
  console.log("");
  if (!process.env.S3_BUCKET || !process.env.S3_ENDPOINT) {
    /**
     * Local disk is right on a developer's machine and wrong on a runner, and
     * the difference is invisible until somebody needs `reparse` in November
     * for a page collected in September.
     */
    notes.push(
      `pages go to local disk (${storageDescription()}). Correct here, ruinous on ` +
        "a runner: the disk dies with the job and `npm run reparse` loses everything " +
        "the night fetched.",
    );
  } else {
    const probe = `pages/.preflight/${Date.now()}.html`;
    try {
      await putPage(probe, "<!-- preflight -->");
      const back = await getPage(probe);
      if (!back.includes("preflight")) {
        problems.push(`${storageDescription()} accepted a write but returned something else`);
      } else {
        console.log(`  storage    ok    ${storageDescription()}`);
      }
      await deletePage(probe).catch(() => {
        notes.push(
          "the probe object could not be deleted — the token can write but not delete. " +
            "Harmless for collection; it only means old pages cannot be cleaned up later.",
        );
      });
    } catch (err) {
      const message = (err as Error).message;
      problems.push(
        `cannot write to ${storageDescription()}: ${message}` +
          (/404|NoSuchBucket/i.test(message)
            ? " — check S3_ENDPOINT does NOT have the bucket name on the end; the client adds it."
            : /403|AccessDenied|SignatureDoesNotMatch/i.test(message)
              ? " — the token is wrong, or scoped to a different bucket."
              : ""),
      );
      console.error("  storage    FAIL");
    }
  }

  // ── somewhere to write ──────────────────────────────────────────────────
  try {
    await fsp.mkdir(LOGS_ROOT, { recursive: true });
    const probe = path.join(LOGS_ROOT, ".writable");
    await fsp.writeFile(probe, "", "utf8");
    await fsp.rm(probe, { force: true });
    console.log(`  logs        ok    ${LOGS_ROOT}`);
  } catch (err) {
    problems.push(`cannot write logs to ${LOGS_ROOT}: ${(err as Error).message}`);
  }

  // ── the honest identifier ───────────────────────────────────────────────
  const ua = process.env.COLLECTOR_USER_AGENT?.trim() || process.env.CRAWLER_USER_AGENT?.trim();
  if (!ua) {
    notes.push(
      "COLLECTOR_USER_AGENT is not set, so the built-in default will be sent. " +
        "Several portals granted access on the basis of knowing who we are — check it still names you.",
    );
  } else if (/mozilla|chrome|safari/i.test(ua)) {
    problems.push(
      "COLLECTOR_USER_AGENT looks like a browser string. That is not a name, it is the claim " +
        "that a person is reading the page, and it removes the only way a portal can recognise " +
        "and refuse us. Use a name and a contact.",
    );
  } else {
    console.log(`  user-agent  ok    ${ua.slice(0, 60)}`);
  }

  console.log("");
  for (const n of notes) console.log(`  · ${n}`);
  if (problems.length === 0) {
    console.log("\n  ready — `npm run nightly` would collect " + `${enabled.length} sources\n`);
    return 0;
  }
  console.error(`\n  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  return 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    console.log("\n[nightly] preflight — nothing is fetched\n");
    process.exit(await preflight());
  }

  const startedAt = new Date();
  const night = nightStamp(startedAt);
  const logDir = path.join(LOGS_ROOT, night);
  await fsp.mkdir(logDir, { recursive: true });
  const untee = tee(path.join(logDir, "nightly.log"));

  const force = process.argv.includes("--force");
  const parallel = Math.max(1, Number(arg("parallel") ?? 1) || 1);
  /**
   * Generous, because being killed halfway is worse than being slow: it leaves
   * a `running` row in portal_runs and a portal half-collected. Present only so
   * that a wedged process cannot hold the night open indefinitely.
   */
  const timeoutMs = Math.max(1, Number(arg("timeout") ?? 180) || 180) * 60_000;
  const only = arg("sources")?.split(",").map((s) => s.trim()).filter(Boolean);
  /**
   * Passed straight through to each child, unparsed.
   *
   * Not a normal night's flag. It is here so the same one-commune probe can be
   * run from a laptop, a hosted runner and a server, and the three numbers
   * compared — which is the only way to tell a portal refusing US from a portal
   * refusing an ADDRESS.
   */
  const communes = arg("communes");
  /**
   * The weekly whole-list pass. Delta sources stop early every other night and
   * therefore never delist; this is the night that does.
   */
  const fullSweep = process.argv.includes("--full");

  const all = await db
    .select({ key: portalSources.key, enabled: portalSources.enabled, config: portalSources.config })
    .from(portalSources)
    .where(only || force ? undefined : eq(portalSources.enabled, true));

  let sources = all.filter((s) => (only ? only.includes(s.key) : true));

  /**
   * Sources that asked for a window go first.
   *
   * LuxuryEstate asked to be collected between 01:00 and 05:00 CET. Ordering is
   * not enforcement — the window is a note, by the operator's decision, and
   * run.ts only warns — but putting the constrained sources at the front of a
   * night that starts at 03:00 costs nothing and is the difference between
   * honouring the request and honouring it when the queue happens to allow.
   */
  sources = [
    ...sources.filter((s) => (s.config as Record<string, unknown> | null)?.collectWindow),
    ...sources.filter((s) => !(s.config as Record<string, unknown> | null)?.collectWindow),
  ];

  if (sources.length === 0) {
    /**
     * LOUD, AND A FAILURE.
     *
     * `seed.ts` inserts every source with `enabled: false` and never turns it
     * back on, while `npm run collect` passes `force: true` — so a project can
     * collect happily by hand for weeks and still have nothing at all for a
     * scheduler to pick up. An empty night that exits 0 is indistinguishable
     * from a working one, and this is the likeliest way this whole thing
     * silently does nothing.
     */
    console.error(
      `[nightly] NO SOURCES TO COLLECT.\n` +
        (only
          ? `  --sources=${only.join(",")} matched nothing.\n` +
            `  Known keys: ${all.map((s) => s.key).join(", ") || "(none — run npm run db:seed)"}\n` +
            `  (Pass the key alone: --sources=smc, not --sources=sources=smc.)\n`
          : `  Every portal_sources row is disabled.\n`) +
        `  Switch the ones you want on:\n` +
        `    update portal_sources set enabled = true where key in ('green-acres', 'figaro');\n` +
        `  Or rehearse without enabling anything: npm run nightly -- --force`,
    );
    await untee();
    process.exit(1);
  }

  console.log(
    `[nightly] ${night} — ${sources.length} sources ` +
      `(${sources.map((s) => s.key).join(", ")}), ${parallel} at a time` +
      (force ? ", FORCED (ignoring the enabled flag)" : ""),
  );

  const outcomes: SourceOutcome[] = [];
  const queue = [...sources];
  const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      console.log(`[nightly] → ${next.key}`);
      const outcome = await runChild(
        next.key,
        path.join(logDir, `${next.key}.log`),
        force,
        timeoutMs,
        communes,
        fullSweep,
      );
      outcomes.push(outcome);
      console.log(
        `[nightly] ← ${next.key}: ${outcome.grade} in ${human(outcome.durationMs)}` +
          (outcome.note ? ` — ${outcome.note}` : ""),
      );
    }
  });
  await Promise.all(workers);

  // Keep the table in the order the sources were queued, not the order they
  // happened to finish, so two nights can be read side by side.
  outcomes.sort((a, b) => sources.findIndex((s) => s.key === a.sourceKey) - sources.findIndex((s) => s.key === b.sourceKey));

  /**
   * Clustering runs ONCE, after every source is in, rather than per source.
   *
   * This is the order the pipeline actually wants: a property is recognised
   * across portals, and the portal that arrives third is frequently the one
   * carrying the mandate reference that ties the first two together. Resolving
   * after each source would decide the same question up to seven times a night
   * and get it wrong on the early passes.
   */
  let merged = 0;
  let clusters = 0;
  let resolveError: string | null = null;

  /**
   * NOTHING STORED, NOTHING TO CLUSTER.
   *
   * Clustering is derived entirely from `portal_listings`, so with no listing
   * written this pass it recomputes the same answer it reached yesterday, at
   * the cost of reading every listing in every commune across the network.
   *
   * Measured on the first GitHub Actions run: SMC was refused after 29 seconds,
   * and the job then spent twelve more minutes re-deciding what it already knew
   * — on a night where the only useful information was that we had been
   * blocked. On a laptop against a local Postgres this was invisible; against a
   * database three countries away it is most of the run.
   */
  const stored = outcomes.reduce((n, o) => n + (o.ingested ?? 0), 0);
  if (stored === 0) {
    console.log(
      "[nightly] nothing was stored — skipping deduplication, which would " +
        "recompute yesterday's answer over the whole corpus.",
    );
  }

  /**
   * The communes this pass could have changed, not every commune we watch.
   *
   * Clustering is derived from `portal_listings`, so a commune nothing was
   * written to produces the same answer it produced yesterday — bought at the
   * price of reading all its listings across the network. The skip above
   * catches the case where NOTHING was stored; this catches the more common
   * one, where something was stored somewhere and we then re-clustered
   * everywhere.
   *
   * Visible on the one-commune probe of 2026-09-03: we collected 83119 and
   * the job went on to resolve 83036, 83042, 83048, 83063 and the rest. On a
   * full night that is not a rounding error — clustering took roughly 110 of
   * 188 minutes, against a database three countries away.
   *
   * `--communes` narrows it, because a pass told to look at one commune cannot
   * have changed another.
   */
  const scoped = communes?.split(",").map((c) => c.trim()).filter(Boolean);
  const watched = stored === 0 ? [] : await collectionCommunes();
  const toResolve = scoped?.length
    ? watched.filter((insee) => scoped.includes(insee))
    : watched;

  /**
   * Only when the list is empty for the reason this warning describes.
   *
   * It fired on the first successful GitHub Actions run and said something
   * false: every source had been refused, so `toResolve` was empty by the skip
   * above, and the log then announced a client-configuration problem that did
   * not exist. A warning that cries wolf on an ordinary bad night is worse than
   * no warning — the next person to see it, on the night it is true, will
   * already have learned to skip the line.
   */
  if (stored > 0 && toResolve.length === 0) {
    console.warn(
      "[nightly] no active client watches any commune — nothing to cluster. " +
        "Listings were collected and left unresolved.",
    );
  }
  for (const insee of toResolve) {
    try {
      const r = await resolveCommuneIdentities(insee);
      if (r.listings === 0) continue;
      clusters += r.properties;
      merged += r.merged;
      console.log(`[nightly] resolve ${insee}: ${r.listings} listings → ${r.properties} properties (${r.merged} merged)`);
    } catch (err) {
      /**
       * Per commune, and never fatal.
       *
       * Clustering runs after every page has been fetched and stored, so a
       * throw here would discard nothing that was collected — but until this
       * catch existed it discarded the *summary*, which is the only account of
       * a night's work anyone reads. Hours of correct collection reported as a
       * stack trace, because the arithmetic afterwards failed.
       */
      resolveError = `${insee}: ${(err as Error).message}`;
      console.error(`[nightly] resolve ${insee} failed: ${(err as Error).message}`);
    }
  }
  const resolveLine =
    stored === 0
      ? "deduplication: skipped — nothing was stored this pass"
      : `deduplication: ${clusters} properties across the gulf, ${merged} merged this pass` +
        (resolveError ? ` — WITH ERRORS, last: ${resolveError}` : "");

  const finishedAt = new Date();
  const summaryText = renderSummary(night, startedAt, finishedAt, outcomes, resolveLine, logDir);
  await fsp.writeFile(path.join(logDir, "summary.txt"), summaryText, "utf8");
  await fsp.writeFile(
    path.join(logDir, "summary.json"),
    JSON.stringify(
      {
        night,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        verdict: outcomes.some((o) => o.grade === "fail") ? "fail" : outcomes.some((o) => o.grade === "warn") ? "warn" : "ok",
        deduplication: { properties: clusters, merged },
        sources: outcomes,
      },
      null,
      2,
    ),
    "utf8",
  );

  // `latest` so a cron mail, a dashboard or a person always has one stable path
  // to look at without knowing today's date.
  const link = path.join(LOGS_ROOT, "latest");
  await fsp.rm(link, { force: true }).catch(() => {});
  await fsp.symlink(night, link, "dir").catch(() => {});

  await rotate();

  console.log("\n" + summaryText);
  await untee();

  const grades = new Set<Grade>(outcomes.map((o) => o.grade));
  process.exit(grades.has("fail") ? 1 : 0);
}

if (process.argv[1]?.endsWith("nightly.ts")) {
  /**
   * Node kills the process on an unhandled rejection, and the default report
   * goes to stderr — which, under launchd, is a file nobody is watching. Logged
   * where the night's own record is before letting it exit.
   */
  process.on("unhandledRejection", (reason) => {
    console.error("[nightly] unhandled rejection:", reason);
  });
  main().catch((err) => {
    console.error("[nightly] the orchestrator itself failed:", err);
    process.exit(1);
  });
}
