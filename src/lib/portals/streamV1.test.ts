import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BillingFault,
  BudgetError,
  canonical,
  createV1Client,
  diskLedgerStore,
  periodStart,
  sumEntries,
  V1_PLAN_ITEMS,
  withDiskCache,
  type LedgerEntry,
  type LedgerStore,
} from "./streamV1";

/**
 * The meter in front of a per-item API on someone else's card. Each test is a
 * way the month's 15 000 items could be spent without anyone deciding to.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "se-v1-"));
const page = (n: number, total = 1000) =>
  JSON.stringify({ "hydra:totalItems": total, "hydra:member": Array.from({ length: n }, (_, i) => ({ uuid: `p${i}` })) });

function fake(answer: (url: string) => { status?: number; body: string } | Error) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(String(url));
    const a = answer(String(url));
    if (a instanceof Error) throw a;
    return new Response(a.body, { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

const q = (params: Record<string, string>) => new URLSearchParams(params);
const client = (dir: string, fetchImpl: typeof fetch, extra: { cap?: number; allowOverage?: boolean } = {}) =>
  createV1Client({ store: diskLedgerStore(dir), apiKey: () => "k", fetchImpl, ...extra });

test("the period starts on the plan's renewal day: the 14th, this month or last", () => {
  assert.equal(periodStart(new Date("2026-10-14T00:00:00Z")).toISOString(), "2026-10-14T00:00:00.000Z");
  assert.equal(periodStart(new Date("2026-11-13T23:59:59Z")).toISOString(), "2026-10-14T00:00:00.000Z");
  assert.equal(periodStart(new Date("2026-11-14T00:00:00Z")).toISOString(), "2026-11-14T00:00:00.000Z");
  assert.equal(periodStart(new Date("2027-01-02T12:00:00Z")).toISOString(), "2026-12-14T00:00:00.000Z");
});

test("a count request is free: nothing is added, and the answer is the total", async () => {
  const { fetchImpl, asked } = fake(() => ({ body: page(0, 4321) }));
  const c = client(tmp(), fetchImpl);
  const r = await c.call(q({ itemsPerPage: "0", transactionType: "0" }));
  assert.equal(r.total, 4321);
  assert.equal(r.spent, 0);
  assert.equal((await c.totals()).items, 0);
  assert.equal((await c.totals()).freeRequests, 1);
  assert.equal(asked.length, 1);
});

test("a count request that comes back with items stops everything", async () => {
  const dir = tmp();
  const { fetchImpl } = fake(() => ({ body: page(10) }));
  const c = client(dir, fetchImpl);
  await assert.rejects(c.call(q({ itemsPerPage: "0" })), BillingFault);
  // Counted, so the next run starts from the truth.
  assert.equal((await c.totals()).items, 10);
});

test("a paid page is counted by what came back, and kept on disk", async () => {
  const dir = tmp();
  const { fetchImpl } = fake(() => ({ body: page(30) }));
  const c = client(dir, fetchImpl);
  const r = await c.call(q({ itemsPerPage: "30", page: "1" }));
  assert.equal(r.spent, 30);
  assert.equal((await c.totals()).items, 30);
  assert.equal(await c.remaining(), c.cap - 30);
  assert.equal(fs.readdirSync(path.join(dir, "responses")).length, 1);
});

test("the same question asked twice is answered from disk: no request, no charge", async () => {
  const dir = tmp();
  const { fetchImpl, asked } = fake(() => ({ body: page(30) }));
  await client(dir, fetchImpl).call(q({ itemsPerPage: "30", page: "1", transactionType: "0" }));
  // Same parameters in another order, and from a fresh client — a re-run.
  const r = await client(dir, fetchImpl).call(q({ transactionType: "0", page: "1", itemsPerPage: "30" }));
  assert.equal(r.fromCache, true);
  assert.equal(r.spent, 0);
  assert.equal(asked.length, 1);
  assert.equal((await client(dir, fetchImpl).totals()).items, 30);
});

test("a page that would pass the cap is refused before it is sent", async () => {
  const dir = tmp();
  const { fetchImpl, asked } = fake(() => ({ body: page(30) }));
  const c = client(dir, fetchImpl, { cap: 50 });
  await c.call(q({ itemsPerPage: "30", page: "1" }));
  await assert.rejects(c.call(q({ itemsPerPage: "30", page: "2" })), BudgetError);
  assert.equal(asked.length, 1, "the second request never left");
  assert.equal((await c.totals()).items, 30);
});

test("the cap holds across processes: a second one starts from what the first spent", async () => {
  const dir = tmp();
  const a = fake(() => ({ body: page(30) }));
  await client(dir, a.fetchImpl, { cap: 40 }).call(q({ itemsPerPage: "30", page: "1" }));
  const b = fake(() => ({ body: page(30) }));
  await assert.rejects(client(dir, b.fetchImpl, { cap: 40 }).call(q({ itemsPerPage: "30", page: "2" })), BudgetError);
  assert.equal(b.asked.length, 0);
});

test("spending in a previous period does not count against this one", async () => {
  const dir = tmp();
  const store = diskLedgerStore(dir);
  const old: LedgerEntry = { at: new Date("2026-09-20T00:00:00Z"), kind: "legacy", query: "x", items: 14_000 };
  await store.append(old);
  const { fetchImpl } = fake(() => ({ body: page(30) }));
  const c = createV1Client({ store, apiKey: () => "k", fetchImpl, now: () => new Date("2026-10-20T00:00:00Z") });
  assert.equal((await c.totals()).items, 0);
  await c.call(q({ itemsPerPage: "30", page: "1" }));
  assert.equal((await c.totals()).items, 30);
});

test("a cap above the plan needs to be said out loud", () => {
  const s = diskLedgerStore(tmp());
  assert.throws(() => createV1Client({ store: s, apiKey: () => "k", cap: V1_PLAN_ITEMS + 1 }), BudgetError);
  assert.doesNotThrow(() => createV1Client({ store: s, apiKey: () => "k", cap: V1_PLAN_ITEMS + 1, allowOverage: true }));
});

test("the default cap leaves a reserve under the plan", () => {
  const c = createV1Client({ store: diskLedgerStore(tmp()), apiKey: () => "k" });
  assert.ok(c.cap < V1_PLAN_ITEMS, `${c.cap} < ${V1_PLAN_ITEMS}`);
});

test("a paid request that fails in transit is counted at the worst case and not retried", async () => {
  const dir = tmp();
  const { fetchImpl, asked } = fake(() => new Error("socket hang up"));
  const c = client(dir, fetchImpl);
  await assert.rejects(c.call(q({ itemsPerPage: "30", page: "1" })), BillingFault);
  assert.equal(asked.length, 1);
  const t = await c.totals();
  assert.equal(t.items, 30);
  assert.equal(t.uncertain, 30);
});

test("a refused request costs nothing and is not retried", async () => {
  const { fetchImpl, asked } = fake(() => ({ status: 402, body: '{"message":"Insufficient credits"}' }));
  const c = client(tmp(), fetchImpl);
  await assert.rejects(c.call(q({ itemsPerPage: "30", page: "1" })), /HTTP 402/);
  assert.equal(asked.length, 1);
  assert.equal((await c.totals()).items, 0);
});

test("a request that does not say how many items it wants is never sent", async () => {
  const { fetchImpl, asked } = fake(() => ({ body: page(10) }));
  const c = client(tmp(), fetchImpl);
  // Their default is ten items: an unmetered request is ten items nobody asked for.
  await assert.rejects(c.call(q({ transactionType: "0" })), BudgetError);
  await assert.rejects(c.call(q({ itemsPerPage: "31" })), BudgetError);
  assert.equal(asked.length, 0);
});

test("the key is sent as a header and never written to the ledger", async () => {
  const dir = tmp();
  const { fetchImpl } = fake(() => ({ body: page(1) }));
  await createV1Client({ store: diskLedgerStore(dir), apiKey: () => "SECRET-KEY", fetchImpl }).call(q({ itemsPerPage: "1" }));
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isFile()) assert.equal(fs.readFileSync(full, "utf8").includes("SECRET-KEY"), false, f);
  }
  assert.equal(canonical(q({ b: "2", a: "1" })), "a=1&b=2");
});

test("a store without a cache asks again, and a cache wrapped around it answers from disk", async () => {
  const dir = tmp();
  const entries: LedgerEntry[] = [];
  const bare: LedgerStore = {
    async totals(since) {
      return sumEntries(entries.filter((e) => e.at >= since));
    },
    async append(e) {
      entries.push(e);
    },
  };
  const { fetchImpl, asked } = fake(() => ({ body: page(5) }));
  const first = createV1Client({ store: bare, apiKey: () => "k", fetchImpl });
  await first.call(q({ itemsPerPage: "5", page: "1" }));
  await first.call(q({ itemsPerPage: "5", page: "1" }));
  assert.equal(asked.length, 2, "no cache: asked twice, paid twice");
  assert.equal((await first.totals()).items, 10);

  const cached = createV1Client({ store: withDiskCache(bare, dir), apiKey: () => "k", fetchImpl });
  await cached.call(q({ itemsPerPage: "5", page: "2" }));
  const again = await cached.call(q({ itemsPerPage: "5", page: "2" }));
  assert.equal(again.fromCache, true);
  assert.equal(asked.length, 3);
  assert.equal((await cached.totals()).items, 15, "the ledger is still the bare store's");
});

test("an older ledger.json is converted once, and its paid items keep counting", async () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ledger.json"),
    JSON.stringify({
      since: "2026-10-13T22:17:00.000Z",
      items: 27,
      log: [
        { at: "2026-10-13T22:20:00.000Z", query: "includedInseeCodes[]=83079&itemsPerPage=0", items: 0 },
        { at: "2026-10-14T01:00:00.000Z", query: "includedInseeCodes[]=83079&itemsPerPage=30&page=1", items: 27 },
      ],
    }),
  );
  const store = diskLedgerStore(dir);
  const t = await store.totals(new Date("2026-10-14T00:00:00Z"));
  assert.equal(t.items, 27);
  assert.equal(t.paidRequests, 1);
  assert.equal(t.freeRequests, 0, "the count request was in the previous period");
  assert.ok(fs.existsSync(path.join(dir, "ledger.jsonl")));
  assert.ok(fs.existsSync(path.join(dir, "ledger-legacy.json")));
  assert.ok(!fs.existsSync(path.join(dir, "ledger.json")));
});

test("a cap that is not a whole positive number is refused outright — NaN passes every comparison", () => {
  const s = diskLedgerStore(tmp());
  for (const cap of [Number("14,000"), Number("15 000"), 0, -1, 1.5, Infinity]) {
    assert.throws(() => createV1Client({ store: s, apiKey: () => "k", cap }), BudgetError, String(cap));
  }
  assert.throws(() => createV1Client({ store: s, apiKey: () => "k", anchorDay: 31 }), BudgetError);
});

test("a page is reserved before it is sent: a second process cannot slip past the cap while the first is in flight", async () => {
  const dir = tmp();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = (async () => {
    await gate;
    return new Response(page(30));
  }) as unknown as typeof fetch;
  const a = createV1Client({ store: diskLedgerStore(dir), apiKey: () => "k", fetchImpl: slow, cap: 40 });
  const inFlight = a.call(q({ itemsPerPage: "30", page: "1" }));
  await new Promise((r) => setTimeout(r, 20));
  // A's page is reserved though no answer has come back yet.
  assert.equal((await diskLedgerStore(dir).totals(new Date(0))).uncertain, 30);
  const { fetchImpl, asked } = fake(() => ({ body: page(30) }));
  const b = createV1Client({ store: diskLedgerStore(dir), apiKey: () => "k", fetchImpl, cap: 40 });
  await assert.rejects(b.call(q({ itemsPerPage: "30", page: "2" })), BudgetError);
  assert.equal(asked.length, 0);
  release();
  const r = await inFlight;
  assert.equal(r.spent, 30);
  const t = await a.totals();
  assert.equal(t.items, 30);
  assert.equal(t.uncertain, 0, "settled");
});

test("a refused page releases its reservation; a page that came back short settles to what came back", async () => {
  const dir = tmp();
  const refused = fake(() => ({ status: 402, body: "{}" }));
  await assert.rejects(client(dir, refused.fetchImpl).call(q({ itemsPerPage: "30", page: "1" })), /HTTP 402/);
  const short = fake(() => ({ body: page(7) }));
  const r = await client(dir, short.fetchImpl).call(q({ itemsPerPage: "30", page: "2" }));
  assert.equal(r.spent, 7);
  const t = await client(dir, short.fetchImpl).totals();
  assert.equal(t.items, 7);
  assert.equal(t.uncertain, 0);
  assert.equal(t.paidRequests, 2);
});

test("an answer without hydra:totalItems is a fault, not an empty market", async () => {
  const { fetchImpl } = fake(() => ({ body: JSON.stringify({ "hydra:member": [{ uuid: "p0" }] }) }));
  const c = client(tmp(), fetchImpl);
  await assert.rejects(c.call(q({ itemsPerPage: "30", page: "1" })), BillingFault);
  // The reservation stands: the page may have been billed.
  assert.equal((await c.totals()).uncertain, 30);
});
