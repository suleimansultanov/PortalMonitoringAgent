import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isUuid } from "./params";

test("a uuid is the hyphenated form we hand out, either case", () => {
  assert.equal(isUuid("3f0c1a52-9a4e-4d4b-8a43-5d0f6f2b9c11"), true);
  assert.equal(isUuid("3F0C1A52-9A4E-4D4B-8A43-5D0F6F2B9C11"), true);
});

test("anything else is not found, never a 500 from Postgres", () => {
  for (const bad of ["not-a-uuid", "x.png", "", "3f0c1a529a4e4d4b8a435d0f6f2b9c11", "{3f0c1a52-9a4e-4d4b-8a43-5d0f6f2b9c11}", "3f0c1a52-9a4e-4d4b-8a43-5d0f6f2b9c11; drop", undefined, 42]) {
    assert.equal(isUuid(bad), false, String(bad));
  }
});

/**
 * Every dynamic `[id]` segment checks its id before a query sees it — or, like
 * the report page, looks it up in a list the client already owns.
 */
test("every [id] route and page guards its id", () => {
  const app = fileURLToPath(new URL("../../app", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) return files(full);
      return /\[id\]/.test(full) && /^(page\.tsx|route\.ts)$/.test(e) ? [full] : [];
    });
  const found = files(app);
  assert.ok(found.length >= 3, `found ${found.length}`);
  for (const f of found) {
    const source = readFileSync(f, "utf8");
    const guarded =
      /isUuid\(/.test(source) || /clientReports\(/.test(source) || /propertyDetail\(/.test(source);
    assert.ok(guarded, `${path.relative(app, f)} passes its id to a query unchecked`);
  }
  // propertyDetail is where the listings page's id is checked.
  assert.match(read("./queries.ts"), /if \(!isUuid\(id\)\) return null;/);
});

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
