import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { COLLECTION_INSEE, GULF_OF_SAINT_TROPEZ } from "./communes";

/**
 * Stream.Estate pilot: what would their API give us for the gulf, and how
 * does it compare with what we collect ourselves? READ-ONLY on both sides.
 *
 *   npm run pilot:stream                       — counts per commune (spends ~nothing)
 *   npm run pilot:stream -- --sample=83079     — pull one commune (La Môle is small)
 *   npm run pilot:stream -- --sample=83119 --max=300
 *   npm run pilot:stream -- --full --yes       — every commune; spends items, see below
 *
 * Needs STREAM_ESTATE_API_KEY in .env.local (their key, from the account
 * settings at stream.estate). Written 2026-09-25 before we had a key, from
 * their public docs: base https://api.stream.estate, header X-API-KEY, Hydra
 * responses (`hydra:member`, `hydra:totalItems`), max 30 per page, a 10 000
 * cap on /documents/properties, budgets in euros.
 *
 * WHAT IT COSTS. Their pricing bills per "item" and does not say what an item
 * is. The default mode asks only for counts (`itemsPerPage=0`), which should
 * return no items. A sample pulls at most --max properties (default 200). A
 * full pull is ~15–20k properties, i.e. roughly EUR 150–200 on pay-as-you-go,
 * and refuses to run without --yes. Check the credit balance in their
 * dashboard after the counts run: that measures what one call costs.
 *
 * Every response is saved under `.pages/stream-estate/<date>/`, so any
 * analysis can be re-run later without spending again.
 */

const BASE = "https://api.stream.estate";
const PAGE = 30;

type Advert = {
  url?: string;
  price?: number | null;
  createdAt?: string;
  updatedAt?: string;
  pictures?: string[];
  picturesRemote?: string[];
  publisher?: { name?: string; type?: string | number } | null;
  contact?: { agency?: string; reference?: string } | null;
  events?: { fieldName?: string }[];
};
type Property = {
  uuid: string;
  price?: number | null;
  propertyType?: number;
  createdAt?: string;
  expired?: boolean;
  pictures?: string[];
  city?: { insee?: string; name?: string };
  adverts?: Advert[];
};

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const flag = (n: string) => process.argv.includes(`--${n}`);

let envLoaded = false;
function apiKey(): string {
  /**
   * `.env.local` is loaded by db/client.ts, but lazily, on the first query —
   * and this runs before any query. So load it here too; `@next/env` is a
   * no-op for variables already set.
   */
  if (!envLoaded) {
    envLoaded = true;
    try {
      const require_ = createRequire(import.meta.url);
      (require_("@next/env") as { loadEnvConfig: (dir: string) => void }).loadEnvConfig(process.cwd());
    } catch {
      // not installed: fall through to the clear error below
    }
  }
  const k = process.env.STREAM_ESTATE_API_KEY?.trim();
  if (!k) {
    throw new Error("STREAM_ESTATE_API_KEY is not set. Add it to .env.local (stream.estate → settings → API keys).");
  }
  return k;
}

const outDir = path.join(process.cwd(), ".pages", "stream-estate", new Date().toISOString().slice(0, 10));

async function call(query: URLSearchParams, label: string): Promise<{ total: number; items: Property[] }> {
  const url = `${BASE}/documents/properties?${query.toString()}`;
  const res = await fetch(url, { headers: { "X-API-KEY": apiKey(), Accept: "application/ld+json" } });
  const text = await res.text();
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${label}.json`), text);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${label}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as Record<string, unknown>;
  return {
    total: Number(j["hydra:totalItems"] ?? 0),
    items: (j["hydra:member"] as Property[] | undefined) ?? [],
  };
}

/**
 * Their `expired=false` is not "on the market". Measured 2026-09-25 on La
 * Môle: 367 "active" sale properties, of which 31 had been touched in the
 * last 30 days — the rest were single-source records (agency sites,
 * rightmove) last crawled in June or July and never re-checked. So "active"
 * accumulates, and the honest comparison with our own counts is "updated
 * within N days". Default 30; `--fresh=0` disables it.
 */
const FRESH_DAYS = Number(arg("fresh") ?? 30);
function baseQuery(insee: string, fresh = FRESH_DAYS): URLSearchParams {
  const q = new URLSearchParams();
  q.append("includedInseeCodes[]", insee);
  q.set("transactionType", "0"); // sale
  q.set("expired", "false");
  if (fresh > 0) q.set("fromUpdatedAt", new Date(Date.now() - fresh * 86_400_000).toISOString().slice(0, 10));
  return q;
}

const name = (insee: string) => GULF_OF_SAINT_TROPEZ.find((c) => c.insee === insee && !c.localityOf)?.label ?? insee;

async function counts(): Promise<Map<string, number>> {
  const ours = await db.execute<{ insee: string; n: number }>(sql`
    select commune_insee as insee, count(*)::int as n
    from portal_listings where status = 'active' and commune_insee is not null
    group by 1
  `);
  const oursBy = new Map(ours.rows.map((r) => [r.insee, r.n]));
  const oursProps = await db.execute<{ insee: string; n: number }>(sql`
    select commune_insee as insee, count(*)::int as n from properties where status = 'active' group by 1
  `);
  const propsBy = new Map(oursProps.rows.map((r) => [r.insee, r.n]));

  console.log(`\n── FOR-SALE properties: Stream.Estate "not expired" / updated ≤${FRESH_DAYS}d, vs ours (counts are free)`);
  console.log("   commune                 theirs   fresh   our props   our listings");
  const out = new Map<string, number>();
  let sumAll = 0;
  for (const insee of COLLECTION_INSEE) {
    const qa = baseQuery(insee, 0);
    qa.set("itemsPerPage", "0");
    const { total: all } = await call(qa, `count-all-${insee}`);
    const qf = baseQuery(insee);
    qf.set("itemsPerPage", "0");
    const { total: fresh } = FRESH_DAYS > 0 ? await call(qf, `count-fresh-${insee}`) : { total: all };
    out.set(insee, fresh);
    sumAll += all;
    console.log(
      `   ${name(insee).padEnd(22)} ${String(all).padStart(7)} ${String(fresh).padStart(7)}   ${String(propsBy.get(insee) ?? 0).padStart(9)}   ${String(oursBy.get(insee) ?? 0).padStart(12)}`,
    );
  }
  const sum = [...out.values()].reduce((a, b) => a + b, 0);
  console.log(`   ${"TOTAL".padEnd(22)} ${String(sumAll).padStart(7)} ${String(sum).padStart(7)}   ${String([...propsBy.values()].reduce((a, b) => a + b, 0)).padStart(9)}`);
  return out;
}

async function pull(insee: string, max: number): Promise<Property[]> {
  const got: Property[] = [];
  for (let page = 1; got.length < max; page++) {
    const q = baseQuery(insee);
    q.set("itemsPerPage", String(Math.min(PAGE, max - got.length)));
    q.set("page", String(page));
    q.set("order[createdAt]", "desc");
    const { items, total } = await call(q, `pull-${insee}-p${page}`);
    got.push(...items);
    if (items.length === 0 || got.length >= total) break;
  }
  return got;
}

const host = (u?: string) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : "(none)";
  } catch {
    return "(bad url)";
  }
};
const norm = (u: string) => u.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();

async function analyse(props: Property[]): Promise<void> {
  const adverts = props.flatMap((p) => p.adverts ?? []);
  console.log(`\n── ${props.length} properties, ${adverts.length} adverts`);

  // Which portals the adverts come from — the question their docs cannot answer.
  const bySite = new Map<string, number>();
  for (const a of adverts) bySite.set(host(a.url), (bySite.get(host(a.url)) ?? 0) + 1);
  console.log("\n   adverts by site (top 30):");
  for (const [h, n] of [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`   ${String(n).padStart(6)}  ${h}`);
  }
  const ourSites = ["green-acres.fr", "superimmo.com", "proprietes.lefigaro.fr", "luxuryestate.com", "jamesedition.com", "etreproprio.com", "maisonsetappartements.fr", "residences-immobilier.com"];
  console.log("\n   our portals present in their adverts:");
  for (const s of ourSites) {
    const n = [...bySite.entries()].filter(([h]) => h.endsWith(s)).reduce((a, [, v]) => a + v, 0);
    console.log(`   ${n > 0 ? "yes" : " NO"}  ${String(n).padStart(5)}  ${s}`);
  }

  // Do their Green-Acres / Superimmo / Figaro adverts match rows we already hold?
  const ours = await db.execute<{ url: string }>(sql`select url from portal_listings`);
  const known = new Set(ours.rows.map((r) => norm(r.url)));
  const overlap = adverts.filter((a) => a.url && ourSites.some((s) => host(a.url).endsWith(s)));
  const matched = overlap.filter((a) => known.has(norm(a.url!)));
  console.log(`\n   of their ${overlap.length} adverts on our portals, ${matched.length} are rows we already hold (URL match)`);

  // Their dedup, measured: properties in this sample sharing price AND surface
  // are almost certainly one home listed twice. La Môle showed 4 such pairs in 30.
  const key = (p: Property & { surface?: number | null }) => `${p.price ?? "?"}|${p.surface ?? "?"}`;
  const groups = new Map<string, number>();
  for (const p of props as (Property & { surface?: number | null })[]) groups.set(key(p), (groups.get(key(p)) ?? 0) + 1);
  const dupGroups = [...groups.values()].filter((n) => n > 1);
  const dupExtra = dupGroups.reduce((a, n) => a + n - 1, 0);
  console.log(`\n   likely unmerged duplicates: ${dupExtra} extra records in ${dupGroups.length} groups (same price + surface) — ${Math.round((100 * dupExtra) / Math.max(1, props.length))}% of the sample`);

  // Fields we depend on.
  const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);
  const withPics = props.filter((p) => (p.pictures?.length ?? 0) > 0).length;
  const withAgency = adverts.filter((a) => a.contact?.agency || a.publisher?.name).length;
  const withRef = adverts.filter((a) => a.contact?.reference).length;
  const withEvents = adverts.filter((a) => (a.events?.length ?? 0) > 0).length;
  const withPrice = props.filter((p) => typeof p.price === "number").length;
  const multi = props.filter((p) => (p.adverts?.length ?? 0) > 1).length;
  console.log("\n   fields:");
  console.log(`   price            ${pct(withPrice, props.length)} of properties`);
  console.log(`   pictures         ${pct(withPics, props.length)} of properties`);
  console.log(`   agency name      ${pct(withAgency, adverts.length)} of adverts`);
  console.log(`   agency reference ${pct(withRef, adverts.length)} of adverts`);
  console.log(`   price events     ${pct(withEvents, adverts.length)} of adverts`);
  console.log(`   >1 advert        ${pct(multi, props.length)} of properties (their dedup)`);

  const picHosts = new Map<string, number>();
  for (const p of props) for (const u of p.pictures ?? []) picHosts.set(host(u), (picHosts.get(host(u)) ?? 0) + 1);
  console.log(`   picture hosts    ${[...picHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h, n]) => `${h} ${n}`).join(", ")}`);

  // Currency sanity: in this market a sale under 30k EUR is almost always parking or an error.
  const prices = props.map((p) => p.price).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (prices.length > 0) {
    const med = prices[Math.floor(prices.length / 2)];
    console.log(`   price median     ${med.toLocaleString("fr-FR")} (min ${prices[0].toLocaleString("fr-FR")}, max ${prices[prices.length - 1].toLocaleString("fr-FR")})`);
  }
  console.log(`\n   raw responses saved in ${outDir}`);
}

/**
 * Which filter spelling do they honour? Added 2026-09-25 after the first count
 * run returned 66 070 "active" sale properties for the gulf against our 5 718,
 * with four communes at their 10 000 cap — Cogolin cannot have 10 000 homes
 * for sale. Counts only (itemsPerPage=0) for every variant, then ONE page of
 * 30 to read the flags on real records.
 */
async function diagnose(insee: string): Promise<void> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const variants: [string, Record<string, string>][] = [
    ["no filters", {}],
    ["transactionType=0", { transactionType: "0" }],
    ["+ expired=false", { transactionType: "0", expired: "false" }],
    ["+ expired=0", { transactionType: "0", expired: "0" }],
    ["+ fromUpdatedAt 30d", { transactionType: "0", fromUpdatedAt: since }],
    ["+ expired=false + fromUpdatedAt 30d", { transactionType: "0", expired: "false", fromUpdatedAt: since }],
    ["+ withCoherentPrice", { transactionType: "0", expired: "false", withCoherentPrice: "true" }],
  ];
  console.log(`\n── filter check on ${name(insee)} (${insee}), counts only`);
  for (const [label, params] of variants) {
    const q = new URLSearchParams();
    q.append("includedInseeCodes[]", insee);
    for (const [k, v] of Object.entries(params)) q.set(k, v);
    q.set("itemsPerPage", "0");
    const { total } = await call(q, `diag-${insee}-${label.replace(/[^a-z0-9]+/gi, "_")}`);
    console.log(`   ${String(total).padStart(7)}  ${label}`);
  }
  const q = baseQuery(insee);
  q.set("itemsPerPage", "30");
  q.set("order[createdAt]", "desc");
  const { items } = await call(q, `diag-${insee}-sample30`);
  console.log(`\n── ${items.length} records with the filters the pilot uses (transactionType=0, expired=false):`);
  console.log("   expired  created     lastCrawled  adverts  insee   price      type  host of first advert");
  for (const p of items as (Property & { lastCrawledAt?: string; transactionType?: number })[]) {
    console.log(
      `   ${String(p.expired).padEnd(7)}  ${(p.createdAt ?? "").slice(0, 10)}  ${(p.lastCrawledAt ?? "").slice(0, 10).padEnd(11)}  ` +
        `${String(p.adverts?.length ?? 0).padStart(7)}  ${String(p.city?.insee ?? "?").padEnd(6)}  ${String(p.price ?? "—").padStart(9)}  ` +
        `${String(p.propertyType ?? "?").padStart(4)}  ${host(p.adverts?.[0]?.url)}`,
    );
  }
}

async function main(): Promise<void> {
  apiKey();
  const diag = arg("diagnose");
  if (diag) {
    await diagnose(diag);
    return;
  }
  console.log(`\nStream.Estate pilot — ${new Date().toISOString().slice(0, 16)}  (read-only)`);
  const sample = arg("sample");
  const max = Number(arg("max") ?? 200);

  if (sample) {
    const props = await pull(sample, max);
    await analyse(props);
    return;
  }
  const byCommune = await counts();
  if (flag("full")) {
    const total = [...byCommune.values()].reduce((a, b) => a + b, 0);
    if (!flag("yes")) {
      console.log(`\n--full would pull ${total} properties (≈ EUR ${(total * 0.01).toFixed(0)} on pay-as-you-go). Add --yes to proceed.`);
      return;
    }
    const all: Property[] = [];
    for (const insee of COLLECTION_INSEE) all.push(...(await pull(insee, 10_000)));
    await analyse(all);
  } else {
    console.log(`\nNext: npm run pilot:stream -- --sample=83119 --max=150   (Saint-Tropez, fresh only, ≈ EUR 1.50)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[pilot:stream] failed:", (err as Error).message);
    process.exit(1);
  });
