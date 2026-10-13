import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BillingFault, BudgetError, canonical, createV1Client, readLedger, V1_PLAN_ITEMS } from "./streamV1";

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

test("a count request is free: nothing is added, and the answer is the total", async () => {
  const dir = tmp();
  const { fetchImpl, asked } = fake(() => ({ body: page(0, 4321) }));
  const c = createV1Client({ dir, apiKey: () => "k", fetchImpl });
  const r = await c.call(q({ itemsPerPage: "0", transactionType: "0" }));
  assert.equal(r.total, 4321);
  assert.equal(r.spent, 0);
  assert.equal(c.ledger().items, 0);
  assert.equal(asked.length, 1);
});

test("a count request that comes back with items stops everything", async () => {
  const dir = tmp();
  const { fetchImpl } = fake(() => ({ body: page(10) }));
  const c = createV1Client({ dir, apiKey: () => "k", fetchImpl });
  await assert.rejects(c.call(q({ itemsPerPage: "0" })), BillingFault);
  // Counted, so the next run starts from the truth.
  assert.equal(readLedger(dir).items, 10);
});

test("a paid page is counted by what came back, and written to disk", async () => {
  const dir = tmp();
  const { fetchImpl } = fake(() => ({ body: page(30) }));
  const c = createV1Client({ dir, apiKey: () => "k", fetchImpl });
  const r = await c.call(q({ itemsPerPage: "30", page: "1" }));
  assert.equal(r.spent, 30);
  assert.equal(readLedger(dir).items, 30);
  assert.equal(c.remaining(), c.cap - 30);
});

test("the same question asked twice is answered from disk: no request, no charge", async () => {
  const dir = tmp();
  const { fetchImpl, asked } = fake(() => ({ body: page(30) }));
  const c = createV1Client({ dir, apiKey: () => "k", fetchImpl });
  await c.call(q({ itemsPerPage: "30", page: "1", transactionType: "0" }));
  // Same parameters in another order, and from a fresh client — a re-run.
  const again = createV1Client({ dir, apiKey: () => "k", fetchImpl });
  const r = await again.call(q({ transactionType: "0", page: "1", itemsPerPage: "30" }));
  assert.equal(r.fromCache, true);
  assert.equal(r.spent, 0);
  assert.equal(asked.length, 1);
  assert.equal(readLedger(dir).items, 30);
});

test("a page that would pass the cap is refused before it is sent", async () => {
  const dir = tmp();
  const { fetchImpl, asked } = fake(() => ({ body: page(30) }));
  const c = createV1Client({ dir, apiKey: () => "k", fetchImpl, cap: 50 });
  await c.call(q({ itemsPerPage: "30", page: "1" }));
  await assert.rejects(c.call(q({ itemsPerPage: "30", page: "2" })), BudgetError);
  assert.equal(asked.length, 1, "the second request never left");
  assert.equal(readLedger(dir).items, 30);
});

test("the cap holds across runs: a second process starts from what the first spent", async () => {
  const dir = tmp();
  const a = fake(() => ({ body: page(30) }));
  await createV1Client({ dir, apiKey: () => "k", fetchImpl: a.fetchImpl, cap: 40 }).call(q({ itemsPerPage: "30", page: "1" }));
  const b = fake(() => ({ body: page(30) }));
  const second = createV1Client({ dir, apiKey: () => "k", fetchImpl: b.fetchImpl, cap: 40 });
  await assert.rejects(second.call(q({ itemsPerPage: "30", page: "2" })), BudgetError);
  assert.equal(b.asked.length, 0);
});

test("a cap above the plan needs to be said out loud", () => {
  assert.throws(() => createV1Client({ dir: tmp(), apiKey: () => "k", cap: V1_PLAN_ITEMS + 1 }), BudgetError);
  assert.doesNotThrow(() => createV1Client({ dir: tmp(), apiKey: () => "k", cap: V1_PLAN_ITEMS + 1, allowOverage: true }));
});

test("the default cap leaves a reserve under the plan", () => {
  const c = createV1Client({ dir: tmp(), apiKey: () => "k" });
  assert.ok(c.cap < V1_PLAN_ITEMS, `${c.cap} < ${V1_PLAN_ITEMS}`);
});

test("a paid request that fails in transit is counted at the worst case and not retried", async () => {
  const dir = tmp();
  const { fetchImpl, asked } = fake(() => new Error("socket hang up"));
  const c = createV1Client({ dir, apiKey: () => "k", fetchImpl });
  await assert.rejects(c.call(q({ itemsPerPage: "30", page: "1" })), BillingFault);
  assert.equal(asked.length, 1);
  const l = readLedger(dir);
  assert.equal(l.items, 30);
  assert.equal(l.uncertain, 30);
});

test("a refused request costs nothing and is not retried", async () => {
  const dir = tmp();
  const { fetchImpl, asked } = fake(() => ({ status: 402, body: '{"message":"Insufficient credits"}' }));
  const c = createV1Client({ dir, apiKey: () => "k", fetchImpl });
  await assert.rejects(c.call(q({ itemsPerPage: "30", page: "1" })), /HTTP 402/);
  assert.equal(asked.length, 1);
  assert.equal(readLedger(dir).items, 0);
});

test("a request that does not say how many items it wants is never sent", async () => {
  const { fetchImpl, asked } = fake(() => ({ body: page(10) }));
  const c = createV1Client({ dir: tmp(), apiKey: () => "k", fetchImpl });
  // Their default is ten items: an unmetered request is ten items nobody asked for.
  await assert.rejects(c.call(q({ transactionType: "0" })), BudgetError);
  await assert.rejects(c.call(q({ itemsPerPage: "31" })), BudgetError);
  assert.equal(asked.length, 0);
});

test("the key is sent as a header and never written to the ledger", async () => {
  const dir = tmp();
  const { fetchImpl } = fake(() => ({ body: page(1) }));
  await createV1Client({ dir, apiKey: () => "SECRET-KEY", fetchImpl }).call(q({ itemsPerPage: "1" }));
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isFile()) assert.equal(fs.readFileSync(full, "utf8").includes("SECRET-KEY"), false, f);
  }
  assert.equal(canonical(q({ b: "2", a: "1" })), "a=1&b=2");
});
