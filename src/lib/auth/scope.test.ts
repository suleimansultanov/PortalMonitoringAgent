import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { communesWithin, decideScope, type ScopeRow } from "./scope";

const linked: ScopeRow = {
  userId: "u1",
  userActive: true,
  clientId: "c1",
  clientSlug: "med-estates",
  clientName: "Med-Estates",
  clientActive: true,
  communeInsee: ["83119", "83115"],
};

test("a linked, active account reads its client's communes and subscribed sources", () => {
  const r = decideScope(linked, ["s1", "s2"]);
  assert.ok("scope" in r);
  assert.deepEqual(r.scope, {
    userId: "u1",
    clientId: "c1",
    clientSlug: "med-estates",
    clientName: "Med-Estates",
    communeInsee: ["83119", "83115"],
    sourceIds: ["s1", "s2"],
  });
});

test("an admin with no client is refused, not shown everything — production's only account on 2026-10-15", () => {
  const r = decideScope({ ...linked, clientId: null, clientSlug: null, clientName: null, clientActive: null, communeInsee: null }, []);
  assert.deepEqual(r, { refused: "no-client" });
});

test("a deactivated account stops at its next request, not when its cookie runs out", () => {
  assert.deepEqual(decideScope({ ...linked, userActive: false }, ["s1"]), { refused: "inactive-user" });
});

test("a deleted account with a live cookie reads nothing", () => {
  assert.deepEqual(decideScope(undefined, []), { refused: "unknown-user" });
});

test("an inactive client is refused, as its API keys are", () => {
  assert.deepEqual(decideScope({ ...linked, clientActive: false }, ["s1"]), { refused: "inactive-client" });
});

test("a client subscribed to nothing gets an empty scope, which the queries read as nothing", () => {
  const r = decideScope({ ...linked, communeInsee: null }, []);
  assert.ok("scope" in r);
  assert.deepEqual(r.scope.communeInsee, []);
  assert.deepEqual(r.scope.sourceIds, []);
});

test("a requested commune narrows the scope and never widens it", () => {
  assert.deepEqual(communesWithin(["83119", "83115"]), ["83119", "83115"]);
  assert.deepEqual(communesWithin(["83119", "83115"], []), ["83119", "83115"]);
  assert.deepEqual(communesWithin(["83119", "83115"], ["83115"]), ["83115"]);
  // A neighbour's commune is dropped, not refused: an error would confirm it exists.
  assert.deepEqual(communesWithin(["83119"], ["06088"]), []);
  assert.deepEqual(communesWithin([], ["83119"]), []);
});

// ─── Every screen and every internal route asks for the client ─────────────

const APP = fileURLToPath(new URL("../../app", import.meta.url));

function files(dir: string, name: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return files(full, name);
    return name.test(entry) ? [full] : [];
  });
}

test("every screen under /portal is scoped by requireClient()", () => {
  const pages = files(path.join(APP, "portal"), /^page\.tsx$/);
  assert.ok(pages.length >= 6, `found ${pages.length} pages`);
  for (const page of pages) {
    assert.match(readFileSync(page, "utf8"), /await requireClient\(\)/, `${path.relative(APP, page)} reads without a client`);
  }
});

test("every internal API route is scoped by clientForRequest(); /api/v1 has keys, /api/auth is next-auth", () => {
  const routes = files(path.join(APP, "api"), /^route\.ts$/).filter(
    (r) => !r.includes(`${path.sep}v1${path.sep}`) && !r.includes(`${path.sep}auth${path.sep}`),
  );
  assert.ok(routes.length >= 3, `found ${routes.length} routes`);
  for (const route of routes) {
    const source = readFileSync(route, "utf8");
    const handlers = source.match(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
    const scoped = source.match(/await clientForRequest\(\)/g) ?? [];
    assert.ok(handlers.length > 0, `${path.relative(APP, route)} exports no handler`);
    assert.equal(scoped.length, handlers.length, `${path.relative(APP, route)}: a handler reads without a client`);
  }
});
