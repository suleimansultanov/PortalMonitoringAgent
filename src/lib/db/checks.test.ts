import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * The CHECK constraints of drizzle/0011 are only as good as their lists. A
 * value added in code — a new event type, a new run status — and not in the
 * migration would make the nightly's first write of it fail, after the
 * migration had run cleanly. These tests fail first, at the commit.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const literals = (text: string, quote: "'" | '"') =>
  [...text.matchAll(quote === "'" ? /'([^']*)'/g : /"([^"]*)"/g)].map((m) => m[1]).sort();

const MIGRATION = read("../../../drizzle/0011_status_checks.sql");

/** The values a constraint in 0011 allows. */
function migrationAllows(name: string): string[] {
  const m = new RegExp(`ADD CONSTRAINT "${name}"\\s+CHECK \\(([^;]*)\\);`).exec(MIGRATION);
  assert.ok(m, `0011 has no constraint ${name}`);
  return literals(m[1], "'");
}

/** The string literals of the first match of `pattern` in a source file. */
function codeUnion(rel: string, pattern: RegExp): string[] {
  const m = pattern.exec(read(rel));
  assert.ok(m, `${rel}: ${pattern} not found`);
  return literals(m[1], '"');
}

test("every CHECK in schema.ts is the one 0011 creates, value for value", () => {
  const dialect = new PgDialect();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v,
  );
  const inSchema = new Map<string, string[]>();
  for (const table of tables) {
    for (const c of getTableConfig(table).checks) {
      inSchema.set(c.name, literals(dialect.sqlToQuery(c.value).sql, "'"));
    }
  }
  const inMigration = [...MIGRATION.matchAll(/ADD CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...inSchema.keys()].sort(), inMigration);
  for (const name of inMigration) assert.deepEqual(inSchema.get(name), migrationAllows(name), name);
});

test("event types: what the runner can write is what the CHECK allows", () => {
  assert.deepEqual(
    migrationAllows("portal_listing_events_type_check"),
    codeUnion("../portals/runner/events.ts", /type: ("listed"[^;]*);/),
  );
});

test("run modes and statuses: what run.ts can write", () => {
  assert.deepEqual(
    migrationAllows("portal_runs_mode_check"),
    codeUnion("../portals/runner/run.ts", /mode\?: ("[^;]*);/),
  );
  // RunSummary's statuses, less 'disabled' (returned, never written), plus
  // 'running' (the row's state while the pass is under way).
  const summary = codeUnion("../portals/runner/run.ts", /status: ("done"[^;]*);/);
  assert.ok(summary.includes("disabled"));
  assert.deepEqual(
    migrationAllows("portal_runs_status_check"),
    [...summary.filter((s) => s !== "disabled"), "running"].sort(),
  );
});

test("roles, discovery modes, ledger kinds and match statuses: each from its own source", () => {
  assert.deepEqual(migrationAllows("users_role_check"), codeUnion("../auth/users.ts", /export type Role = ([^;]*);/));
  assert.deepEqual(
    migrationAllows("portal_sources_discovery_mode_check"),
    codeUnion("../portals/types.ts", /discoveryMode: ("[^;]*);/),
  );
  assert.deepEqual(
    migrationAllows("api_usage_kind_check"),
    codeUnion("../portals/streamV1.ts", /export type LedgerKind = ([^;]*);/),
  );
  assert.deepEqual(
    migrationAllows("buyer_matches_status_check"),
    codeUnion("../../app/api/matches/route.ts", /status: z\.enum\(\[([^\]]*)\]\)/),
  );
});

test("each constraint is added only when pg_constraint does not have it — 0011 can run twice", () => {
  const added = [...MIGRATION.matchAll(/ADD CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
  const guarded = [...MIGRATION.matchAll(/WHERE conname = '([a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(added.length, 12);
  assert.deepEqual(guarded, added);
});
