import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { fromSources, inCommunes, ownMatches } from "./queries";

/** The SQL a predicate becomes, without a database. */
const render = (q: SQL) => new PgDialect().sqlToQuery(q);

const scope = { clientId: "11111111-1111-4111-8111-111111111111", communeInsee: ["83119"], sourceIds: ["s1"] };

test("a match is this client's when its buyer is", () => {
  const q = render(ownMatches(scope));
  assert.equal(q.sql, `"buyers"."client_id" = $1`);
  assert.deepEqual(q.params, [scope.clientId]);
});

test("no communes is no market — never a missing filter", () => {
  assert.equal(render(inCommunes([])).sql, "false");
  const q = render(inCommunes(["83119", "83115"]));
  assert.equal(q.sql, `"properties"."commune_insee" in ($1, $2)`);
  assert.deepEqual(q.params, ["83119", "83115"]);
});

test("no subscribed source is no listing — never every source", () => {
  assert.equal(render(fromSources([])).sql, "false");
  assert.equal(render(fromSources(["s1"])).sql, `"portal_listings"."source_id" in ($1)`);
});

test("every read in queries.ts takes the scope first, so forgetting it is a type error", () => {
  const source = readFileSync(fileURLToPath(new URL("./queries.ts", import.meta.url)), "utf8");
  const reads = [...source.matchAll(/export async function (\w+)\(\s*([^)]*)\)/g)];
  assert.ok(reads.length >= 10, `found ${reads.length} reads`);
  // The one global read: when the hosted database was last synced. Not client data.
  const unscoped = new Set(["lastSyncAt"]);
  for (const [, name, params] of reads) {
    if (unscoped.has(name)) continue;
    assert.match(params.trim(), /^scope: MarketScope\b/, `${name} reads without a scope`);
  }
});
