import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * The backup has to know about every table, and nothing reminds it to.
 *
 * `scripts/dump-data.sh` is the only backup this project has: the Supabase
 * Free plan takes none, and since 2026-08-29 the database it dumps is the one
 * the client reads. Its table list is written by hand, and a table added to
 * the schema is in no backup until someone remembers the script.
 *
 * Three tables were forgotten that way, found by the review of 2026-10-15:
 * `client_api_keys`, `api_usage` and `source_commune_state`. A restore from
 * that dump would have locked the client's application out, reset the paid
 * Stream.Estate V1 meter to zero (so its spending cap protected nothing), and
 * bought the whole stock again, commune by commune.
 *
 * So the list is compared with `schema.ts`. A new table fails here until it
 * is either added to the script, after everything it references, or named
 * below with the reason it is left out.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "../../../scripts/dump-data.sh");

/**
 * Tables deliberately left out of the backup: table name → why.
 *
 * Empty on 2026-10-15, because every table holds something a restore would
 * miss. A reason here is a decision somebody made, so write it as one, e.g.
 * `some_cache: "derived from portal_listings every night; rebuilt, never restored"`.
 */
const NOT_BACKED_UP: Record<string, string> = {};

/** The `TABLES=( … )` array in the script, in order, comments removed. */
function tablesInScript(): string[] {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const block = text.match(/^TABLES=\(\n([\s\S]*?)^\)/m);
  assert.ok(block, `no TABLES=( … ) block found in ${path.relative(process.cwd(), SCRIPT)}`);
  return block[1]
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

const tables = Object.values(schema).filter((v): v is PgTable => is(v, PgTable));
const inSchema = new Set(tables.map((t) => getTableConfig(t).name));

test("the backup script's table list parses to plain table names, once each", () => {
  const listed = tablesInScript();
  // A stray character turns a name into a pattern that matches nothing, and
  // pg_dump only says so on the day the backup is needed.
  const malformed = listed.filter((name) => !/^[a-z_][a-z0-9_]*$/.test(name));
  assert.deepEqual(malformed, [], `entries that are not a single table name: ${malformed.join(", ")}`);
  const repeated = listed.filter((name, i) => listed.indexOf(name) !== i);
  assert.deepEqual(repeated, [], `listed twice: ${repeated.join(", ")}`);
});

test("every table in the schema is backed up, or left out with a reason", () => {
  const listed = new Set(tablesInScript());
  const forgotten = [...inSchema].filter((name) => !listed.has(name) && !(name in NOT_BACKED_UP));
  assert.deepEqual(
    forgotten,
    [],
    `\n  Not in scripts/dump-data.sh: ${forgotten.join(", ")}.` +
      `\n  Add each after the tables it references, or to NOT_BACKED_UP in this file with the reason.\n`,
  );
});

test("the backup names no table the schema does not define", () => {
  // A typo here is a pg_dump error ("no matching tables were found") that
  // stops the whole dump, under `set -e`, at the moment someone needs it.
  const unknown = tablesInScript().filter((name) => !inSchema.has(name));
  assert.deepEqual(unknown, [], `in scripts/dump-data.sh but not in schema.ts: ${unknown.join(", ")}`);
});

test("the exclusion list is not stale: real tables, not also backed up, each with a reason", () => {
  const listed = new Set(tablesInScript());
  for (const [name, reason] of Object.entries(NOT_BACKED_UP)) {
    assert.ok(inSchema.has(name), `NOT_BACKED_UP names "${name}", which schema.ts does not define`);
    assert.ok(!listed.has(name), `"${name}" is both backed up and in NOT_BACKED_UP; remove one`);
    assert.ok(reason.trim().length > 0, `"${name}" is in NOT_BACKED_UP without a reason`);
  }
});

test("each table is dumped after every table it references", () => {
  // A data-only dump has no deferred constraints, so a row loaded before its
  // parent is refused on the spot (the comment at the top of the script).
  const order = tablesInScript();
  const position = new Map(order.map((name, i) => [name, i]));
  const tooEarly: string[] = [];
  for (const table of tables) {
    const { name, foreignKeys } = getTableConfig(table);
    const at = position.get(name);
    if (at === undefined) continue;
    for (const fk of foreignKeys) {
      const parent = getTableConfig(fk.reference().foreignTable).name;
      if (parent === name) continue;
      const parentAt = position.get(parent);
      if (parentAt !== undefined && parentAt > at) tooEarly.push(`${name} before ${parent}`);
    }
  }
  assert.deepEqual(tooEarly, [], `out of foreign-key order: ${tooEarly.join(", ")}`);
});
