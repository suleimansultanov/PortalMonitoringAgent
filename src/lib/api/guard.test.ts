import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const V1 = fileURLToPath(new URL("../../app/api/v1", import.meta.url));

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routes(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/**
 * The key check cannot live in the middleware (the edge cannot read the keys
 * table), so it lives in each route — as `keyedRoute`, which also applies the
 * rate limit and writes the journal. A route that exports a plain handler
 * skips all three, and the first sign would be someone else's market in a
 * response; this fails first.
 */
test("every /api/v1 handler goes through keyedRoute: key, rate limit, journal", () => {
  const files = routes(V1);
  assert.ok(files.length >= 4, `found ${files.length} v1 routes`);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const name = path.relative(V1, file);
    assert.doesNotMatch(source, /export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/, `${name} exports a bare handler`);
    assert.doesNotMatch(source, /export\s+const\s+\{/, `${name} re-exports handlers unwrapped`);
    const exported = source.match(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g) ?? [];
    const wrapped = source.match(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*keyedRoute\(/g) ?? [];
    assert.ok(exported.length > 0, `${name} exports no handler`);
    assert.equal(wrapped.length, exported.length, `${name}: a handler is not wrapped in keyedRoute`);
  }
});
