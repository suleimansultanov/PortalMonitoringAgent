import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No module that anything imports may run itself.
 *
 * Every command-line script in this folder ends with a bare `void main()`, and
 * for a script that is only ever run directly that is fine. It stops being fine
 * the moment something imports the file for one exported helper: an import
 * executes the module, so `main()` starts alongside the importer's work and
 * `process.exit(0)` inside it ends the importer's process.
 *
 * That happened on 2026-09-06. `nightly.ts` imports `sweepImpossibleValues`
 * from `sanity.ts`; `sanity.ts` self-ran; the nightly pass announced its first
 * source and died two seconds later with **exit code zero**. GitHub Actions
 * marked the night green, six portals went untouched, and the only trace was
 * sanity's own sign-off printed in the middle of a collection log.
 *
 * A crash would have been obvious. A helper quietly exiting 0 inside somebody
 * else's process is a successful nothing — so this test exists to make the
 * combination impossible rather than merely unlikely.
 *
 * Fixing a hit: either guard the call —
 *
 *     if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 *       void main();
 *     }
 *
 * — or move the exported helper into a module of its own and leave the script
 * as a script. The second is better when the helper is doing real work.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");

function everyTsFile(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      everyTsFile(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** A `main()` call sitting at the top level, i.e. not inside a guard. */
const SELF_RUNS = /^(?:void\s+|await\s+)?main\(\);?\s*$/m;

test("nothing that another module imports runs itself on import", () => {
  const files = everyTsFile(SRC);
  const sources = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

  const offenders: string[] = [];

  for (const [file, text] of sources) {
    if (!SELF_RUNS.test(text)) continue;

    const stem = path.basename(file, ".ts");
    // `./sanity`, `../portals/sanity`, `@/lib/portals/sanity` — all end the
    // same way, and a specifier never ends with the extension in this codebase.
    const imported = new RegExp(`from\\s+"[^"]*[./]${stem}"`);

    const importers = [...sources.entries()]
      .filter(([other, otherText]) => other !== file && imported.test(otherText))
      .map(([other]) => path.relative(SRC, other));

    if (importers.length > 0) {
      offenders.push(
        `${path.relative(SRC, file)} runs itself and is imported by ${importers.join(", ")}`,
      );
    }
  }

  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
});
