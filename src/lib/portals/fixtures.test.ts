import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Saved pages carry the portals' own browser keys — Google Maps keys in the
 * URLs of their static map images. Public, theirs, and not ours to publish:
 * GitHub's secret scanning flagged Zoopla's on 2026-10-04. Redact before
 * committing a fixture (`REDACTED-PORTAL-MAPS-KEY`); this keeps it that way.
 */
const DIR = path.join(__dirname, "__fixtures__");
const KEY_SHAPES: [string, RegExp][] = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

test("no saved page carries a credential", () => {
  const found: string[] = [];
  for (const name of fs.readdirSync(DIR)) {
    const file = path.join(DIR, name);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const [label, re] of KEY_SHAPES) if (re.test(text)) found.push(`${name}: ${label}`);
  }
  assert.deepEqual(found, [], `redact before committing:\n  ${found.join("\n  ")}`);
});
