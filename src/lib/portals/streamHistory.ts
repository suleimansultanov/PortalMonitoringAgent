import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { COLLECTION_INSEE, GULF_OF_SAINT_TROPEZ } from "./communes";
import {
  BillingFault,
  BudgetError,
  createV1Client,
  V1_DEFAULT_RESERVE,
  V1_PAGE,
  V1_PLAN_ITEMS,
  withDiskCache,
  type V1Client,
} from "./streamV1";
import { dbLedgerStore } from "./streamV1Db";

/**
 * Stream.Estate V1: the gulf's history, pulled once, on a meter.
 *
 *   npm run stream:history                       — THE PLAN. Counts only; spends nothing.
 *   npm run stream:history -- --ledger           — what has been spent this period, from the database.
 *   npm run stream:history -- --pull=price-changes            — says what it would do; spends nothing.
 *   npm run stream:history -- --pull=price-changes --yes      — does it, up to the cap.
 *   npm run stream:history -- --pull=… --yes --communes=83079 --max-pages=1   — one page of 30, to reconcile
 *                                                                               our ledger with their dashboard.
 *   npm run stream:history -- --analyse          — reads what is on disk; spends nothing.
 *
 * THE SAME LEDGER AS THE NIGHTLY PASS. The `stream-estate-v1` source reads
 * changes from this API every night on the same plan, so what this tool
 * spends and what the runner spends are one count, in the `api_usage` table.
 * The responses this tool pays for are also kept on disk, so a re-run or an
 * analysis sends nothing.
 *
 * WHAT V1 HAS THAT V2 DOES NOT (Thomas, in writing, 2026-10-09): on our
 * communes, properties continuously since 2022 and price changes since July
 * 2021. Its dates are those of THEIR first detection, not the portal's
 * publication date. V2 starts on 24 June 2026.
 *
 * WHAT IT COSTS. One item per property returned, 30 a page, 15 000 a month on
 * the client's Starter plan, EUR 0.003 each beyond that on his card. Three
 * families, each a different question:
 *
 *   price-changes  properties with a price change since 2021-07-01 — the
 *                  history a market report is made of.
 *   expired        properties no longer on any portal — what left the market.
 *   all            every sale property they hold.
 *
 * THE FAMILIES OVERLAP, and a property returned twice is billed twice. One
 * family per billing period unless `--allow-overlap` says the overlap is
 * understood. Within a family the windows are disjoint by construction —
 * commune × creation-date range — so nothing is asked for twice.
 *
 * Every request goes through `streamV1.ts`: ledger, cap, cache, no retries.
 * Read its header before changing anything here.
 */

const SOURCE_KEY = "stream-estate-v1";
const DIR = path.join(process.cwd(), ".pages", "stream-estate-v1");
const HISTORY_FROM = "2021-07-01";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const flag = (n: string) => process.argv.includes(`--${n}`);

const FAMILIES: Record<string, { params: Record<string, string>; what: string }> = {
  "price-changes": {
    params: { eventPriceVariationFromCreatedAt: HISTORY_FROM },
    what: `properties with a price change since ${HISTORY_FROM}`,
  },
  expired: { params: { expired: "true" }, what: "properties no longer on any portal" },
  all: { params: {}, what: "every sale property they hold" },
};

function apiKey(): string {
  try {
    (createRequire(import.meta.url)("@next/env") as { loadEnvConfig: (d: string) => void }).loadEnvConfig(process.cwd());
  } catch {
    // not installed: the error below says what is missing
  }
  const k = process.env.STREAM_ESTATE_API_KEY?.trim();
  if (!k) throw new Error("STREAM_ESTATE_API_KEY is not set — add the client's V1 key to .env.local.");
  return k;
}

const name = (insee: string) =>
  GULF_OF_SAINT_TROPEZ.find((c) => c.insee === insee && !c.localityOf)?.label ?? GULF_OF_SAINT_TROPEZ.find((c) => c.insee === insee)?.label ?? insee;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where a commune is asked for by something narrower than its INSEE code.
 *
 * 83107 is all of Roquebrune-sur-Argens; the client's place is Les Issambres,
 * which has a postcode of its own. Counted for nothing on 2026-10-13, price
 * changes since July 2021: 2 814 by INSEE, 1 752 by postcode 83380 — 1 062
 * items of an inland village not paid for. The postcode REPLACES the INSEE
 * code: sent together they are a union (a bogus postcode beside 83107 still
 * answered 2 814), which would narrow nothing.
 */
const LOCATION: Record<string, [string, string]> = { "83107": ["includedZipcodes[]", "83380"] };

function base(insee: string, family: string): URLSearchParams {
  const q = new URLSearchParams();
  const [param, value] = LOCATION[insee] ?? ["includedInseeCodes[]", insee];
  q.append(param, value);
  q.set("transactionType", "0"); // sale
  for (const [k, v] of Object.entries(FAMILIES[family].params)) q.set(k, v);
  return q;
}

async function count(client: V1Client, q: URLSearchParams): Promise<number> {
  const c = new URLSearchParams(q);
  c.set("itemsPerPage", "0");
  const { total } = await client.call(c);
  await sleep(250);
  return total;
}

/** Their ceiling on one query: totals at or above it are truncated, and so would the walk be. */
const QUERY_CEILING = 10_000;

type Window = { insee: string; from?: string; to?: string; total: number };

/**
 * Disjoint windows that each fit under the ceiling: the whole commune if it
 * fits, else by year of creation, else by month. Counts only.
 */
async function windowsFor(client: V1Client, insee: string, family: string): Promise<{ windows: Window[]; truncated: string[] }> {
  const whole = await count(client, base(insee, family));
  if (whole < QUERY_CEILING) return { windows: whole > 0 ? [{ insee, total: whole }] : [], truncated: [] };

  const windows: Window[] = [];
  const truncated: string[] = [];
  const thisYear = new Date().getUTCFullYear();
  // Before 2015 in one window: their data starts later, and a year that is empty costs one free count.
  const ranges: [string, string][] = [["2000-01-01", "2014-12-31"]];
  for (let y = 2015; y <= thisYear; y++) ranges.push([`${y}-01-01`, `${y}-12-31`]);

  for (const [from, to] of ranges) {
    const q = base(insee, family);
    q.set("fromDate", from);
    q.set("toDate", `${to} 23:59:59`);
    const n = await count(client, q);
    if (n === 0) continue;
    if (n < QUERY_CEILING) {
      windows.push({ insee, from, to, total: n });
      continue;
    }
    if (from.slice(0, 4) !== to.slice(0, 4)) {
      // The catch-all range before 2015 is not split further: it should be empty, and if it is not, say so.
      truncated.push(`${name(insee)} ${from}…${to}: ${n}+ — only the first ${QUERY_CEILING} are reachable`);
      windows.push({ insee, from, to, total: QUERY_CEILING });
      continue;
    }
    const year = Number(from.slice(0, 4));
    for (let m = 1; m <= 12; m++) {
      const mf = `${year}-${String(m).padStart(2, "0")}-01`;
      const mt = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
      const mq = base(insee, family);
      mq.set("fromDate", mf);
      mq.set("toDate", `${mt} 23:59:59`);
      const mn = await count(client, mq);
      if (mn === 0) continue;
      if (mn >= QUERY_CEILING) truncated.push(`${name(insee)} ${mf.slice(0, 7)}: ${mn}+ in one month — only the first ${QUERY_CEILING} are reachable`);
      windows.push({ insee, from: mf, to: mt, total: Math.min(mn, QUERY_CEILING) });
    }
  }
  return { windows, truncated };
}

async function showLedger(client: V1Client): Promise<void> {
  const t = await client.totals();
  console.log(`\n── ledger (table api_usage, source ${SOURCE_KEY}) — the nightly pass and this tool share it`);
  console.log(`   period from      ${client.periodStart.toISOString().slice(0, 10)}`);
  console.log(`   items counted    ${t.items}   of the plan's ${V1_PLAN_ITEMS}; cap ${client.cap}, ${await client.remaining()} left`);
  console.log(`   of them unsure   ${t.uncertain}   (paid requests that failed in transit, counted at the worst case)`);
  console.log(`   requests         ${t.paidRequests} paid, ${t.freeRequests} free`);
  console.log(`   Their dashboard is the bill. If the two disagree, theirs is right and this table is the thing to fix.`);
}

const statePath = path.join(DIR, "state.json");
const readState = (): { families: string[]; period?: string } => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as { families: string[]; period?: string };
  } catch {
    return { families: [] };
  }
};

async function plan(client: V1Client): Promise<void> {
  console.log(`\nStream.Estate V1 — the plan. Counts only (itemsPerPage=0): nothing here is billed.\n`);
  console.log(`   commune                  price-changes   expired       all`);
  const sums: Record<string, number> = { "price-changes": 0, expired: 0, all: 0 };
  const capped: string[] = [];
  for (const insee of COLLECTION_INSEE) {
    const row: string[] = [];
    for (const family of Object.keys(FAMILIES)) {
      const n = await count(client, base(insee, family));
      sums[family] += n;
      if (n >= QUERY_CEILING) capped.push(`${name(insee)} / ${family}`);
      row.push(`${n >= QUERY_CEILING ? `${n}+` : n}`.padStart(13));
    }
    console.log(`   ${name(insee).padEnd(22)} ${row.join(" ")}`);
  }
  console.log(`   ${"TOTAL".padEnd(22)} ${Object.keys(FAMILIES).map((f) => `${sums[f]}${capped.some((c) => c.endsWith(f)) ? "+" : ""}`.padStart(13)).join(" ")}`);
  if (capped.length > 0) {
    console.log(`\n   "+" = at their ${QUERY_CEILING}-per-query ceiling: the real figure is higher. A pull splits those by year, then month.`);
  }
  const left = await client.remaining();
  console.log(`\n   Budget: ${(await client.totals()).items} counted so far, cap ${client.cap}, ${left} left this period.`);
  console.log(`   The nightly changes-only pass of the same source spends from the same count: ~200 a day.`);
  for (const [family, f] of Object.entries(FAMILIES)) {
    const n = sums[family];
    const over = Math.max(0, n - V1_PLAN_ITEMS);
    console.log(
      `   ${family.padEnd(14)} ${String(n).padStart(7)}${capped.some((c) => c.endsWith(family)) ? "+" : " "} items — ${f.what}. ` +
        (n <= left ? `FITS in what is left.` : `Does NOT fit: ${n - left} over the cap` + (over > 0 ? `; beyond the plan ≈ EUR ${(over * 0.003).toFixed(0)} at 0.003.` : `.`)),
    );
  }
}

async function pull(client: V1Client, family: string): Promise<void> {
  if (!FAMILIES[family]) throw new Error(`unknown family "${family}" — one of: ${Object.keys(FAMILIES).join(", ")}`);
  const period = client.periodStart.toISOString().slice(0, 10);
  const state = readState();
  const pulledThisPeriod = state.period === period ? state.families : [];
  const others = pulledThisPeriod.filter((f) => f !== family);
  if (others.length > 0 && !flag("allow-overlap")) {
    throw new BudgetError(
      `"${others.join(", ")}" was already pulled this period, and families overlap: a property in both is billed twice. ` +
        `Pass --allow-overlap if that is understood.`,
    );
  }
  const communes = (arg("communes")?.split(",").map((s) => s.trim()).filter(Boolean) ?? COLLECTION_INSEE).filter((c) =>
    COLLECTION_INSEE.includes(c),
  );
  const maxPages = arg("max-pages") ? Number(arg("max-pages")) : Infinity;

  console.log(`\nStream.Estate V1 — pull "${family}": ${FAMILIES[family].what}`);
  console.log(`   communes: ${communes.map(name).join(", ")}`);

  // The windows first, by counts: free, and it is what tells us the size before a cent is spent.
  const all: Window[] = [];
  const truncated: string[] = [];
  for (const insee of communes) {
    const w = await windowsFor(client, insee, family);
    all.push(...w.windows);
    truncated.push(...w.truncated);
  }
  const need = all.reduce((a, w) => a + w.total, 0);
  const pages = all.reduce((a, w) => a + Math.ceil(w.total / V1_PAGE), 0);
  const left = await client.remaining();
  console.log(`   ${all.length} windows, ${need} items, ${pages} pages of ${V1_PAGE}`);
  for (const t of truncated) console.warn(`   ⚠ ${t}`);
  console.log(`   budget: ${(await client.totals()).items} counted so far, cap ${client.cap}, ${left} left`);
  if (need > left) {
    console.log(`   → does not fit: the pull will stop at the cap with ${need - left} items not taken. Pages already on disk are not asked for again.`);
  }
  if (!flag("yes")) {
    console.log(`\n   Nothing was requested. Add --yes to pull.`);
    return;
  }

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ period, families: [...new Set([...pulledThisPeriod, family])] }));

  let got = 0;
  let fromCache = 0;
  let asked = 0;
  try {
    for (const w of all) {
      const windowPages = Math.ceil(w.total / V1_PAGE);
      for (let page = 1; page <= windowPages; page++) {
        if (asked >= maxPages) throw new BudgetError(`stopped at --max-pages=${maxPages}`);
        const q = base(w.insee, family);
        if (w.from) q.set("fromDate", w.from);
        if (w.to) q.set("toDate", `${w.to} 23:59:59`);
        // Oldest first: a property created while we walk lands on the last page, not in the middle of the ones already read.
        q.set("order[createdAt]", "asc");
        q.set("itemsPerPage", String(V1_PAGE));
        q.set("page", String(page));
        const r = await client.call(q);
        if (r.fromCache) fromCache += r.items.length;
        else {
          asked += 1;
          got += r.spent;
          await sleep(400);
        }
        if (r.items.length === 0) break;
      }
      console.log(`   ${name(w.insee).padEnd(22)} ${w.from ? `${w.from}…${w.to}` : "all dates".padEnd(21)}  ${String(w.total).padStart(6)} stated — counted ${(await client.totals()).items}`);
    }
  } catch (err) {
    if (err instanceof BudgetError) console.log(`\n   Stopped: ${err.message}`);
    else throw err;
  }
  console.log(`\n   This run: ${got} items paid for in ${asked} requests, ${fromCache} read from disk for nothing.`);
  await showLedger(client);
}

function analyse(): void {
  const dir = path.join(DIR, "responses");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  const props = new Map<string, Record<string, unknown>>();
  let returned = 0;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
      for (const p of (j["hydra:member"] as Record<string, unknown>[] | undefined) ?? []) {
        returned += 1;
        props.set(String(p.uuid), p);
      }
    } catch {
      // not a response we can read; the ledger has already counted it
    }
  }
  const adverts = [...props.values()].flatMap((p) => (p.adverts as Record<string, unknown>[] | undefined) ?? []);
  const priceEvents = adverts.flatMap((a) => ((a.events as Record<string, unknown>[] | undefined) ?? []).filter((e) => e.fieldName === "price"));
  const dates = priceEvents.map((e) => String(e.createdAt ?? "").slice(0, 10)).filter(Boolean).sort();
  const created = [...props.values()].map((p) => String(p.createdAt ?? "").slice(0, 4)).filter(Boolean);
  const byYear = new Map<string, number>();
  for (const y of created) byYear.set(y, (byYear.get(y) ?? 0) + 1);
  console.log(`\n── on disk (${path.relative(process.cwd(), dir)}) — reading it costs nothing`);
  console.log(`   ${files.length} responses, ${returned} items returned, ${props.size} distinct properties${returned > props.size ? ` (${returned - props.size} returned more than once — paid for twice)` : ""}`);
  console.log(`   expired: ${[...props.values()].filter((p) => p.expired === true).length}, still listed: ${[...props.values()].filter((p) => p.expired === false).length}`);
  console.log(`   adverts: ${adverts.length}; price changes: ${priceEvents.length}${dates.length ? `, from ${dates[0]} to ${dates[dates.length - 1]}` : ""}`);
  console.log(`   created, by year: ${[...byYear.entries()].sort().map(([y, n]) => `${y}: ${n}`).join(", ") || "—"}`);
}

async function main(): Promise<void> {
  if (flag("analyse")) return analyse();

  const capArg = arg("cap");
  const client = createV1Client({
    store: withDiskCache(dbLedgerStore(SOURCE_KEY), DIR),
    apiKey,
    cap: capArg ? Number(capArg) : V1_PLAN_ITEMS - V1_DEFAULT_RESERVE,
    allowOverage: flag("allow-overage"),
  });
  if (flag("ledger")) return showLedger(client);
  apiKey(); // fail on a missing key before anything else is said

  const family = arg("pull");
  if (family) return pull(client, family);
  return plan(client);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const kind = err instanceof BillingFault ? "BILLING FAULT" : err instanceof BudgetError ? "refused" : "failed";
    console.error(`\n[stream:history] ${kind}: ${(err as Error).message}`);
    process.exit(1);
  });
